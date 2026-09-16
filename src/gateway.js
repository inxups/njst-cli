/**
 * 教务：**纯 HTTP 全链**（2026-09-16 在容器里实跑通过，零浏览器）。
 *
 * ## 这条路推翻的两个旧结论（都要删掉，别再当证据用）
 *
 * 1. 「过门必须靠浏览器，那几关都是 JS 造的」——**错**。
 *    实测六跳全走完：门户 → openModule.do → SSO → CAS 票据 → ticketlogin → 正方首页。
 * 2. 「资源主机的会话必须落在 .webvpn.njts.edu.cn 域上」——**错**。
 *    网关的 TWFID **跨域有效**，直接发给 jwxt-…-s.webvpn.njts.edu.cn:8118 就放行。
 *    浏览器里 .webvpn.njts.edu.cn 上那个 TWFID，只是因为它访问过那个域名而已。
 *
 * 另外：`webvpn.njts.edu.cn` 公网没有 A 记录，但**根本不需要它** ——
 * `vpn.njts.edu.cn` 是同一台网关，选路页给出的地址也都用 vpn.njts.edu.cn。
 *
 * ## 链（每一步都实测过）
 *
 *  ① CAS 会话（公网 auth.njts.edu.cn 登录，cookie SESSION / CASTGC）
 *  ② 用 CAS 票据换网关会话 → TWFID（见 vpn.js 的 --via-cas）
 *  ③ 门户（portal-…-s:8118）走 CAS 票据链 → 302 带 ticket=ST-… → 200 主门户
 *     之后 jar 里自然出现 JSESSIONID_-_portal.njts.edu.cn / sudy_log_token_-_portal.njts.edu.cn
 *  ④ 门户的 /mobile/openModule.do?appName=<教务 appId>-pc
 *     → {"result":"1","data":"http://jwxt.njts.edu.cn/sso/Sudylogin"}
 *  ⑤ **把那个地址的 host 改写成网关主机**（校外只有网关主机能到），跟跳：
 *     CAS 票据 → /sso/Sudylogin → /jwglxt/ticketlogin?uid=<学号>… → 正方会话建立
 *  ⑥ POST 课表接口 → JSON
 *
 * 全程只读：只发 GET/POST 到查询接口，不点选课、不提交表单、不改任何东西。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 网关资源主机（`-s` 那组）。这三台都实测可达；裸 jwxt.njts.edu.cn 校外 403。 */
export const GATE = {
  auth: 'http://auth-njts-edu-cn-s.webvpn.njts.edu.cn:8118',
  portal: 'http://portal-njts-edu-cn-s.webvpn.njts.edu.cn:8118',
  jwxt: 'http://jwxt-njts-edu-cn-s.webvpn.njts.edu.cn:8118',
};

/**
 * 门户里「教务系统」的 appId。
 * **不是猜的**：来自用户 2026-09-16 那次浏览器运行的报告（last-schedule.json 的
 * requests 里那条 openModule.do?appName=b70458c9-…-pc，它返回的就是 /sso/Sudylogin）。
 */
export const SSO_APP_ID = 'b70458c9-6965-4283-8b61-95bb40cd9b42';

/** 门户页面的 _p 令牌，同样来自那次报告里的真实请求。 */
export const PORTAL_P = 'YXM9MiZ0PTUmZD0xMzMmcD0xJmY9MzAmbT1OJg__';

/** 课表接口（页面 xskbcx.js 自己调的，来自那次报告里的真实请求）。 */
export const KB_PATH = '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N253508&sf_request_type=ajax';
/** 课表页（读它自己的学年/学期下拉框）。 */
export const KB_PAGE = '/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N253508&layout=default';

/** 走到哪一层坏了，直接说清楚 */
export const LAYERS = [
  'cookie', // 一个会话都没有
  'gateway', // 网关会话（TWFID）无效
  'portal', // 门户没进去
  'sso', // 门户 → 教务那一跳
  'jwxt', // 正方会话没建起来
  'term', // 读不到学年学期
  'data-api', // 课表接口
  'done',
];

/* ------------------------------------------------------------------ */
/* cookie jar                                                          */
/* ------------------------------------------------------------------ */

function readSession(home, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, file), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 把 CAS 会话和网关会话的 cookie 合并成一张表。
 *
 * 两个文件里的结构都是 `{域名: {cookie名: 值}}` —— **这个形状踩过坑**：
 * 我一度按 `{名: 值}` 去拼，拼出 `域名=[object Object]`，服务器当没登录，
 * 于是拿到一个 302 却得出"域不对"的错误结论。所以这里显式按形状取。
 */
export function mergedJar(home) {
  const jar = new Map();
  const sources = [];
  for (const file of ['session.json', 'vpn-session.json']) {
    const s = readSession(home, file);
    if (!s) continue;
    let n = 0;
    for (const bag of Object.values(s.cookies || {})) {
      for (const [k, v] of Object.entries(bag || {})) {
        jar.set(k, v);
        n += 1;
      }
    }
    if (n) sources.push(file);
  }
  return { jar, sources };
}

/** 建一个会自己吸收 Set-Cookie 的客户端。跟跳用它，不依赖 fetch 的 follow。 */
export function makeClient(jar) {
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (r) => {
    for (const c of r.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };

  /**
   * 手动逐跳跟重定向。
   * 不用 fetch 的 follow：它拿不到中间那些跳的 Set-Cookie，
   * 而会话恰好就是在中间某跳建立的。
   */
  const walk = async (url, { max = 10, method = 'GET', body = '', tag = '' } = {}) => {
    let cur = url;
    const hops = [];
    for (let i = 1; i <= max; i++) {
      const headers = { cookie: cookie(), 'X-Requested-With': 'XMLHttpRequest' };
      const opts = { method, headers, redirect: 'manual' };
      if (body && i === 1) {
        opts.method = 'POST';
        opts.body = body;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      let r;
      try {
        r = await fetch(cur, opts);
      } catch (e) {
        return { ok: false, status: 0, url: cur, text: '', hops, error: e.cause?.code || e.message };
      }
      absorb(r);
      const loc = r.headers.get('location') || '';
      hops.push({ n: i, status: r.status, url: cur, ...(loc ? { to: loc } : {}) });
      if (!loc) {
        const text = await r.text();
        return { ok: r.status === 200, status: r.status, url: cur, text, hops };
      }
      const next = loc.startsWith('http') ? loc : new URL(loc, cur).href;
      // 网关"请先登录"的选路页：校外只有 webvpn.njts.edu.cn 会吐它，而那台我们到不了
      if (/^https:\/\/webvpn\.njts\.edu\.cn(:443)?[/?]/.test(next)) {
        return { ok: false, status: 0, url: next, text: '', hops, blocked: 'gateway-login-required' };
      }
      cur = next;
      if (i === max) return { ok: false, status: 0, url: cur, text: '', hops, error: '跳转过多' };
    }
    return { ok: false, status: 0, url: cur, text: '', hops };
  };

  return { cookie, absorb, walk, get: (u, o) => walk(u, o), post: (u, body, o) => walk(u, { ...o, method: 'POST', body }) };
}

/* ------------------------------------------------------------------ */
/* 全链                                                                */
/* ------------------------------------------------------------------ */

/** 把 `http://jwxt.njts.edu.cn/...` 改写成网关主机。校外直连那个域名是 403。 */
export function rewriteToGate(url) {
  return String(url).replace(
    /^https?:\/\/jwxt\.njts\.edu\.cn(?::\d+)?/i,
    GATE.jwxt.replace(/\/$/, ''),
  );
}

/**
 * 从课表页自己的下拉框里读学年/学期。
 * **不写常量**：读不到就返回空，让调用方报"没有证据"而不是发一个编的参数。
 */
/**
 * 从课表页自己的下拉框里读学年/学期。
 *
 * **不写常量**：读不到就返回空，让调用方报"没有证据"，而不是发一个编的参数。
 *
 * 这里写错过两次，都是"正则不匹配就静默退到第一个选项"：
 *   · 正则写成"先 selected 再 value"，而正方渲染的是
 *     `<option value="2026" selected="selected">2026-2027</option>`（value 在前）；
 *   · 第一个选项是空壳 option（value 是空串），取 value 的正则要求至少一个字符，会跳过它，
 *     于是"第一个选项"静默变成了 2031（最高学年）—— 发出去还是个合法请求，
 *     接口老老实实返回空列表，我差点又报成"课表拿到了"。
 * 所以：逐条取属性，**没有 selected 就返回空**。
 */
export function extractTerm(html) {
  const t = String(html);
  const options = (id) => {
    const m = t.match(new RegExp(`<select[^>]*id=["']?${id}["']?[^>]*>([\\s\\S]*?)</select>`, 'i'));
    if (!m) return [];
    return [...m[1].matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)].map((x) => ({
      value: (x[1].match(/value\s*=\s*["']?([^"'>\s]+)/i) || [, ''])[1].trim(),
      label: x[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
      selected: /\bselected\b/i.test(x[1]),
    }));
  };
  const xn = options('xnm');
  const xq = options('xqm');
  const chosen = (list) => (list.find((o) => o.selected && o.value) || {}).value || '';
  return { xnm: chosen(xn), xqm: chosen(xq), xnmOptions: xn, xqmOptions: xq };
}

/**
 * 走完整条链，拿到正方的课表 JSON。
 * 返回结构里带 hops，坏在哪一层一眼能看出来。
 */
export async function fetchScheduleHttp({
  home,
  onProgress = () => {},
  body = '',
  maxPortalHops = 8,
  maxSsoHops = 12,
} = {}) {
  const out = { home, layer: 'cookie', hops: [], sessions: [], notes: [] };
  const { jar, sources } = mergedJar(home);
  out.sessions = sources;
  out.cookieNames = [...jar.keys()];
  if (!jar.size) {
    out.verdict = `一个会话都没有（${path.join(home, 'session.json')} / vpn-session.json 都读不到）。先跑 njts login 和 njts vpn login。`;
    return out;
  }
  if (!jar.has('TWFID')) {
    out.layer = 'gateway';
    out.verdict = '有 CAS 会话但没有网关会话（TWFID）。先跑 njts vpn login --via-cas。';
    return out;
  }

  const c = makeClient(jar);

  // ① 门户（会自己走 CAS 票据链）
  onProgress('进门户…');
  const portal = await c.walk(`${GATE.portal}/_s2/students_sy/main.psp`, { max: maxPortalHops });
  out.hops.push({ step: 'portal', hops: portal.hops });
  if (!portal.ok) {
    out.layer = portal.blocked ? 'gateway' : 'portal';
    out.verdict = portal.blocked
      ? '门户被网关弹到选路页 —— 网关会话（TWFID）失效了，重新 njts vpn login --via-cas。'
      : `门户没进去（HTTP ${portal.status || portal.error}）。`;
    return out;
  }
  if (!/主门户|博爱塑魂|教务系统/.test(portal.text)) {
    out.layer = 'portal';
    out.verdict = '门户返回了 200，但正文不像门户（可能被踢到登录页）。';
    out.portalHead = portal.text.replace(/\s+/g, ' ').slice(0, 200);
    return out;
  }
  out.portalBytes = portal.text.length;

  // ② 门户自己的 SSO 接口
  onProgress('门户里取教务入口…');
  const sso = await c.walk(
    `${GATE.portal}/mobile/openModule.do?_p=${PORTAL_P}&timeStamp=${Date.now()}`
    + `&appName=${SSO_APP_ID}-pc&screenSize=1800*1169&clientVersion=MacIntel-Chrome-5.0&sf_request_type=ajax`,
    { max: 3 },
  );
  out.hops.push({ step: 'openModule', hops: sso.hops });
  let target = '';
  try {
    const j = JSON.parse(sso.text);
    if (j.result === '1') target = String(j.data || '');
  } catch { /* 不是 JSON 就当没拿到 */ }
  if (!target) {
    out.layer = 'sso';
    out.verdict = '门户没给出教务入口（openModule.do 的返回里没有 data）。';
    out.openModuleHead = String(sso.text || '').replace(/\s+/g, ' ').slice(0, 200);
    return out;
  }
  out.ssoTarget = target;

  // ③ 把 target 的 host 换成网关主机 —— **不要自己拼地址**
  const via = rewriteToGate(target);
  out.ssoVia = via;
  onProgress('门户 → 教务（免密 SSO）…');
  const landed = await c.walk(via, { max: maxSsoHops });
  out.hops.push({ step: 'sso', hops: landed.hops });
  if (!landed.ok || !/教学管理信息服务平台|index_initMenu|功能菜单/.test(landed.text)) {
    out.layer = 'jwxt';
    out.verdict = landed.blocked
      ? 'SSO 那一跳被网关弹回选路页 —— 网关会话失效。'
      : `SSO 走完了但没落到教务（HTTP ${landed.status || landed.error}）。`;
    out.landedUrl = landed.url;
    out.landedHead = String(landed.text || '').replace(/\s+/g, ' ').slice(0, 200);
    return out;
  }
  out.landedUrl = landed.url;
  out.jwxtBytes = landed.text.length;
  out.loggedInAs = (landed.text.match(/>\s*([\u4e00-\u9fa5]{2,4})\s*<\/a>/) || [])[1] || '';

  // ④ 课表页自己的学年/学期
  onProgress('读课表页自己的学年/学期…');
  const page = await c.walk(`${GATE.jwxt}${KB_PAGE}`, { max: maxSsoHops });
  out.hops.push({ step: 'kbPage', hops: page.hops });
  const term = extractTerm(page.ok ? page.text : '');
  out.term = { xnm: term.xnm, xqm: term.xqm };
  if (!term.xnm || !term.xqm) {
    out.layer = 'term';
    out.verdict = '课表页的学年/学期下拉框没读到 —— 没有证据就不发请求，先看 pageHead。';
    out.pageHead = String(page.text || '').replace(/\s+/g, ' ').slice(0, 300);
    return out;
  }
  out.termOptions = { xnm: term.xnmOptions, xqm: term.xqmOptions };

  // ⑤ 课表接口
  onProgress(`取课表（${term.xnm} 学年 学期 ${term.xqm}）…`);
  const payload = body || `xnm=${term.xnm}&xqm=${term.xqm}`;
  const data = await c.walk(`${GATE.jwxt}${KB_PATH}`, { method: 'POST', body: payload, max: 3 });
  out.hops.push({ step: 'kbData', hops: data.hops });
  out.requestBody = payload;
  if (!data.ok) {
    out.layer = 'data-api';
    out.verdict = `课表接口没通（HTTP ${data.status || data.error}）。`;
    return out;
  }
  let json;
  try {
    json = JSON.parse(data.text);
  } catch {
    out.layer = 'data-api';
    out.verdict = '课表接口返回的不是 JSON（可能被弹到登录页）。';
    out.dataHead = String(data.text).replace(/\s+/g, ' ').slice(0, 200);
    return out;
  }
  out.bytes = data.text.length;
  out.student = json.xsxx || {};
  out.kbList = json.kbList || [];
  out.courses = parseKbList(out.kbList);
  out.layer = 'done';
  if (!out.courses.length) {
    // 接口通了、JSON 也合法，但一条课都没有 —— 这**不是成功**。
    // 上一轮就栽在这：学年读错（2031 而不是 2026），接口老老实实返回空列表，
    // 我却报了"课表拿到了：0 条"。空列表先让人去核对学年学期，不许当成果。
    out.layer = 'data-api';
    const label = (out.term.xnmOptions || []).find((o) => o.value === out.term.xnm)?.label || '?';
    out.verdict = `接口通了，但 ${out.term.xnm} 学年（${label}）学期 ${out.term.xqm} 一条课都没有。`
      + '先核对学年/学期下拉框的选中值 —— 别把空列表当结果。';
    out.ok = false;
    return out;
  }
  out.verdict = `课表拿到了：${out.courses.length} 条（${out.student.XNM || ''} 学年，`
    + `${out.student.XM || ''} ${out.student.BJMC || ''}），共 ${out.bytes} 字节 JSON。`;
  out.ok = true;
  return out;
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/**
 * "4-9周" / "4-5周,7-13周,17周" / "第14周" → [4,5,6,7,8,9]
 *
 * 接口给的原文就是这个形状（kbList[].zcd），这里只做展开，不改写。
 */
export function parseWeeks(zcd) {
  const out = new Set();
  for (const m of String(zcd || '').matchAll(/(\d+)\s*(?:[-~至]\s*(\d+))?\s*周/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (!a) continue;
    for (let w = a; w <= Math.max(a, b) && w - a < 40; w += 1) out.add(w);
  }
  return [...out].sort((x, y) => x - y);
}

/** "3-5" / "3-5节" → [3,4,5] */
export function parseSections(jcs) {
  const m = String(jcs || '').match(/(\d+)\s*(?:[-~]\s*(\d+))?/);
  if (!m) return [];
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  const out = [];
  for (let s = a; s <= Math.max(a, b) && s - a < 20; s += 1) out.push(s);
  return out;
}

/**
 * kbList → 课程数组。
 *
 * 字段名全部来自接口原文（2026-09-16 实测的 29 条记录），**没有一个是猜的**：
 *   kcmc 课程名 / xm 教师 / xqj 星期数字 / xqjmc 星期中文 / jcs 节次 / zcd 周次
 *   cdmc 教室 / cdbh 教室全名 / lh 楼 / xqmc 校区 / xf 学分 / zxs 总学时 / zhxs 周学时
 *   jxb_id 教学班号 / jxbmc 教学班名 / jxbzc 教学班组成 / kch 课程号
 *   kclbmc 课程类别 / kcxz 课程性质 / khfsmc 考核方式 / xslxbj 标记（★）
 */
export function parseKbList(kbList = []) {
  return (kbList || []).map((k) => ({
    name: k.kcmc || '',
    teacher: k.xm || '',
    weekday: Number(k.xqj) || 0,
    weekdayName: k.xqjmc || '',
    sections: k.jcs || k.jc || '',
    sectionList: parseSections(k.jcs || k.jc),
    weeks: k.zcd || '',
    weekList: parseWeeks(k.zcd),
    room: k.cdmc || '',
    roomFull: k.cdbh || '',
    building: k.lh || '',
    campus: k.xqmc || '',
    credit: k.xf || '',
    hours: k.zxs || '',
    weeklyHours: k.zhxs || '',
    className: k.jxbmc || '',
    classId: k.jxb_id || '',
    classComposition: k.jxbzc || '',
    courseCode: k.kch || '',
    category: k.kclbmc || '',
    nature: k.kcxz || '',
    exam: k.khfsmc || '',
    mark: k.xslxbj || '',
    // 原始记录照样留着：字段对不上时能对着看，不用再去抓一遍
    raw: k,
  }));
}

/** 按星期分组，给人看的。 */
export function groupByWeekday(courses = []) {
  const byDay = {};
  for (const c of courses) {
    const key = c.weekdayName || `周${c.weekday}`;
    (byDay[key] ||= []).push(c);
  }
  for (const list of Object.values(byDay)) {
    list.sort((a, b) => (a.sectionList[0] || 0) - (b.sectionList[0] || 0));
  }
  return byDay;
}

/**
 * 教务可达性探针 —— 给 `njts status` 用。
 *
 * 取代了旧的 `probeJwxt()`（它直连 `jwxt.njts.edu.cn`，校外一律 403，
 * 于是 status 永远报"不可达、请连 VPN"——**误导了好几轮**）。
 * 现在探的是**网关资源主机**，也就是 `schedule --http` 真正走的那条路。
 *
 * **不拿状态码当结论**：200 只说明收到了响应，还要看正文是不是正方页面
 * （这条规矩是被网关选路页的假 200 教出来的）。
 */
export async function probeJwxt({ home } = {}) {
  const { jar } = mergedJar(home);
  if (!jar.has('TWFID')) {
    return {
      reachable: false,
      verdict: 'no-gateway-session',
      status: null,
      reason: '没有网关会话（TWFID）—— 先跑 njts vpn login --via-cas',
    };
  }
  const c = makeClient(jar);
  const r = await c.walk(`${GATE.jwxt}/jwglxt/xtgl/login_slogin.html`, { max: 4 });
  if (r.blocked === 'gateway-login-required') {
    return {
      reachable: false,
      verdict: 'gateway-login-required',
      status: r.hops?.at(-1)?.status ?? null,
      reason: '网关要求重新登录（网关会话已过期）—— 重跑 njts vpn login --via-cas',
    };
  }
  if (!r.ok) {
    return {
      reachable: false,
      verdict: r.error ? 'network' : `http-${r.status}`,
      status: r.status || null,
      reason: r.error ? `请求失败：${r.error}` : `HTTP ${r.status}`,
    };
  }
  // 200 之后必须看正文特征，不能就此宣布"可达"
  if (/教学管理信息服务平台/.test(r.text)) {
    return {
      reachable: true,
      verdict: 'jwxt-reachable',
      status: 200,
      reason: `网关放行，收到正方页面 ${r.text.length} 字节`,
    };
  }
  return {
    reachable: false,
    verdict: 'unexpected-page',
    status: 200,
    reason: `拿到了 200，但正文不是正方页面（${r.text.length} 字节）`,
  };
}
