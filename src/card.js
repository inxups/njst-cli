/**
 * 一卡通「易通」适配器 —— 浙江正元智慧科技 easytong v5.1.21
 *
 * 协议来自对 H5 静态资源的逆向（plan §1.4 + 登录页 chunk 14），无猜成分：
 *   H5   : http://aggrepay.njts.edu.cn:8080/apps1/easytong_webapp/index.html
 *   API  : http://aggrepay.njts.edu.cn:8080/easytong_app/<Path>   （仅 POST）
 *
 * 每个请求（对应前端 axios 请求拦截器，逐行为准）：
 *   1) Time = yyyymmddhhmmss（缺省自动填）
 *   2) keys = Object.keys(data).sort()          // 此时还没有 ContentType
 *   3) Sign = MD5( keys.map(k=>v).join('|') + '|' + Md5Key )
 *      ↑ 注意 **尾竖线**：前端是 `n += v + "|"` 循环出来的，
 *        所以 Md5Key 前面多一个 "|"。少了它每个请求都会验签失败。
 *   4) 签名算完才 t.Sign = ...，然后才 t.ContentType = 'application/json'
 *      ↑ 所以 **ContentType 和 Sign 都不参与签名**
 *   5) 每个值 encodeURIComponent 后拼 k=v&（不是用 URLSearchParams）
 *   6) 请求头 h5Req: Y；Content-Type: application/x-www-form-urlencoded
 *   7) 登录后额外带 Authorization: <etToken>
 *
 * 密码不是自动加密的——前端在**调用处**显式加密（登录用 3DES + 服务器下发的随机数）。
 * 这里同样在 login() 里显式做，不做"按字段名自动加密"那种魔法。
 *
 * 安全边界（plan §2.3 / §5）：本模块只实现**读接口**。
 * 支付 / 挂失 / 阀控一律不实现，且由 test/safety.test.js 断言源码中不出现。
 */

import crypto from 'node:crypto';
import { desCbcEncrypt, tripleDesCbcEncrypt } from './des.js';
import { HOSTS, requestJson, CookieJar } from './http.js';
import { FILE, readJson, writeJson, removeFile } from './store.js';
import { unauthenticated, loginFailed, serviceError, inputError } from './errors.js';

// ---------------------------------------------------------------- 常量（改版只需改这里）

export const CARD = {
  base: `${HOSTS.card}/easytong_app`,
  md5Key: 'ok15we1@oid8x5afd@',
  keyCrypto: '12347890', // DES-CBC 的 key 与 iv（同值）
  keyCryptoPhone: '12347890', // 登录用 3DES 的 **iv**（key 是服务器下发的随机数）
  keyCryptoWater: '00000000',
  /** 前端 encryptBy3DESModeCBC 会把 key 补齐到 24 字节；随机数按 24 位补零 */
  loginKeyLength: 24,
  h5Url: `${HOSTS.card}/apps1/easytong_webapp/index.html#/login?epid=1`,
};

/** 读接口白名单：只有这些路径允许出现在代码里 */
export const READ_PATHS = {
  login: '/H5Login',
  sendMsgCode: '/SendMsgCode',
  randomNumber: '/GetRandomNumber',
  sysParams: '/GetSysParams',
  walletMoney: '/GetWalletMoney',
  walletInfo: '/GetWalletInfo',
  accInfo: '/GetAccInfo',
  accCardInfo: '/GetAccCardInfo',
  consumptionDetail: '/GetConsumptionDetail',
  dealRec: '/GetDealRec',
  dealSum: '/GetDealSum',
  rechargeDetail: '/GetRechargeDetail',
  pendingItemH5: '/GetPendingItemH5New',
  pendingItem: '/GetPendingItemNew',
  pendingFeeList: '/GetPendingFeeListNew',
  payAccInfoNew: '/GetPayAccInfoNew',
  transferOutWalletNew: '/GetTransferOutWalletNew',
  roomInfo: '/GetRoomInfo',
  buildingInfo: '/GetBuildingInfoByAreaNo',
  notice: '/GetNotice',
};

// ---------------------------------------------------------------- 签名 / 编码

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * 生成签名与表单体。顺序（对应前端 axios 请求拦截器）：
 *   1. 补 Time
 *   2. 按 key 排序，值用 "|" 连接并**再补一个尾竖线**，后面接 Md5Key，取 MD5
 *   3. 签名算完之后才加 ContentType（所以它不参与签名）
 *   4. 每个值 encodeURIComponent 后拼成 k=v&
 *
 * 注意第 2 步的尾竖线：前端写的是 `for(...) n += v + "|"`，所以最终是
 * `"v1|v2|v3|" + Md5Key`。少了这一竖线，服务端验签必失败（实测返回 Tomcat 400）。
 *
 * 第 4 步也不要用 URLSearchParams：每个值分别 encodeURIComponent，
 * 这样 `!~*'()` 这类字符的编码方式与前端完全一致。
 */
export function buildSignedBody(input, { time } = {}) {
  const params = { ...input };
  if (!params.Time) params.Time = time || timestamp();

  const sortedKeys = Object.keys(params).sort();
  const joined = `${sortedKeys.map((k) => params[k]).join('|')}|`;
  params.Sign = md5(joined + CARD.md5Key);
  params.ContentType = 'application/json';

  const body = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

  return { body, params };
}

/** 把服务器下发的随机数补齐到 24 位——3DES 的密钥就是它 */
export function loginKeyFrom(random) {
  const s = String(random || '');
  if (!s) throw serviceError('服务器未返回随机数', '无法构造登录密钥');
  if (s.length > CARD.loginKeyLength) {
    throw serviceError(`随机数长度异常（${s.length} > ${CARD.loginKeyLength}）`, '学校系统可能改版，请反馈');
  }
  return s + '0'.repeat(CARD.loginKeyLength - s.length);
}

/**
 * 从服务端文案里抽剩余尝试次数（如"密码错误，还可以输入5次"）。
 * 抽出来单独返回，是因为它比报错本身重要得多——决定"还能不能再试"。
 */
export function parseRemainingAttempts(message) {
  const m = /还可以输入\s*(\d+)\s*次/.exec(String(message || ''));
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- 客户端

export class CardClient {
  constructor({ jar, token, accNum = '', epid = null, debug = false } = {}) {
    /**
     * cookie jar 是**必须的**，不是可选项：
     *   /GetRandomNumber 会在服务端 session 里存下那个随机数，
     *   /H5Login 靠 session 把它取回来。不带 cookie 就会得到
     *   "随机数为空或session不一致"（已实测）。
     */
    this.jar = jar || new CookieJar();
    this.token = token || '';
    /**
     * AccNum 是**卡号账户号**，不是学号——它只出现在 /H5Login 的响应里。
     * EPID 是单位号，要拿 AccNum 再调 /GetAccInfo 才拿得到。
     * 两个都必须持久化：除登录外的每个读接口都要带（实测漏了就是 Tomcat 400）。
     */
    this.accNum = accNum || '';
    this.epid = epid;
    this.debug = debug;
    this.log = debug ? (msg) => process.stderr.write(`[card] ${msg}\n`) : () => {};
  }

  static load() {
    const state = readJson(FILE.cardSession, {});
    const client = new CardClient({
      jar: CookieJar.fromJSON(state),
      token: state.token,
      accNum: state.accNum,
      epid: state.epid,
      debug: !!process.env.NJTS_DEBUG,
    });
    // 自愈：早期版本的会话只存了 token 没存 etToken cookie。
    // 在这里补齐，旧会话不用重新登录（全程不对凭据做任何输出）。
    if (client.token && !client.jar.has('etToken')) {
      client.jar.absorb(`${CARD.base}${READ_PATHS.login}`, [`etToken=${client.token}; Path=/`]);
    }
    return client;
  }

  get authenticated() {
    return Boolean(this.token);
  }

  save() {
    try {
      writeJson(FILE.cardSession, {
        ...this.jar.toJSON(),
        token: this.token,
        accNum: this.accNum,
        epid: this.epid,
        at: Date.now(),
      });
    } catch (err) {
      // 会话落盘是**尽力而为**，不能让它拖垮整个命令：
      // 例如 pi 沙盒只放行了 ~/.njts-cli 的读权限（写会 EROFS），
      // 而只读查询根本不需要写盘——旧会话文件读得到就够了。
      this.log(`会话未能落盘（${err.code || err.message}），不影响本次查询`);
    }
  }

  /**
   * 账号维度参数。几乎所有读接口都要 { AccNum, EPID }，
   * 而前端各页面写法不一致（有的 EPID 用真值、有的写 0），这里统一给真值，
   * 拿不到时回落 0（与登录后首次查流水的写法一致）。
   */
  accountParams(extra = {}) {
    return { AccNum: this.accNum, EPID: this.epid ?? 0, ...extra };
  }

  static forget() {
    return removeFile(FILE.cardSession);
  }

  /** 调用一个接口。path 必须在 READ_PATHS 白名单内。 */
  async call(path, params = {}, opts = {}) {
    if (!Object.values(READ_PATHS).includes(path)) {
      throw serviceError(`未在白名单内的接口，已拒绝调用：${path}`, '本工具只实现只读接口');
    }
    const { body } = buildSignedBody(params, opts);
    this.log(`POST ${path} fields=${body.split('&').map((p) => p.split('=')[0]).join(',')}`);

    const json = await requestJson({
      url: `${CARD.base}${path}`,
      method: 'POST',
      headers: {
        h5Req: 'Y',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(this.token ? { Authorization: this.token } : {}),
      },
      body,
      jar: this.jar,
    });
    this.log(`<- ${JSON.stringify(json).slice(0, 300)}`);
    // 服务端可能在任意一个响应里下发/轮换 cookie（登录握手就靠它），所以要落盘
    this.save();
    return json;
  }

  /** 统一处理易通的成功/失败约定：**code === 1 才是成功**，40004 = 登录态失效 */
  async callChecked(path, params = {}, opts = {}) {
    const json = await this.call(path, params, opts);
    const code = String(json?.code ?? json?.Code ?? '');
    if (code === '1' || json?.success === true) return json;

    const msg = json?.msg || json?.message || JSON.stringify(json).slice(0, 200);
    if (code === '40004') {
      throw unauthenticated('一卡通会话已失效（40004）', '请重新执行 njts card login');
    }
    throw serviceError(`一卡通接口返回失败：${msg}`, `接口 ${path}，code=${code || '(无)'}`);
  }

  // -------------------------------------------------------------- 业务方法

  /** 服务器参数（登录前可读）：isScp / onlyPhoneNum / isPhoneLogin 等 */
  async sysParams() {
    return this.callChecked(READ_PATHS.sysParams, {});
  }

  /** 取登录用的随机数——它同时是 3DES 的密钥，所以每次登录都必须重新取 */
  async randomNumber() {
    const json = await this.callChecked(READ_PATHS.randomNumber, {});
    return loginKeyFrom(json?.random ?? json?.Random ?? '');
  }

  /**
   * 登录。凭据是 **学号 + 一卡通单独密码**（不是统一身份认证密码）。
   *
   * 真实流程（来自登录页 chunk）：
   *   1) POST /GetRandomNumber → { code:1, random } （无参数，但一样要签名）
   *   2) key24 = random 末尾补 '0' 到 24 位
   *   3) PassWord = 3DES-CBC-PKCS7(密码, key=key24, iv="12347890") → Base64
   *   4) POST /H5Login { TypeNum:1, UserNumber, PassWord [, EPID] }
   *   5) 响应 { code:1, token, AccNum, isDefaultPWD } → etToken
   */
  async login({ user, password, epid, allowAnyLength = false } = {}) {
    if (!user || !password) throw inputError('缺少学号或一卡通密码');

    // 提交前的最后一道闸：一卡通密码是 6 位数字（前端文案 pwdCombine:"密码由6位数字组成"，
    // 找回密码流程也是这个限制）。长度不对多半是敲错了，
    // 而服务端只会回"密码错误"并扣一次机会——所以宁可在这里就拦住，一次网络请求都不发。
    if (!allowAnyLength && !/^\d{6}$/.test(password)) {
      throw inputError(
        `一卡通密码应为 6 位数字，收到 ${password.length} 位`,
        '为避免浪费一次失败机会，本次没有提交任何请求。请重新输入 6 位数字的一卡通密码' +
          '（注意不是统一身份认证密码，也不是银行卡密码）。若确实不是 6 位，加 --any-length 重试。',
      );
    }

    // 是否需要单位号（EPID）由 /GetSysParams 的 isScp 决定；这一步不涉及密码，
    // 失败也没关系（拿不到就按不需要 EPID 处理）。
    let needEpid = false;
    let isScp = null;
    try {
      const sp = await this.sysParams();
      isScp = sp?.isScp ?? null;
      needEpid = String(sp?.isScp) === '1';
      this.log(`sysParams isScp=${sp?.isScp} needEpid=${needEpid}`);
    } catch (err) {
      this.log(`sysParams 不可用，按无需 EPID 继续：${err.message}`);
    }

    const key24 = await this.randomNumber();
    const randomLen = key24.replace(/0+$/, '').length; // 服务器给的原始随机数长度
    const encrypted = tripleDesCbcEncrypt(password, key24, CARD.keyCryptoPhone);

    const params = { TypeNum: 1, UserNumber: user, PassWord: encrypted };
    if (needEpid) params.EPID = epid || '1';

    const json = await this.call(READ_PATHS.login, params);
    const code = String(json?.code ?? json?.Code ?? '');
    const token = json?.token || json?.Token || json?.data?.token || json?.etToken || '';

    if (!token) {
      const msg = json?.msg || json?.message || '未返回 token';
      // 服务端会在文案里报剩余尝试次数（如"密码错误，还可以输入5次"）。
      // 这是一卡通最珍贵的信息：把它单独抽出来，别让它埋在 message 里被忽略。
      const remaining = parseRemainingAttempts(msg);
      const diag = `isScp=${isScp} 用了EPID=${needEpid} 随机数长度=${randomLen} 学号长度=${String(user).length}`;
      const hint = remaining
        ? `密码错误。**只剩 ${remaining} 次机会**，锁号后只能去一卡通中心解锁——先确认密码再试，不要连试。（诊断：${diag}）`
        : `请确认使用的是一卡通密码（6 位数字，不是统一身份认证密码）；连续失败会锁号，不要反复重试（诊断：${diag}）`;
      const err = loginFailed(`一卡通登录失败（code=${code || '无'}）：${msg}`, hint);
      err.remainingAttempts = remaining;
      err.diagnostics = { isScp, usedEpid: needEpid, keyLength: key24.length, randomLen };
      throw err;
    }
    this.token = token;
    this.accNum = json?.AccNum || '';
    /**
     * etToken 必须**同时**作为 Cookie 发出去。
     * 前端登录成功后是 `$cookie.set("etToken", token, {expires:"200Y"})`——
     * 写的是 document.cookie，所以浏览器在后续每个请求上都会带上 `Cookie: etToken=…`；
     * 拦截器再把同一个值放进 Authorization 头。两个都发才是真实客户端行为。
     */
    this.jar.absorb(`${CARD.base}${READ_PATHS.login}`, [`etToken=${token}; Path=/`]);

    // 拿 EPID（前端 login → getUserInfo 那一步）。失败不致命：
    // 部分接口用 EPID:0 也能过，拿不到就回落 0。
    try {
      const info = await this.callChecked(READ_PATHS.accInfo, { AccNum: this.accNum });
      this.epid = info?.epid ?? null;
      this.accName = info?.accName;
    } catch (err) {
      this.log(`GetAccInfo 失败（不影响登录）：${err.message}`);
    }

    this.save();
    return { token, code, isDefaultPWD: json?.isDefaultPWD, accNum: this.accNum, epid: this.epid, raw: json };
  }
  async walletMoney() {
    return this.callChecked(READ_PATHS.walletMoney, this.accountParams());
  }

  async walletInfo() {
    return this.callChecked(READ_PATHS.walletInfo, this.accountParams());
  }

  async accInfo() {
    return this.callChecked(READ_PATHS.accInfo, { AccNum: this.accNum });
  }

  /**
   * 消费流水（按月份分组）。对应 /bill 页的 queryBill。
   * BeginRecNum 从 1 开始，Count 是每页条数；返回的 list[].dealDetail[] 才是平铺的流水。
   */
  async dealRec({
    beginRecNum = 1,
    count = 20,
    typeNum = '-1',
    cardAccNum = '-1',
    walletNum = '0',
    yearMonth,
    feeNum,
  } = {}) {
    return this.callChecked(READ_PATHS.dealRec, this.accountParams({
      CardAccNum: cardAccNum,
      WalletNum: walletNum,
      TypeNum: typeNum,
      BeginRecNum: beginRecNum,
      Count: count,
      ...(yearMonth ? { YearMonth: yearMonth } : {}),
      ...(feeNum ? { FeeNum: feeNum } : {}),
    }));
  }

  /** 单条流水的详情，参数只有流水号（对应 /recDetail 页） */
  async consumptionDetail({ payRecNum }) {
    if (!payRecNum) throw inputError('缺少 payRecNum', '消费明细详情必须带流水号');
    return this.callChecked(READ_PATHS.consumptionDetail, { PayRecNum: payRecNum });
  }

  /** 月度收支合计 */
  async dealSum({ month, type = 0 } = {}) {
    return this.callChecked(READ_PATHS.dealSum, this.accountParams({ Month: month, Type: type }));
  }

  /** 待缴费项目列表（生活缴费 → 电费等），对应 /itemList 页 */
  async pendingItems() {
    try {
      return await this.callChecked(READ_PATHS.pendingItemH5, this.accountParams());
    } catch (err) {
      if (err.kind !== 'service') throw err;
      this.log('GetPendingItemH5New 失败，退化尝试 GetPendingItemNew');
      return this.callChecked(READ_PATHS.pendingItem, this.accountParams());
    }
  }

  async rooms() {
    return this.callChecked(READ_PATHS.roomInfo, this.accountParams());
  }

  async buildings({ areaNo } = {}) {
    return this.callChecked(READ_PATHS.buildingInfo, this.accountParams(areaNo ? { AreaNo: areaNo } : {}));
  }

  // ------------------------------------------------------ 宿舍电费发现链

  /**
   * 缴费项目的**详情结构**（含园区列表 / 需要选几级 / 是否需要查询）。
   * 与 pendingItems() 不同：那个只给项目名，这个给到"怎么选到具体房间"。
   */
  async pendingItemDetail({ itemNum }) {
    if (!itemNum) throw inputError('缺少 itemNum', '用 njts power list 先看项目号');
    return this.callChecked(READ_PATHS.pendingItem, { AccNum: this.accNum, ItemNum: itemNum });
  }

  /** 园区 → 楼栋 */
  async buildingsByArea({ areaNo, itemNum }) {
    return this.callChecked(READ_PATHS.buildingInfo, { AreaNo: areaNo, ItemNum: itemNum });
  }

  /** 楼栋 → 房间（或先到楼层，取决于该楼是否分层） */
  async roomsByBuilding({ areaNo, buildingNo, itemNum, floorNo }) {
    return this.callChecked(READ_PATHS.roomInfo, {
      AreaNo: areaNo,
      BuildingNo: buildingNo,
      ItemNum: itemNum,
      ...(floorNo !== undefined && floorNo !== null && floorNo !== '' ? { FloorNo: floorNo } : {}),
    });
  }

  /**
   * 剩余电费。这里返回的 balance 就是前端页面上那个"剩余电费(元)"。
   * 注意 AccNum 传的是 "0"（前端就是这么写的）——它查的是房间不是账户。
   */
  async payAccInfo({ areaNo, buildingNo, itemNum, roomNo, floorNo = '0' }) {
    return this.callChecked(READ_PATHS.payAccInfoNew, {
      AccNum: '0',
      AreaNo: areaNo || '0',
      BuildingNo: buildingNo || '0',
      FloorNo: floorNo || '0',
      ItemNum: itemNum,
      RoomNo: roomNo || '0',
    });
  }

  /** 可用于缴费的钱包（卡）列表 */
  async payWallets({ itemNum }) {
    return this.callChecked(READ_PATHS.transferOutWalletNew, this.accountParams({ ItemNum: itemNum }));
  }

  /**
   * 通知公告。
   *
   * ⚠️ **实测这个接口在本校服务端是坏的，不要用它**（2026-09-15）：
   *   GET  /easytong_app/GetNotice → 405 方法不允许（说明路径存在、只收 POST）
   *   POST 任意形状（空体 / 空表单 / 带 AccNum / 带 h5Req+Authorization）→ 均返 Tomcat 400 错误的请求
   * 对照：同一时刻 /GetWalletMoney 正常返回 code=1，所以不是会话或签名的问题。
   * CLI 已移除 card services 命令；此方法保留仅作情报记录，需要时再试。
   */
  async notice() {
    return this.callChecked(READ_PATHS.notice, {});
  }
}

// ---------------------------------------------------------------- 工具

/** 从易通返回里稳健地取数组（字段名各接口不统一，且 Table 有时是对象） */
export function pickTable(json) {
  const candidates = [json?.Table, json?.data?.Table, json?.rows, json?.data?.rows, json?.data, json?.list];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === 'object') return [c];
  }
  return [];
}

/** 从易通返回里稳健地取单个数值（如余额） */
export function pickNumber(json, keys) {
  const pools = [json, json?.data, json?.Table, json?.data?.Table];
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    for (const k of keys) {
      const v = pool[k];
      if (v == null) continue;
      const n = Number(String(v).replace(/[^\d.-]/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
