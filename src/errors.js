/**
 * 错误契约 —— 见 plan §3.2。
 *
 * 所有命令失败时 stdout 输出：
 *   {"ok":false,"error":{"kind":"...","message":"...","hint":"..."}}
 * 并以表中对应的退出码结束。agent 靠 kind 决定下一步动作，不靠 message 文本。
 */

export const EXIT = {
  ok: 0,
  unauthenticated: 2,
  login: 3,
  network: 4,
  service: 5,
  input: 6,
  unsupported: 7,
};

export class NjtsError extends Error {
  constructor(kind, message, hint = '') {
    super(message);
    this.name = 'NjtsError';
    this.kind = kind;
    this.hint = hint;
  }

  get exitCode() {
    return EXIT[this.kind] ?? EXIT.service;
  }

  toJSON() {
    return { kind: this.kind, message: this.message, hint: this.hint };
  }
}

/** 未登录 / 会话失效 */
export const unauthenticated = (what = '会话', hint = '') =>
  new NjtsError('unauthenticated', `${what}已失效或未登录`, hint || `请先执行 njts login${what.includes('一卡通') ? '（一卡通为独立密码，命令是 njts card login）' : ''}`);

/** 登录阶段失败：密码错、账号锁定 */
export const loginFailed = (message, hint = '') =>
  new NjtsError('login', message, hint || '登录失败不会自动重试，避免触发账号锁定；请确认凭据后手动重试');

/** 网络不可达 / 疑似未连 VPN */
export const networkError = (message, hint = '') =>
  new NjtsError('network', message, hint);

/** 上游 5xx 或页面改版导致解析失败 */
export const serviceError = (message, hint = '') =>
  new NjtsError('service', message, hint);

/** 参数错误 */
export const inputError = (message, hint = '') =>
  new NjtsError('input', message, hint);

/** 能力未实现或被安全策略禁用 */
export const unsupported = (message, hint = '') =>
  new NjtsError('unsupported', message, hint);

/**
 * 识别学校网关的 HTTPS 502 页（见 plan §1.3）。
 * 这类页面会让浏览器"以为站点活着只是坏了"，永远不会回退到 http，
 * 用户看到的现象是"没权限/打不开"。这里把它翻译成人话。
 */
export function detectGatewayPage(text = '') {
  if (/请检查请求地址以及\s*http\/https\s*协议/i.test(text) || /该网站无法访问/.test(text)) {
    return networkError(
      '学校网关拒绝了这次请求（HTTPS 无监听，返回 502 页）',
      '该站只支持 http，请显式使用 http:// 前缀访问；若在浏览器里请关闭「始终使用安全连接」',
    );
  }
  // ② 校外 IP 被拦：实测 ehall 的 /amp-auth-adapter/sp/* 会回这个 403 页。
  //    注意：它不是「没登录」，是「你在校外」——所以 kind 是 network 而不是 unauthenticated。
  if (/校外地址访问/.test(text) && /VPN/i.test(text)) {
    return networkError(
      '办事大厅拒绝了校外地址的访问（"请先登录我校 VPN"）',
      '这是学校侧的网段限制，不是登录问题。需先连校园 VPN（https://vpn.njts.edu.cn）再重试；一卡通 / CAS 不受此限',
    );
  }

  // ③ 金智 AMP 平台的 /noAccount 页。
  //    它可能是「账号真没开通」，也可能是「SAML 会话建了但平台认不出人」。
  //    两种成因完全不同，所以不写成确定结论，只说清现象和验证办法。
  if (/账号可能存在异常/.test(text)) {
    return serviceError(
      '办事大厅返回「账号可能存在异常」页（/noAccount）',
      '这个页面有两种成因：①账号在该平台未开通；②登录会话建了但平台认不出身份（常见于校外访问）。'
        + '请用手机浏览器直接打开 http://ehall.njts.edu.cn/ 对照：若浏览器里也一样，就是账号或网段问题，不是本工具的问题',
    );
  }

  return null;
}

/** 把 fetch 抛出的底层错误翻译成契约内的错误 */
export function wrapFetchError(err, url) {
  const cause = err?.cause?.code || err?.code || '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(cause)) {
    return networkError(`无法解析主机：${url}`, '请检查网络，或确认是否需要先连接校园网 / VPN');
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ABORT_ERR'].includes(cause)) {
    return networkError(`连接失败：${url}`, '校内系统通常需要校园网或 VPN；若在校外请先连 VPN');
  }
  return networkError(`请求失败：${url}（${err.message}）`, '请检查网络连通性');
}
