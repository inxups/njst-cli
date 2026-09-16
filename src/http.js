/**
 * HTTP 层：极简 cookie jar + 统一限速 + 错误翻译。
 *
 * 设计约束（plan §1.3）：
 *   - 每个服务单独配 scheme，不全局统一：CAS 用 https，ehall / portal 用 http
 *   - 同 host ≤ 1 req/s（官方对 WeCMP 接口的限流也是 1 qps）
 *   - 非 TTY 需要交互输入时立即报错，不阻塞
 */

import { wrapFetchError, detectGatewayPage, serviceError, inputError } from './errors.js';

export const HOSTS = {
  cas: 'https://auth.njts.edu.cn',
  /**
   * WebVPN 门户（深信服 SSL VPN）。**这才是真正的登录入口**：
   *   https://webvpn.njts.edu.cn/portal/#!/login
   * `vpn.njts.edu.cn` 是另一个门户，见 src/vpn.js 里的说明。
   * 公网 DNS 无 A 记录，真实 IP 222.192.176.8（用户实测）。
   */
  webvpn: 'https://webvpn.njts.edu.cn',
  /** 旧门户/隧道校验端点，保留给 auth/cas_validate 那条 CAS 链用 */
  vpn: 'https://vpn.njts.edu.cn',
  portal: 'http://portal.njts.edu.cn',
  ehall: 'http://ehall.njts.edu.cn',
  jwxt: 'http://jwxt.njts.edu.cn',
  card: 'http://aggrepay.njts.edu.cn:8080',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------------------------------------------------------------- WebVPN 路由

/**
 * WebVPN 网关的地址改写规则（反向代理模式，见 vpn.js 的详细说明）：
 *
 *   jwxt.njts.edu.cn  →  jwxt-njts-edu-cn-s.webvpn.njts.edu.cn:8118
 *                        └─ 点换横线，再追加 -s；端口固定 8118
 *
 * 放在 http.js 而不是 vpn.js，是为了**避开循环 import**：vpn.js 要用 request()，
 * 所以路由决策只能由 http.js 拿，而会话对象由调用方（cli.js）在启动时注入。
 */
export const VPN_GATE = { suffix: 'webvpn.njts.edu.cn', port: '8118' };

export function gateHost(host) {
  return `${String(host).replace(/\./g, '-')}-s.${VPN_GATE.suffix}`;
}

export function gateUrl(target) {
  const u = new URL(target);
  return `http://${gateHost(u.hostname)}:${VPN_GATE.port}${u.pathname}${u.search}`;
}

/**
 * **哪些主机需要经 VPN**。这个清单是实测出来的，不是猜的：
 *   - jwxt / portal / ehall：公网要么 403，要么被限到只能看到「账号可能存在异常」
 *   - auth（CAS）：公网直达，**不进 VPN**（而且进 VPN 反而会断掉 CAS 会话链）
 *   - card（一卡通）：公网直达，**不进 VPN**
 * 不在清单里的 host 默认直连；`--via-vpn` 可以强制。
 */
export const VPN_ROUTE_HOSTS = new Set(['jwxt.njts.edu.cn', 'portal.njts.edu.cn', 'ehall.njts.edu.cn']);

let vpnSession = null;

/** 由 cli.js 在启动时注入（没登录就是 null） */
export function setVpnSession(session) {
  vpnSession = session;
}

export function getVpnSession() {
  return vpnSession;
}

/**
 * 给一个 URL 算出实际要请求的地址。
 * @param {string} url
 * @param {'auto'|'direct'|'vpn'} [via]
 */
export function resolveRoute(url, via = 'auto') {
  if (via === 'direct') return { url, viaVpn: false, rewritten: false };
  const host = new URL(url).hostname;
  // 已经是网关地址：不用改写。**也别抢走调用方的 jar** —— 网关里的 CAS 登录页
  // 用的是它自己的 cookie，与 VPN 会话的 jar 不同。
  if (host.endsWith(`.${VPN_GATE.suffix}`)) return { url, viaVpn: true, rewritten: false };

  const wanted = via === 'vpn' || (via === 'auto' && VPN_ROUTE_HOSTS.has(host));
  if (!wanted) return { url, viaVpn: false, rewritten: false };

  // `auto` 是**尽力而为**：有 VPN 会话就走网关，没有就直连（让服务端自己说话）。
  // 早先这里在没会话时直接抛错，结果把 cas.visit() 这类“只是跟个跳转、
  // 根本不需要 VPN”的调用一起搞坏了——登录流程会在末尾莫名失败。
  // 硬报错只留给显式要求 `via: 'vpn'` 的调用。
  if (!vpnSession?.authenticated) {
    if (via === 'vpn') throw requireVpnError(url);
    return { url, viaVpn: false, rewritten: false };
  }
  return { url: gateUrl(url), viaVpn: true, rewritten: true };
}

function requireVpnError(url) {
  const e = inputError(
    `${new URL(url).hostname} 需要校内网络`, 
    '它校外不可直连。请先执行 njts vpn login 建立 WebVPN 会话；若你想坚持直连，加 --direct',
  );
  e.kind = 'unauthenticated';
  return e;
}

// ---------------------------------------------------------------- 限速

const lastHit = new Map();
const MIN_INTERVAL_MS = 1000;

async function throttle(host) {
  const now = Date.now();
  const prev = lastHit.get(host) || 0;
  const wait = MIN_INTERVAL_MS - (now - prev);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

// ---------------------------------------------------------------- Cookie jar

/**
 * 最小可用 cookie jar：按 domain 存 cookie、请求时按子域匹配拼 Cookie 头。
 * **支持 Set-Cookie 的 domain 属性**（网关靠它把会话共享给 `*.webvpn.njts.edu.cn`）。
 * 不处理 path / secure / samesite 的完整语义——这些站点用不到。
 */
export class CookieJar {
  constructor(data = {}) {
    this.cookies = { ...data };
  }

  static fromJSON(json) {
    return new CookieJar(json?.cookies || {});
  }

  toJSON() {
    return { cookies: this.cookies };
  }

  /** 返回该 host 适用的 cookie 串 */
  header(hostname) {
    const pairs = [];
    for (const [domain, jar] of Object.entries(this.cookies)) {
      if (hostname === domain || hostname.endsWith(`.${domain}`) || domain.endsWith(hostname)) {
        for (const [k, v] of Object.entries(jar)) pairs.push(`${k}=${v}`);
      }
    }
    return pairs.join('; ');
  }

  /**
   * 吸收 Set-Cookie。
   *
   * **必须尊重 `domain` 属性。** 深信服网关会下发：
   *
   *   set-cookie: SESSION_-_auth.njts.edu.cn=<uuid>; Path=/cas/; domain=webvpn.njts.edu.cn
   *
   * 它得共享给所有 `xxx-s.webvpn.njts.edu.cn` 主机。早先这里一律存在请求主机名下，
   * 结果父域 cookie 被丢掉，网关始终认为我们没登录（一直 302 到登录页）。
   */
  absorb(url, setCookieHeaders = []) {
    const hostname = new URL(url).hostname;
    for (const raw of setCookieHeaders) {
      const parts = String(raw).split(';');
      const pair = parts[0];
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();

      // 从 attribute 里取 domain，且只接受能覆盖当前主机的（防跨站设 cookie）
      let domain = hostname;
      for (const attr of parts.slice(1)) {
        const m = attr.match(/^\s*domain\s*=\s*(.+?)\s*$/i);
        if (!m) continue;
        const d = m[1].replace(/^\./, '').toLowerCase();
        if (hostname === d || hostname.endsWith(`.${d}`)) domain = d;
      }

      const jar = (this.cookies[domain] ||= {});
      const expires = /expires=Thu, 01 Jan 1970/i.test(String(raw)) || /max-age=0/i.test(String(raw));
      if (expires || value === '') delete jar[name];
      else jar[name] = value;
    }
    return this;
  }

  has(name) {
    return Object.values(this.cookies).some((jar) => name in jar);
  }
}

// ---------------------------------------------------------------- 请求

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.method]
 * @param {object|string|Buffer} [opts.body]
 * @param {Record<string,string>} [opts.headers]
 * @param {CookieJar} [opts.jar]
 * @param {'follow'|'manual'} [opts.redirect]
 * @param {boolean} [opts.raw]   true 则返回 {status, headers, text, location}
 */
export async function request(opts) {
  const { url: rawUrl, method = 'GET', body, headers = {}, jar: rawJar, redirect = 'follow', raw = false, timeoutMs = 20000, via = 'auto' } = opts;

  // 路由：需要校内网络的主机改写成经 WebVPN 网关的地址，并用 VPN 自己的 cookie jar。
  // 注意 `via: 'vpn'` 会强制走网关；默认 'auto' 只看 VPN_ROUTE_HOSTS 清单。
  const route = resolveRoute(rawUrl, via);
  const url = route.url;
  // 调用方显式传的 jar 永远优先；只有在我们**改写了地址**且没传 jar 时，
  // 才回退到全局 VPN 会话的 jar。
  const jar = rawJar ?? (route.rewritten ? vpnSession?.jar : undefined);

  await throttle(new URL(url).hostname);

  const finalHeaders = { 'User-Agent': UA, ...headers };
  if (jar) {
    const cookie = jar.header(new URL(url).hostname);
    if (cookie && !finalHeaders.Cookie) finalHeaders.Cookie = cookie;
  }

  let payload;
  if (body instanceof URLSearchParams) {
    payload = body.toString();
    finalHeaders['Content-Type'] ||= 'application/x-www-form-urlencoded';
  } else if (body != null && typeof body === 'object' && !Buffer.isBuffer(body)) {
    payload = JSON.stringify(body);
    finalHeaders['Content-Type'] ||= 'application/json';
  } else {
    payload = body;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // ------------------------------------------------------------------
  // 手动跟重定向，不用 fetch 的 redirect:'follow'。两个理由，都是踩出来的：
  //   1. follow 时 **中间那一跳的 Set-Cookie 我们收不到**（只能拿到最终响应
  //      的头），而 CAS → ehall 的会话恰恰建立在中间那一跳：ehall 用 ticket
  //      换到自己的 cookie 后立刻又 302。结果就是"CAS 登录成功、ehall 没登录"。
  //   2. 跟随跨域跳转时 undici 会丢掉 Cookie 头，导致下一跳带着空手去。
  // 手动循环就能每跳重新按域名取 cookie + 吸收 Set-Cookie。
  // ------------------------------------------------------------------
  const MAX_REDIRECTS = 8;
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = payload;
  let res = null;

  try {
    for (let hop = 0; ; hop += 1) {
      if (hop > 0) await throttle(new URL(currentUrl).hostname);

      const hopHeaders = { ...finalHeaders };
      if (jar) {
        const cookie = jar.header(new URL(currentUrl).hostname);
        if (cookie) hopHeaders.Cookie = cookie;
        else delete hopHeaders.Cookie;
      }

      res = await fetch(currentUrl, {
        method: currentMethod,
        headers: hopHeaders,
        body: currentBody,
        redirect: 'manual', // 自己跟，见上面
        signal: controller.signal,
      });

      if (jar) {
        const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        jar.absorb(currentUrl, setCookies);
      }

      const loc = res.headers.get('location');
      const isRedirect = res.status >= 300 && res.status < 400 && loc;
      if (redirect !== 'follow' || !isRedirect) break;
      if (hop >= MAX_REDIRECTS) {
        throw serviceError(`重定向次数超过 ${MAX_REDIRECTS} 次：${url}`, '可能是登录循环；用 --debug 查看跳转链');
      }

      currentUrl = new URL(loc, currentUrl).href;
      // 303、以及浏览器的 301/302 实际行为：一律改成 GET 并丢掉 body
      if (res.status === 303 || res.status === 301 || res.status === 302) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
    }
  } catch (err) {
    if (err?.kind) throw err; // 上面自己抛的 serviceError 别再包一层
    throw wrapFetchError(err, url);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (raw) {
    return {
      status: res.status,
      headers: res.headers,
      text,
      location: res.headers.get('location') || '',
    };
  }

  const gateway = detectGatewayPage(text);
  if (gateway) throw gateway;

  if (res.status >= 500) {
    throw serviceError(`上游返回 ${res.status}：${url}`, '学校系统可能正在维护；原始响应可用 --debug 保存');
  }
  return { status: res.status, text, headers: res.headers };
}

/** 需要 JSON 时用这个：解析失败会给出 service 类错误而不是崩栈 */
export async function requestJson(opts) {
  const { text, status, headers } = await request(opts);
  try {
    return JSON.parse(text);
  } catch {
    const ct = headers?.get?.('content-type') || '无';
    // 把响应体开头带出来：非 JSON 响应 90% 的调试信息就在这几百字节里
    const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const hint =
      status >= 400 && status < 500
        ? '4xx 通常是**请求本身**被拒绝（参数名/签名/请求头不被接受），而不是密码错。用 --debug 看原始请求与响应'
        : '可能是页面改版或登录态失效被重定向到了登录页；用 --debug 查看原始响应';
    throw serviceError(
      `响应不是合法 JSON（HTTP ${status}，Content-Type: ${ct}）：${opts.url}` +
        `\n响应体${snippet ? `开头：${snippet}` : '为空'}`,
      hint,
    );
  }
}

// ---------------------------------------------------------------- 终端输入

/** 非 TTY 立即报错，绝不阻塞 agent */
export function assertTTY(action = '输入') {
  if (!process.stdin.isTTY) {
    throw inputError(`非交互环境无法${action}`, '请在终端里手动执行，或使用环境变量传入');
  }
}
