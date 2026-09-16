/**
 * 统一身份认证（Apereo CAS + 苏迪主题）
 *
 *   GET  https://auth.njts.edu.cn/cas/login?service=<service>
 *        → 表单 #fm1，隐藏字段 execution，页面带 encrypted=true
 *   POST https://auth.njts.edu.cn/cas/login?service=<service>
 *        username / password / execution / _eventId=submit / loginType=1
 *        → 302 到 service?ticket=ST-xxx，同时下发 CASTGC（TGT）
 *
 * 密码加密方式（M0.1）**已确定**，不再靠探测：
 *   /cas/themes/sudy_njts/js/login.js 里硬编码了公钥与算法：
 *     var key = RSAUtils.getKeyPair("010001", '', "008aed7e…");
 *     $("#password").val(RSAUtils.encryptedString(key, thisPwd));
 *   —— 即 Dave Shapiro 那套 RSAUtils 的**无填充裸 RSA**，公钥写死在页面里（非动态下发）。
 *   实现在 src/rsa.js；本模块只负责接上它，并保留 --password-mode=plain 作排障逃生门。
 *
 * 提交的表单字段（对应 #fm1）：username / password / execution / _eventId=submit / loginType=1
 *   （页面里还有个隐藏字段 encrypted=true，一并带上）
 */

import { HOSTS, CookieJar, request } from './http.js';
import { FILE, readJson, writeJson, removeFile, cacheGet, cacheSet } from './store.js';
import { loginFailed, serviceError, unauthenticated, networkError } from './errors.js';
import { rsaEncryptRaw, NJTS_CAS_KEY } from './rsa.js';

export const CAS = {
  base: HOSTS.cas,
  loginPath: '/cas/login',
  securityJs: '/cas/js/security.js',
};

const EXECUTION_RE = /name="execution"\s+value="([^"]+)"/i;
const JSESSION_RE = /JSESSIONID=([^;]+)/i;

export function parseLoginPage(html) {
  const execution = html.match(EXECUTION_RE)?.[1] || '';
  return {
    execution,
    encrypted: /name="encrypted"[^>]*value="true"/i.test(html),
    hasCaptcha: /captcha|验证码/i.test(html) && /img[^>]+captcha/i.test(html),
    hasSmsLogin: /loginType["']?\s*value=["']2/i.test(html),
  };
}

/**
 * 识别 security.js 里的加密方式。
 * 目前只做"能否看出是 RSA"的判断——常见于苏迪/金智 CAS：
 * 页面内嵌 modulus + exponent，或用 JSEncrypt 的公钥字符串。
 */
export function detectEncryption(js) {
  if (!js) return { mode: 'plain' };

  // 形如 var modulus = "A1B2..."; var exponent = "10001";
  const mod = js.match(/(?:modulus|Modulus|mod)[^"']{0,20}["']([0-9a-fA-F]{32,})["']/);
  const exp = js.match(/(?:exponent|Exponent|exp)[^"']{0,20}["']([0-9a-fA-F]{2,8})["']/);
  if (mod && exp) return { mode: 'rsa', modulus: mod[1], exponent: exp[1] };

  // 形如 BEGIN PUBLIC KEY / JSEncrypt
  const pem = js.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/);
  if (pem) return { mode: 'rsa', pem: pem[0] };

  // 形如 CryptoJS.DES / DES.encrypt 且带 8 位密钥
  const desKey = js.match(/(?:key|Key)\s*[:=]\s*["']([0-9A-Za-z]{8})["']/);
  if (/DES/.test(js) && desKey) return { mode: 'des', key: desKey[1] };

  return { mode: 'plain' };
}

/**
 * RSA 加密——用 src/rsa.js 的裸 RSA（与 RSAUtils 逐行对齐）。
 * modulus/exponent 为 hex 字符串；不传则用本站在 login.js 里硬编码的那把。
 */
export function rsaEncrypt(plain, { modulus, exponent } = {}) {
  return rsaEncryptRaw(plain, {
    modulus: modulus || NJTS_CAS_KEY.modulus,
    exponent: exponent || NJTS_CAS_KEY.exponent,
  });
}

/** 决定用哪种方式加密密码。现在默认就是 rsa（已确定），plain 只是逃生门。 */
export function encryptPassword(plain, mode = 'auto') {
  if (mode === 'plain') return { value: plain, used: 'plain' };
  return { value: rsaEncrypt(plain), used: 'rsa' };
}

async function fetchSecurityJs(jar) {
  const cached = cacheGet('cas-security', 24 * 3600);
  if (cached) return cached;
  try {
    const res = await request({ url: `${CAS.base}${CAS.securityJs}`, jar });
    if (res.status === 200 && res.text.length > 20) {
      cacheSet('cas-security', res.text);
      return res.text;
    }
  } catch {
    /* 取不到就退化为明文 */
  }
  return '';
}

export class CasSession {
  constructor({ jar = new CookieJar(), user = '', passwordMode = 'auto' } = {}) {
    this.jar = jar;
    this.user = user;
    this.loginAt = 0;
    this.passwordMode = passwordMode;
  }

  static load() {
    const state = readJson(FILE.session, {});
    if (!state?.cookies) return null;
    const s = new CasSession({ jar: CookieJar.fromJSON(state), user: state.user, passwordMode: state.passwordMode || 'auto' });
    s.loginAt = state.at || 0;
    return s;
  }

  save(user) {
    if (user) this.user = user;
    this.loginAt = Date.now();
    writeJson(FILE.session, { ...this.jar.toJSON(), user: this.user, at: this.loginAt, passwordMode: this.passwordMode });
  }

  static forget() {
    return removeFile(FILE.session);
  }

  get authenticated() {
    return this.jar.has('CASTGC') || this.jar.has('JSESSIONID');
  }

  /**
   * 登录并换取某个 service 的票据，返回落到该 service 的会话。
   * @param {string} service 例如 http://ehall.njts.edu.cn/
   */
  async login({ user, password, service, passwordMode } = {}) {
    const mode = passwordMode || this.passwordMode;
    if (!user || !password) throw loginFailed('缺少用户名或密码');

    const loginUrl = `${CAS.base}${CAS.loginPath}?service=${encodeURIComponent(service)}`;
    const page = await request({ url: loginUrl, jar: this.jar });
    const parsed = parseLoginPage(page.text);

    if (parsed.hasCaptcha) {
      throw loginFailed('登录页要求图形验证码', '本项目不实现验证码识别；请在学校页面手动登录，或改用其他方式获取会话');
    }
    if (!parsed.execution) {
      // 没有登录表单，最常见的原因是**已经登录了**：
      // 拿着有效的 CASTGC 再访问 /cas/login，CAS 会直接 302 把票据给你，
      // 根本不给表单——于是 execution 字段不存在。
      //
      // 用户会看到“未能提取 execution 票据”这种莫名其妙的话（实际上应该是
      // “你已经登录了，不用再登一次”）。这里直接拿现有会话去换票验证。
      if (this.authenticated) {
        try {
          await this.visit(service);
          return { location: 'already-authenticated', passwordMode: 'reused', encrypted: false };
        } catch {
          /* 会话其实已失效，落到下面报错 */
        }
      }
      throw serviceError('未能从登录页提取 execution 票据', 'CAS 页面结构可能已改版；用 --debug 保存页面');
    }

    const { value: passwordValue, used } = encryptPassword(password, mode);

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
      headers: { Referer: loginUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const location = res.headers.get('location') || '';
    const failed = res.status === 200 && /fm1|form-error|密码|错误/i.test(res.text || '');
    if (failed || location.includes('login?service') === false && location.includes('/cas/login')) {
      throw loginFailed('统一身份认证拒绝了这次登录（用户名或密码错误，或账号被锁）');
    }
    if (res.status !== 302 && res.status !== 303 && res.status !== 200) {
      throw networkError(`登录返回了意外状态码 ${res.status}`);
    }

    this.save(user);
    return { location, passwordMode: used, encrypted: parsed.encrypted };
  }

  /** 用已有 TGT 换某个 service 的 ticket 并跟过去，落地该站 cookie */
  async visit(service) {
    const url = `${CAS.base}${CAS.loginPath}?service=${encodeURIComponent(service)}`;
    const first = await request({ url, jar: this.jar, redirect: 'manual' });
    const location = first.headers.get('location') || '';

    if (location.includes('/cas/login')) {
      throw unauthenticated('统一身份认证会话', 'TGT 已过期，请重新执行 njts login');
    }
    if (location) {
      await request({ url: location, jar: this.jar, redirect: 'follow' });
    }
    return this;
  }

  async whoami() {
    if (!this.authenticated) throw unauthenticated('统一身份认证会话');
    return { user: this.user };
  }
}
