/**
 * 校园 WebVPN（深信服 Sangfor / Sangine 网关）客户端。
 *
 * ## 为什么是"网页版"而不是隧道
 *
 * 深信服把校内资源按类型分配给账号：**网页资源**（反向代理）与 **L3 隧道资源**（EasyConnect）。
 * 实测本账号只有前者——用 zju-connect 走隧道登录会得到
 * `ErrorCode 20048 / No virtual portal access`（认证通过，但没有隧道门户）。
 * 所以这里实现的是**网页版**：不需要 root、不需要 /dev/net/tun，纯 HTTP。
 *
 * ## 地址映射规则（从真实 URL 反推，已实测）
 *
 *   portal.njts.edu.cn  →  portal-njts-edu-cn-s.webvpn.njts.edu.cn:8118
 *   └─ 原主机名           └─ 点换横线，再追加 -s，端口固定 8118
 *
 * 网关只有 8118 一个端口（8119/8120/8000 均不通）；换成 IP 直连会被网络白名单拒掉，
 * 所以必须走域名。
 *
 * ## 登录协议（网页版与隧道版只差一个参数）
 *
 *   隧道版：POST /por/login_psw.csp?anti_replay=1&encrypt=1&type=cs
 *   网页版：POST /por/login_psw.csp?anti_replay=1&encrypt=1          ← 不带 type=cs
 *
 * 带 `type=cs`（client/server）会申请隧道门户，本账号没有 → 20048。
 * 其余完全一致：
 *   GET  /por/login_auth.csp?apiversion=1
 *        → RSA_ENCRYPT_KEY(模数, **十六进制**) / RSA_ENCRYPT_EXP(指数, **十进制**)
 *          / CSRF_RAND_CODE / RndImg，并下发 TWFID cookie
 *   密码处理：**明文先拼 "_" + CSRF_RAND_CODE**，再 RSA-PKCS1v15 加密，密文转 hex
 *   POST 表单（**浏览器版**）：svpn_name / svpn_password / svpn_req_randcode /
 *                                  svpn_rand_code(=md5("")) / mitm_result
 *
 * ⚠️ 字段名必须用**浏览器**的那套，不能用隧道客户端的（zju-connect 发的是 `mitm`
 * 而不是 `mitm_result`）。服务端靠 UA + 字段组合判定客户端类型，用错就变成
 * 在申请一个并不存在的客户端门户，得到 `No virtual portal access`。
 *
 * ## 凭据
 *
 * 与其它模块一致：密码只经环境变量（NJTS_VPN_PASS）或交互输入进入本进程，不认识磁盘、
 * 不进命令行、不写日志。会话 cookie 单独存 ~/.njts-cli/vpn-session.json（0600）。
 */

import crypto from 'node:crypto';

import { HOSTS, CookieJar, request, gateHost, gateUrl, VPN_GATE } from './http.js';
import { CAS, parseLoginPage, encryptPassword } from './cas.js';
import { FILE, readJson, writeJson, removeFile } from './store.js';
import { NjtsError, loginFailed, serviceError, unauthenticated, inputError } from './errors.js';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/**
 * 登录时用的 User-Agent。
 *
 * **用用户验证过的那个客户端：电脑 Chrome**。用户 2026-09-15 确认他是用
 * 电脑 Chrome 登录的，所以手机 UA 不是正确的选择（那个假设已推翻）。
 * 与 http.js 的 UA 保持同一个——CAS / 一卡通那条线用它一直是通的。
 * 想试验其它 UA 不必改代码：设 NJTS_VPN_UA 环境变量即可。
 */
const VPN_UA =
  process.env.NJTS_VPN_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36';

/**
 * 读取门户 SPA 的公开脚本，找出 thirdparty_auth_judgment 可能调用的接口。
 * 这是静态侦察：不执行 JS、不提交表单、不输出 cookie/token 值。
 */
async function syncPortalSession(portalUrl, jar) {
  // 门户 SPA 的 SFAPI.init() 紧接着会调用当前 origin 的 /por/login_auth.csp，
  // 然后用返回的 TWFID 调 /por/update_session.csp。之前 CLI 只 GET 了 portal HTML，
  // 漏掉了这两个真正的“第三方认证判断”请求。
  const base = new URL(portalUrl).origin;
  const result = {
    origin: base,
    initStatus: null,
    initCode: null,
    hasTwfId: false,
    updateStatus: null,
    updateSetCookie: [],
    updateBytes: null,
    updateContentType: null,
    cookies: [],
    cookieDomains: {},
  };
  try {
    const init = await request({ url: `${base}/por/login_auth.csp?apiversion=1`, jar, raw: true, redirect: 'follow' });
    const info = parseAuthXml(init.text);
    result.initStatus = init.status;
    result.initCode = info.errorCode || null;
    result.hasTwfId = Boolean(info.twfId);
    if (info.twfId) {
      const updated = await request({
        url: `${base}/por/update_session.csp?twfid=${encodeURIComponent(info.twfId)}&apiversion=1`,
        jar,
        raw: true,
        redirect: 'follow',
        headers: { TWFID: info.twfId },
      });
      result.updateStatus = updated.status;
      result.updateSetCookie = (updated.headers.getSetCookie?.() || []).map((raw) => {
        const name = /^([^=]+)=/.exec(raw)?.[1] || '?';
        const domain = /domain=([^;]+)/i.exec(raw)?.[1]?.replace(/^\./, '') || new URL(base).hostname;
        return `${name}@${domain}`;
      });
      result.updateBytes = String(updated.text || '').length;
      result.updateContentType = updated.headers.get('content-type') || null;
    }
    // 报**所有域**的 cookie 名（不只顶点域）：TWFID 跨域有效这件事已经实测过，
    // 写死一个域去读，读空了就会误导成"没拿到会话"。
    result.cookies = [...new Set(Object.values(jar.cookies || {}).flatMap((m) => Object.keys(m || {})))];
    for (const [domain, cookies] of Object.entries(jar.cookies || {})) {
      result.cookieDomains[domain] = Object.keys(cookies);
    }
  } catch (err) {
    result.error = err.cause?.code || err.message;
  }
  return result;
}

async function inspectPortalScripts(portalUrl, html, jar) {
  if (!html || !/\/portal\//i.test(portalUrl)) return { html: false, scripts: [] };
  const srcs = [...String(html).matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((src) => !/^data:/i.test(src))
    .slice(0, 12);
  const scripts = [];
  for (const src of srcs) {
    const url = new URL(src, portalUrl).href;
    try {
      const r = await request({ url, jar, raw: true, redirect: 'follow' });
      const text = r.text || '';
      const hits = [];
      for (const re of [
        /thirdparty_auth_judgment/gi,
        /(?:auth|login|judgment|thirdparty|portal)[A-Za-z0-9_./?=&:-]{0,100}/gi,
        /\/por\/[A-Za-z0-9_./?=&:-]{1,100}/gi,
        /(?:TWFID|sudy_log_token|JSESSIONID)/g,
      ]) {
        for (const m of text.matchAll(re)) {
          const value = m[0].replace(/ticket=[^&"']+/gi, 'ticket=<脱敏>');
          if (!hits.includes(value)) hits.push(value);
          if (hits.length >= 20) break;
        }
        if (hits.length >= 20) break;
      }
      scripts.push({ url: url.replace(/ticket=[^&]*/g, 'ticket=<脱敏>'), status: r.status, bytes: text.length, hits });
    } catch (err) {
      scripts.push({ url, error: err.cause?.code || err.message });
    }
  }
  return { html: true, scriptCount: srcs.length, scripts };
}

export const VPN = {
  /**
   * 网关资源主机的**后缀**与端口。
   *
   * ⚠️ 注意别把这里和"网关顶点"搞混：
   *   · `vpn.njts.edu.cn`       —— 网关顶点，**公网可达**，CAS/门户流程用它
   *   · `webvpn.njts.edu.cn`    —— 公网**没有 A 记录**（不少教程让你改 /etc/hosts 的就是它）
   *   · `*-s.webvpn.njts.edu.cn:8118` —— 资源主机，**有公网记录、可达**，教务/门户都在这上面
   *
   * 早先这里认为"真门户是 webvpn.njts.edu.cn，不是 vpn.njts.edu.cn"，
   * 并把 `base` 指向它 —— **那是错的**：两者是同一台设备（222.192.176.8），
   * 而顶点那个主机名根本解析不出来，所以基于它的代码（密码登录、check、logout）
   * 全部只是在 catch 里打转。2026-09-16 实测后已删除，现在只剩可达的主机。
   */
  gateSuffix: 'webvpn.njts.edu.cn',
  gatePort: '8118',
};
export { gateHost, gateUrl };

/** 每条 host 对应的网关主机名（用于 cookie 归类） */
export const GATE_HOSTS = {
  jwxt: gateHost('jwxt.njts.edu.cn'),
  ehall: gateHost('ehall.njts.edu.cn'),
  portal: gateHost('portal.njts.edu.cn'),
  card: gateHost('aggrepay.njts.edu.cn'),
};

/**
 * 网关的「你还没登录」页。
 *
 * ⚠️ 它**不是 302**，是一个 **HTTP 200 的 HTML**，靠 JS 跳转：
 *
 *   g_lines = [{src:"",url:"https://<网关>/portal?redirect_uri=<原地址>",right:0}];
 *   gotoLines();
 *
 * 2026-09-15 实测踩到：早期版本只看状态码，把这种 200 当成了"资源可达"，
 * `vpn status` 因此报出三个 `ok: true` 的假阳性 —— 实际返回的是 6916 字节的
 * 跳转页，正文里连一个正方字样都没有。
 */
const GATE_LOGIN_PAGE = /sf_ssl_ms_|gotoLines\s*\(\s*\)/;

/** 从选路页里抠出真正的跳转目标（g_lines 里那条 url） */
export function extractGateRedirect(html) {
  const m = String(html).match(/url\s*:\s*"(https?:\/\/[^"]+)"/);
  return m ? m[1].replace(/\\\//g, '/') : '';
}

/**
 * 识别网关的「用户不符合登录策略，禁止登录」。
 * 2026-09-15 实测：门户的用户名密码表单对该账号报这条，但**网关 CAS 那条路能登进去**，
 * 所以它是「学校策略不允许密码直连门户」，不是账号被锁。不要再拿它吓自己。
 */
function isPolicyDenied(info) {
  const text = `${info?.message || ''} ${info?.note || ''} ${info?.raw || ''}`;
  return /不符合登录策略|禁止登录|login policy|Access was denied|No virtual portal/i.test(text);
}

export function parseAuthXml(text = '') {
  const pick = (tag) => {
    const m = String(text).match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
    return m ? m[1].trim() : '';
  };
  const code = pick('ErrorCode') || pick('errorCode');
  return {
    errorCode: code,
    note: pick('Note'),
    message: pick('Message'),
    errorMsg: pick('ErrorMsg'),
    result: pick('Result'),
    csrfRandCode: pick('CSRF_RAND_CODE'),
    rsaKey: pick('RSA_ENCRYPT_KEY'),
    rsaExp: pick('RSA_ENCRYPT_EXP') || '65537',
    rndImg: pick('RndImg'),
    // 深信服不同接口的标签大小写不一致：login_auth.csp 实际返回 `<TwfID>`，
    // 而部分登录响应使用 `<TWFID>`。XML 标签大小写敏感，必须兼容两种写法。
    twfId: pick('TWFID') || pick('TwfID'),
    vpnVersion: pick('VPNVERSION'),
    domainSsoUrl: pick('DomainSSOUrl'),
    raw: text,
  };
}

// ---------------------------------------------------------------- 会话

export class VpnSession {
  constructor({ jar = new CookieJar(), user = '', twfId = '', loginAt = 0, vpnVersion = '' } = {}) {
    this.jar = jar;
    this.user = user;
    this.twfId = twfId;
    this.loginAt = loginAt;
    this.vpnVersion = vpnVersion;
  }

  static load() {
    const state = readJson(FILE.vpnSession, {});
    if (!state?.cookies) return null;
    return new VpnSession({
      jar: CookieJar.fromJSON(state),
      user: state.user || '',
      twfId: state.twfId || '',
      loginAt: state.at || 0,
      vpnVersion: state.vpnVersion || '',
    });
  }

  save(user) {
    if (user) this.user = user;
    this.loginAt = Date.now();
    try {
      writeJson(FILE.vpnSession, {
        ...this.jar.toJSON(),
        user: this.user,
        twfId: this.twfId,
        vpnVersion: this.vpnVersion,
        at: this.loginAt,
      });
    } catch (err) {
      // 与其它会话一致：落盘是尽力而为，只读环境不该拖垮命令
      process.stderr.write(`[vpn] 会话未能落盘（${err.code || err.message}）\n`);
    }
  }

  static forget() {
    return removeFile(FILE.vpnSession);
  }

  get authenticated() {
    return Boolean(this.twfId) || this.jar.has('TWFID');
  }

  /**
   * 登录 WebVPN。
   * 步骤与 zju-connect 的隧道登录一致，**只少 `type=cs`**。
   */
  /**
   * **从网关**登 CAS —— 这是建立“网关反向代理会话”的唯一途径。
   *
   * 为什么不能直连 auth.njts.edu.cn 登：
   *   网关自己的 cookie（`TWFID` / `sudy_log_token`）域是 **`.webvpn.njts.edu.cn`**，
   *   而 `vpn.njts.edu.cn` 与它是**兄弟域名**，门户登录根本设不了这个 cookie。
   *   能设它的只有 `*.webvpn.njts.edu.cn` 主机——也就是用户找到的那个
   *   `auth-njts-edu-cn-s…:8118/cas/login`。
   *
   *   用户 2026-09-15 明确：`https://vpn.njts.edu.cn/portal/` **登不上**，
   *   只能从这个网关 CAS 地址登——登完门户和资源就都能用了。
   *
   * 流程与直连版几乎一样，只是登录页和 POST 都走网关（网关必须看到这次登录，
   * 才会建立它自己的会话），最后票据仍会跳到 `vpn.njts.edu.cn/auth/cas_validate`。
   */
  async loginViaGatewayCas({ user, password, passwordMode } = {}) {
    if (!user || !password) throw loginFailed('缺少学号或密码');

    const gateCas = `http://${gateHost('auth.njts.edu.cn')}:${VPN_GATE.port}${CAS.loginPath}`;
    const loginUrl = `${gateCas}?service=${encodeURIComponent(VPN.casService)}`;

    // ① 取登录页（经网关代理；这一步网关会下发 domain=webvpn.njts.edu.cn 的 cookie）
    const page = await request({ url: loginUrl, jar: this.jar, raw: true });
    const parsed = parseLoginPage(page.text);
    if (parsed.hasCaptcha) {
      throw loginFailed('登录页要求图形验证码', '本项目不实现验证码识别；请在浏览器里手动登录一次，再用 vpn login 换票');
    }
    if (!parsed.execution) {
      throw serviceError(
        '未能从网关 CAS 登录页提取 execution 票据',
        `网关 CAS 页 HTTP ${page.status}。可能这所学校没把 auth.njts.edu.cn 发布到 WebVPN 资源里`,
      );
    }

    // ② 提交凭据。**必须仍经网关**——网关要看到这次登录才会建自己的会话。
    const { value: passwordValue, used } = encryptPassword(password, passwordMode || 'auto');
    const form = new URLSearchParams({
      username: user,
      password: passwordValue,
      execution: parsed.execution,
      _eventId: 'submit',
      loginType: '1',
      ...(parsed.encrypted ? { encrypted: 'true' } : {}),
    });

    const res = await request({
      url: loginUrl,
      method: 'POST',
      body: form,
      jar: this.jar,
      redirect: 'manual',
      raw: true,
      headers: { Referer: loginUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    // ③ 跟票据（会跳到 vpn.njts.edu.cn/auth/cas_validate，落在门户）
    const chain = [];
    let portalHtml = '';
    let target = res.headers.get('location') || '';
    if (!target) {
      const wentBackToLogin = /登录|login|错误|失败|密码/.test(res.text);
      throw loginFailed(
        wentBackToLogin ? '网关 CAS 拒绝了这次登录（多半是密码错）' : '网关 CAS 没给跳转',
        `HTTP ${res.status}；用 --debug 看原始响应。**不要反复重试**，失败尝试会被计数`,
      );
    }
    target = new URL(target, loginUrl).href;

    for (let hop = 0; hop < 8; hop += 1) {
      const r = await request({ url: target, jar: this.jar, redirect: 'manual', raw: true });
      // 记下每一跳：到哪儿、什么状态、网关在这一跳下发了哪些 cookie（**只记名字**）。
      // 排障靠这个——浏览器与我们的差别就藏在这条链的某一跳上。
      if (/\/portal\//i.test(target) && r.status === 200) portalHtml = r.text;
      chain.push({
        url: target.replace(/ticket=[^&]*/g, 'ticket=<脱敏>'),
        status: r.status,
        setCookie: (r.headers.getSetCookie?.() || []).map((c) => {
          const name = /^([^=]+)=/.exec(c)?.[1] || '?';
          const dom = /domain=([^;]+)/i.exec(c)?.[1];
          return dom ? `${name}@${dom}` : `${name}(host-only)`;
        }),
        next: (r.headers.get('location') || '').replace(/ticket=[^&]*/g, 'ticket=<脱敏>') || null,
      });
      const next = r.headers.get('location') || '';
      if (r.status >= 300 && r.status < 400 && next) {
        target = new URL(next, target).href;
        continue;
      }
      break;
    }

    // ④ 先记录门户 SPA 的静态入口，寻找浏览器完成的“第三方认证”交换。
    // 不执行 JavaScript，只读取脚本源码中的公开路径/函数名；输出不含 cookie 值。
    const portalTrace = await inspectPortalScripts(target, portalHtml, this.jar);
    const portalSync = await syncPortalSession(target, this.jar);

    // ⑤ 去真门户报到。
    //
    // 浏览器登录后会落到门户 SPA（https://webvpn.njts.edu.cn/portal/），
    // 网关**自己的**会话 cookie（`.webvpn.njts.edu.cn` 上的 TWFID / sudy_log_token）
    // 应当就在那一步下发。少了它，资源请求会被踢回登录跳转。
    //
    // 该主机公网无 A 记录（真实 IP 222.192.176.8），DNS 被代理污染时这一步会失败。
    // **失败不算致命**：已有的门户会话仍然能用（rclist/conf 都行），只是资源进不去。
    let portalVisited = false;
    let portalNote = '';
    let portalCookies = [];
    try {
      // 候选顺序：先试“经网关代理的门户”，再试直连门户。
      //
      // 依据 2026-09-15 抓到的真实跳转链：CAS 校验只把 TWFID 以 **host-only** 方式
      // 落在 `vpn.njts.edu.cn`，**资源主机收不到它**。而浏览器能用，靠的是
      // `.webvpn.njts.edu.cn` 上的另一份 TWFID —— 只有网关自己下发的才是那个域。
      // 门户的解密 data 里 logoutUrl 指向 `auth-…-s.webvpn.njts.edu.cn:8118`，
      // 证明门户确实会访问“经网关代理的自己”，那一步才会下发父域 cookie。
      const candidates = [
        'vpn.njts.edu.cn',
        'webvpn.njts.edu.cn',
      ].map((h) => `http://${gateHost(h)}:${VPN_GATE.port}/portal/`);

      for (const u of candidates) {
        try {
          const pr = await request({ url: u, jar: this.jar, raw: true, redirect: 'follow' });
          portalVisited = portalVisited || (pr.status >= 200 && pr.status < 400);
          const got = Object.keys(this.jar.cookies?.['webvpn.njts.edu.cn'] || {});
          portalNote = `HTTP ${pr.status}；网关域 cookie: ${got.length ? got.join(',') : '无'}`;
          // 一旦拿到了网关自己的会话 cookie，就不用再试后面的了
          if (got.includes('TWFID') || got.includes('sudy_log_token')) break;
        } catch (err) {
          portalNote = `失败：${err.cause?.code || err.message}`;
        }
      }
      portalCookies = Object.keys(this.jar.cookies?.['webvpn.njts.edu.cn'] || {});
    } catch (err) {
      portalNote = `意外失败：${err.message}`;
    }

    this.twfId =
      this.jar.cookies?.['vpn.njts.edu.cn']?.TWFID ||
      this.jar.cookies?.['webvpn.njts.edu.cn']?.TWFID ||
      this.twfId;
    if (!this.authenticated) {
      throw serviceError('网关 CAS 走完了但没有拿到门户会话', '用 --debug 看跳转链');
    }

    this.save(user);
    return {
      via: 'gateway-cas',
      user,
      passwordMode: used,
      // 只报 cookie **名字**，绝不报值
      gatewayCookies: Object.keys(this.jar.cookies?.['webvpn.njts.edu.cn'] || {}),
      portal: { visited: portalVisited, note: portalNote, cookies: portalCookies, trace: portalTrace, sync: portalSync },
      chain,
    };
  }

  /**
   * 用**已有 CAS 会话**的票据登录 WebVPN。
   *
   * 走的是深信服的 CAS 校验端点，不碰 /por/login_psw.csp——因此绕开了那个
   * 怎么都对不上的 20048。用户 2026-09-15 实测这条路径可用。
   *
   * @param {import('./cas.js').CasSession} cas 已登录的 CAS 会话（njts login 建的那个）
   */
  async loginViaCas(cas) {
    if (!cas?.authenticated) {
      throw unauthenticated('统一身份认证会话', '请先执行 njts login（或用 njts_login 弹窗）');
    }

    // ① 用 TGT 换这个 service 的票据。CAS 把票据放在跳转的 location 里。
    const grantUrl = `${CAS.base}${CAS.loginPath}?service=${encodeURIComponent(VPN.casService)}`;
    const grant = await request({ url: grantUrl, jar: cas.jar, redirect: 'manual' });
    const location = grant.headers.get('location') || '';

    if (!/ticket=/.test(location)) {
      throw unauthenticated(
        '统一身份认证会话',
        'CAS 没给票据。要么 TGT 已过期（CAS 默认 2-3 小时），要么这个 service 未获授权。重新执行 njts login 后再试',
      );
    }

    // ② 带票据去 VPN，用 **VPN 自己的 jar** 逐跳跟，落地会话 cookie
    let target = new URL(location, CAS.base).href;
    let last = null;
    for (let hop = 0; hop < 8; hop += 1) {
      last = await request({ url: target, jar: this.jar, redirect: 'manual', raw: true });
      const next = last.headers.get('location') || '';
      if (last.status >= 300 && last.status < 400 && next) {
        target = new URL(next, target).href;
        continue;
      }
      break;
    }

    const vpnCookies = this.jar.cookies?.['vpn.njts.edu.cn'] || {};
    this.twfId = this.twfId || vpnCookies.TWFID || '';

    if (!this.authenticated) {
      throw loginFailed(
        'CAS 票据未被 WebVPN 接受',
        `末尾状态 ${last?.status}；网关可能改版。用 --debug 看原始响应`,
      );
    }

    this.save(cas.user);
    return { via: 'cas', user: cas.user, cookies: Object.keys(vpnCookies) };
  }

  /**
   * 退出。
   *
   * **只清本地**：以前这里会去请求 `https://webvpn.njts.edu.cn/por/logout.csp`，
   * 而那台主机公网没有 A 记录（`vpn.njts.edu.cn` 才是同一台可达的网关）——
   * 也就是说那个请求**根本就发不出去**，只是一直被 catch 吞着。
   * 网关会话本身是随票据过期的，本地清干净即可。
   */
  async logout() {
    return VpnSession.forget();
  }

  /**
   * 发一次请求，**不跟重定向**。专给诊断用（njts vpn probe）。
   *
   * 排障时必须看到网关原始的 302 和它在每一跳下发的 Set-Cookie，
   * 跟到底反而什么都看不清。所以这里独立成一个方法，而不是给 gate() 开覆盖口子。
   */
  async gateRaw(target, opts = {}) {
    if (!this.authenticated) {
      throw unauthenticated('WebVPN 会话', '请先执行 njts vpn login（或让用户用 njts_login 弹窗登录）');
    }
    return request({
      ...opts,
      url: target,
      via: 'vpn',
      jar: this.jar,
      raw: true,
      redirect: 'manual',
      headers: { 'User-Agent': VPN_UA, ...(opts.headers || {}) },
    });
  }

  /**
   * 经网关访问某个内网主机（会跟重定向）。
   * @param {string} target 原始内网地址，如 http://jwxt.njts.edu.cn/jwglxt/...
   */
  async gate(target, opts = {}) {
    if (!this.authenticated) {
      throw unauthenticated('WebVPN 会话', '请先执行 njts vpn login（或让用户用 njts_login 弹窗登录）');
    }

    // ⚠️ **必须跟重定向**。
    //
    // 刚登录完去访问资源时，网关会先 302 到
    //   https://webvpn.njts.edu.cn:443?redirect_uri=<原始资源地址>
    // 那一步会在顶点域名上建立**网关自己的反向代理会话**（与门户会话是两套东西），
    // 然后再 302 回原地址，之后资源才可达。
    //
    // `redirect: 'follow'` **写死在 `...opts` 之后**，不允许调用方覆盖。
    //
    // 这个坑踩了两次：
    //   第一次写成 `redirect:'follow', ...opts`，被调用方传的 manual 盖回去；
    //   第二次改成 `opts.redirect ?? 'follow'`，而 vpn status / probe 恰好在传 manual，
    //   于是依然不跟。所以不再给这个选项任何覆盖空间。
    //
    // 想只看原始响应的调用方请用 gateRaw()。
    const fetchOnce = () =>
      request({
        ...opts,
        url: target,
        via: 'vpn',
        jar: this.jar,
        raw: true,
        redirect: 'follow',
        headers: { 'User-Agent': VPN_UA, ...(opts.headers || {}) },
      });

    let res = await fetchOnce();

    // 网关的"请登录"页是 200 + JS 跳转，不是 302。必须识别出来并跟着走一遍，
    // 否则会把 200 误报成"资源可达"（今天就是这么误报的）。
    // 跳过去之后门户会下发网关自己的会话 cookie，再请求原地址就成了。
    if (res.status === 200 && GATE_LOGIN_PAGE.test(String(res.text || ''))) {
      const hop = extractGateRedirect(res.text);
      if (hop) {
        await request({
          url: hop,
          jar: this.jar,
          raw: true,
          redirect: 'follow',
          timeoutMs: opts.timeoutMs,
          headers: { 'User-Agent': VPN_UA },
        });
        res = await fetchOnce();
      }
      if (res.status === 200 && GATE_LOGIN_PAGE.test(String(res.text || ''))) {
        throw unauthenticated(
          'WebVPN 网关会话',
          '网关仍要求先到门户登录（返回的是 JS 跳转页，不是资源）。请跑 njts vpn login；若已登录仍如此，说明门户那一步没拿到会话 cookie',
        );
      }
    }

    // 跟完之后若还停在登录跳转上，那才真是会话失效
    const loc = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400 && /webvpn\.njts\.edu\.cn:443/.test(loc)) {
      throw unauthenticated(
        'WebVPN 会话',
        '网关仍要求重新登录。注意：跳转目标 webvpn.njts.edu.cn 对外**没有可用主机**（浏览器也打不开），所以这条路当前走不通',
      );
    }
    return res;
  }
}

export { loginFailed, serviceError, unauthenticated, inputError, GATE_LOGIN_PAGE };
