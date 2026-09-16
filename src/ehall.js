/**
 * 办事大厅 / 学工（金智教育 wisedu ehall）
 *
 *   http://ehall.njts.edu.cn          仅 HTTP（HTTPS 无监听，见 plan §1.3）
 *   /jsonp/checkLogin                 未登录 → 跳统一身份认证
 *   /jsonp/serviceRoleApp.json        ?serviceRoleId=1__0 → 学生可见服务清单（含 appId）
 *   /jsonp/appInfo.json               ?appId=... → 服务详情
 *
 * 请假走金智 WeCMP（同一域名）：
 *   POST /wec-apis/leave/stu/query
 *   契约见 plan §1.5：
 *     userIds        学号列表 —— **为空则查全校，所以永远只传自己**
 *     needFlow       true 才返回审批流程信息
 *     pageNumber/pageSize（必填，≤500）
 *     needDeleted    0
 *   限流：按 appId 1 qps
 */

import { HOSTS, request, requestJson } from './http.js';
import { CAS } from './cas.js';
import { unauthenticated, serviceError, inputError } from './errors.js';

export const EHALL = {
  base: HOSTS.ehall,
  service: `${HOSTS.ehall}/`,
  checkLogin: '/jsonp/checkLogin',
  serviceRoleApp: '/jsonp/serviceRoleApp.json',
  appInfo: '/jsonp/appInfo.json',
  leaveQuery: '/wec-apis/leave/stu/query',
  appId: 'd7de360368c94a808225', // 今日校园客户端公共 appId（plan §1.5）
  roleStudent: '1__0',
};

export class EhallClient {
  constructor({ session, debug = false } = {}) {
    this.session = session;
    this.debug = debug;
    this.log = debug ? (m) => process.stderr.write(`[ehall] ${m}\n`) : () => {};
  }

  /**
   * 确保已登录 ehall。
   *
   * 关键：办事大厅的登录入口**不是** CAS 直连，而是金智自己的 SAML SP：
   *   /jsonp/checkLogin → /amp-auth-adapter/login → CAS（用已有 TGT）
   *   → /amp-auth-adapter/loginSuccess?sessionToken=… → /jsonp/checkLogin?ticket=… → 落地会话 cookie
   * 所以必须**从头把整条链跟完**（redirect:'follow'，由 http.js 逐跳带 cookie 并吸收 Set-Cookie）。
   * 之前用 cas.visit(service) 是错的：那条路能换到 CAS 票据，但落不了办事大厅的会话，
   * 结果就是“CAS 登录成功、ehall 永远是未登录”。
   */
  async ensureLogin(casSession) {
    const cas = casSession || this.session;
    if (!cas) throw unauthenticated('统一身份认证会话', '请先执行 njts login');

    this.log('走金智 SAML 链建立办事大厅会话（checkLogin → amp-auth-adapter → CAS → loginSuccess）');
    await request({ url: `${EHALL.base}${EHALL.checkLogin}`, jar: cas.jar, redirect: 'follow' });
    return this;
  }

  /** 学生可见的服务清单 —— 顺便能看到请假服务的 appId */
  async serviceList({ roleId = EHALL.roleStudent } = {}) {
    const json = await requestJson({
      url: `${EHALL.base}${EHALL.serviceRoleApp}?serviceRoleId=${roleId}`,
      jar: this.session.jar,
    });
    if (json?.hasLogin === false) {
      throw unauthenticated('办事大厅会话', '请先执行 njts login 再重试');
    }
    const collect = (list) => (Array.isArray(list) ? list : []);
    return {
      hasLogin: json?.hasLogin !== false,
      recommend: collect(json?.recommendAndNewAppList),
      hot: collect(json?.hotServiceList),
      categories: collect(json?.categoryList),
    };
  }

  /** 在服务清单里按关键字找服务（如「请假」「考勤」） */
  async findServices(keyword) {
    const list = await this.serviceList();
    const flat = [];
    for (const item of [...list.recommend, ...list.hot]) flat.push(item);
    for (const cat of list.categories) {
      for (const app of cat?.apps || cat?.appList || []) flat.push(app);
    }
    const kw = String(keyword);
    return flat.filter((a) => JSON.stringify(a).includes(kw));
  }

  async appInfo(appId) {
    if (!appId) throw inputError('缺少 appId');
    return requestJson({ url: `${EHALL.base}${EHALL.appInfo}?appId=${encodeURIComponent(appId)}`, jar: this.session.jar });
  }

  // -------------------------------------------------------------- 请假

  /**
   * 查询请假记录（只读）。
   * @param {object} opts
   * @param {string} opts.userId 自己的学号 —— 必填，避免误查全校
   * @param {boolean} [opts.needFlow=true] 是否取审批流程信息
   */
  async leaveQuery({ userId, needFlow = true, pageNumber = 1, pageSize = 20, needDeleted = 0 } = {}) {
    if (!userId) throw inputError('缺少学号（userIds）', '本工具只查询当前登录者自己的请假记录，不接受空值——空值在服务端表示"查全校"');

    const json = await requestJson({
      url: `${EHALL.base}${EHALL.leaveQuery}`,
      method: 'POST',
      jar: this.session.jar,
      headers: { 'Content-Type': 'application/json', appId: EHALL.appId },
      body: { userIds: [String(userId)], needFlow, pageNumber, pageSize, needDeleted, needTotalSize: true },
    });

    const status = String(json?.status ?? '');
    if (status && status !== '0') {
      const msg = json?.message || '未知错误';
      if (/登录|未授权|token|auth/i.test(msg)) throw unauthenticated('办事大厅会话', '请重新执行 njts login');
      throw serviceError(`请假接口返回失败（status=${status}）：${msg}`, '若提示 appId/签名问题，可能需要额外的 appId 头');
    }

    const leaveTypes = Object.fromEntries((json?.leaveTypes || []).map((t) => [String(t.code), t.name]));
    const records = (json?.datas || []).map((row) => normalizeLeave(row, leaveTypes));
    return { records, leaveTypes, totalSize: json?.totalSize ?? records.length, raw: json };
  }
}

/** 把 WeCMP 的 Leave 结构归一化成 CLI 对外契约 */
export function normalizeLeave(row = {}, leaveTypes = {}) {
  const typeCode = String(row.leaveType ?? row.type ?? '');
  const flow = row.flow || row.flows || row.approveFlow || row.auditList || null;
  const current = pickCurrentApproval(flow);

  return {
    id: row.id ?? row.wid ?? row.leaveId ?? '',
    type: leaveTypes[typeCode] || row.leaveTypeName || typeCode || '',
    typeCode,
    startTime: row.startTime ?? row.leaveStartTime ?? row.beginTime ?? '',
    endTime: row.endTime ?? row.leaveEndTime ?? row.finishTime ?? '',
    days: row.days ?? row.leaveDays ?? row.duration ?? null,
    reason: row.reason ?? row.leaveReason ?? '',
    status: row.status ?? row.leaveStatus ?? '',
    statusText: row.statusName ?? row.statusText ?? '',
    currentApprover: current.approver,
    currentStatus: current.status,
    needRecall: Boolean(row.needRecall ?? row.needXiaojia ?? false),
    flow: flow || null,
  };
}

/** 从审批流程里找"当前卡在谁那里" */
export function pickCurrentApproval(flow) {
  const nodes = Array.isArray(flow) ? flow : flow?.nodes || flow?.list || [];
  if (!Array.isArray(nodes) || nodes.length === 0) return { approver: '', status: '' };
  const pending = nodes.find((n) => /待|pending|0|审核中|处理中/i.test(String(n.status ?? n.state ?? '')));
  const node = pending || nodes[nodes.length - 1];
  return {
    approver: node.approverName ?? node.operator ?? node.userName ?? node.approver ?? '',
    status: node.statusName ?? node.status ?? node.state ?? '',
  };
}

/** 便于 CLI 复用的单例工厂 */
export function ehallFor(casSession, debug = false) {
  return new EhallClient({ session: casSession, debug });
}

export { CAS };
