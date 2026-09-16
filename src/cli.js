/**
 * CLI 入口：参数解析与命令分发。
 *
 * 输出契约（plan §3）：
 *   stdout 恒为单个 JSON 对象
 *     成功 {"ok":true,"data":{...}}
 *     失败 {"ok":false,"error":{"kind","message","hint"}}
 *   stderr 放人类可读信息
 *   非交互环境需要输入时立即报错，不阻塞
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { NjtsError, EXIT, unsupported, inputError, unauthenticated, networkError, serviceError } from './errors.js';

/** kind → 构造函数。让"坏在哪一层"能直接翻成契约里的退出码（见 errors.js 的 EXIT）。 */
const KIND = { unauthenticated, network: networkError, service: serviceError };
import { FILE, ROOT, readJson, writeJson, appendSnapshot, readSnapshots, ensureDir } from './store.js';
import { CasSession, CAS } from './cas.js';
import { EhallClient, EHALL } from './ehall.js';
import { CardClient, CARD, pickNumber } from './card.js';
import { setVpnSession } from './http.js';
import { VpnSession, VPN, GATE_HOSTS } from './vpn.js';
import { fetchScheduleHttp, groupByWeekday, probeJwxt } from './gateway.js';
import { buildIcs } from './ics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_SRC = path.join(__dirname, '..', 'skills', 'njts', 'SKILL.md');
const DATA_DIR = path.join(__dirname, '..', 'data');

// ---------------------------------------------------------------- 参数解析

/** 这些 flag 天生不带值，不消耗下一个 token */
const BOOLEAN_FLAGS = new Set(['debug', 'no-flow', 'help', 'json', 'pretty', 'refresh', 'remember', 'any-length', 'launch', 'gui', 'purge', 'no-probe', 'via-portal', 'no-wait', 'direct']);

export function parseArgs(argv) {
  const flags = {};
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token.startsWith('--')) {
      const [key, ...valueParts] = token.slice(2).split('=');
      if (valueParts.length) {
        flags[key] = valueParts.join('=');
      } else if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else {
        const next = argv[i + 1];
        // `--flag value` 形式：下一个 token 不像 flag 就当作值
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (token.startsWith('-') && token.length === 2) {
      flags[token.slice(1)] = true;
    } else {
      rest.push(token);
    }
  }
  return { flags, rest };
}

const flag = (flags, ...names) => names.map((n) => flags[n]).find((v) => v !== undefined && v !== true) ?? (names.some((n) => flags[n] === true) ? true : undefined);

// ---------------------------------------------------------------- 交互输入

/**
 * 提示输入并回显（用于学号这种非敏感字段）。
 * 非 TTY 直接报错，不要让命令挂在那里等一个永远不来的输入。
 */
async function promptVisible(label) {
  if (!process.stdin.isTTY) {
    throw inputError('非交互环境无法输入', '请在终端里手动执行，或用 NJTS_USER / NJTS_PASS 等环境变量');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(label, resolve));
    return String(answer).trim();
  } finally {
    rl.close();
  }
}

/**
 * 提示输入密码，**不回显**（每敲一个字符只打一个 `*`）。
 *
 * 用 raw mode 手写循环而不是 readline：readline 没有官方的隐藏输入支持，
 * 而那套改 `rl._writeToOutput` 的土办法在 Node 各版本上行为不一致。
 * raw mode 下退格、Ctrl-C 都得自己处理，所以下面看着长。
 */
async function promptHidden(label) {
  if (!process.stdin.isTTY) {
    throw inputError('非交互环境无法输入密码', '请在终端里手动执行，或改用 NJTS_PASS / NJTS_CARD_PASS / NJTS_VPN_PASS 环境变量');
  }

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  process.stdout.write(label);

  return new Promise((resolve, reject) => {
    let buf = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        /* 某些终端不支持还原，忽略 */
      }
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl-C：不要把密码留在 buf 里
          cleanup();
          reject(inputError('已取消输入'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        // 忽略其它控制字符，避免把方向键之类的转义序列吃进密码
        if (ch < ' ') continue;
        buf += ch;
        process.stdout.write('*');
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}


// ---------------------------------------------------------------- 会话装载

function loadOrThrow(loader, message, hint) {
  const session = loader();
  if (!session) throw new NjtsError('unauthenticated', message, hint);
  return session;
}

async function ensureEhall(cas, debug) {
  const client = new EhallClient({ session: cas, debug });
  await client.ensureLogin(cas);
  return client;
}

// ---------------------------------------------------------------- 命令

const commands = {
  // -------------------------------------------------------------- 认证
  async login(args) {
    const { flags } = args;
    const user = flag(flags, 'user', 'u') || process.env.NJTS_USER || (await promptVisible('学号 / 工号: '));
    const password = flag(flags, 'password', 'p') || process.env.NJTS_PASS || (await promptHidden('统一身份认证密码: '));
    if (!password) throw inputError('未提供密码');

    const existing = CasSession.load() || new CasSession({ passwordMode: flag(flags, 'password-mode') || 'auto' });
    const result = await existing.login({ user, password, service: EHALL.service, passwordMode: flag(flags, 'password-mode') });
    return {
      user,
      service: EHALL.service,
      passwordMode: result.passwordMode,
      note: result.passwordMode === 'plain'
        ? '本次为明文提交（尚未确认 CAS 是否要求加密）。若登录失败，请提供 /cas/js/security.js 内容。'
        : '',
      store: FILE.session,
    };
  },

  async whoami() {
    const cas = loadOrThrow(CasSession.load, '尚未登录', '请先执行 njts login');
    let ehall = null;
    try {
      const client = await ensureEhall(cas, false);
      ehall = await client.serviceList();
    } catch {
      ehall = null;
    }
    return {
      user: cas.user,
      casSession: cas.authenticated,
      ehallSession: Boolean(ehall?.hasLogin),
      serviceCount: ehall ? ehall.recommend.length + ehall.hot.length : null,
    };
  },

  async logout() {
    CasSession.forget();
    CardClient.forget();
    return { cleared: [FILE.session, FILE.cardSession] };
  },

  // -------------------------------------------------------------- 体检
  async status(args) {
    const debug = Boolean(args.flags.debug);
    const report = { vpn: null, cas: null, ehall: null, card: null, jwxt: null };

    const jwxt = await probeJwxt({ home: ROOT });
    report.jwxt = jwxt;
    // vpn 一栏只说"教务这条路通不通"，并把依据（状态码 / 结论）一并给出来。
    // 两条老教训都在这：① 不再把"收到了 HTTP 响应"当成"已连 VPN"（403 就被误报成通）；
    // ② 现在探的是网关资源主机（schedule --http 走的路），不是校外直连的 jwxt.njts.edu.cn。
    report.vpn = jwxt.reachable
      ? { ok: true, verdict: jwxt.verdict, status: jwxt.status ?? null, note: jwxt.reason }
      : {
          ok: false,
          verdict: jwxt.verdict,
          status: jwxt.status ?? null,
          note: jwxt.reason,
          // 别再写"请连 VPN"了 —— 教务从来不是靠连 VPN 取到的，是靠网关会话。
          hint: '教务走网关会话：先 njts vpn login --via-cas，再 njts schedule --http',
        };

    const cas = CasSession.load();
    if (!cas) {
      report.cas = { ok: false, note: '未登录，执行 njts login' };
    } else {
      report.cas = { ok: cas.authenticated, user: cas.user, note: cas.authenticated ? '会话存在' : '会话为空，请重新登录' };
      if (cas.authenticated) {
        try {
          const client = await ensureEhall(cas, debug);
          const list = await client.serviceList();
          report.ehall = { ok: true, services: list.recommend.length + list.hot.length };
        } catch (err) {
          report.ehall = { ok: false, note: `${err.kind}: ${err.message}` };
        }
      }
    }

    const card = CardClient.load();
    if (!card.authenticated) {
      report.card = { ok: false, note: '未登录一卡通，执行 njts card login' };
    } else {
      report.card = { ok: true, note: 'etToken 已存在（未验证有效性）' };
    }

    const ready = [report.cas?.ok, report.card?.ok].filter(Boolean).length;
    return { ...report, summary: `${ready}/2 个会话可用`, configDir: ROOT };
  },

  // -------------------------------------------------------------- 一卡通
  async card(args) {
    const [sub, ...rest] = args.rest;
    const { flags } = args;
    const debug = Boolean(flags.debug);

    if (sub === 'login') {
      const user = flag(flags, 'user', 'u') || process.env.NJTS_CARD_USER || (await promptVisible('学号: '));
      const password = flag(flags, 'password', 'p') || process.env.NJTS_CARD_PASS || (await promptHidden('一卡通密码（不是统一身份认证密码）: '));
      if (!password) throw inputError('未提供一卡通密码');
      if (flag(flags, 'remember', 'r') !== false) writeJson(FILE.cardCredentials, { user });

      const client = new CardClient({ debug });
      const result = await client.login({
        user,
        password,
        epid: flag(flags, 'epid'),
        allowAnyLength: flag(flags, 'any-length') === true,
      });
      return {
        loggedIn: true,
        user,
        tokenStored: FILE.cardSession,
        isDefaultPWD: result.isDefaultPWD,
        note: result.isDefaultPWD ? '这是初始密码，建议尽快修改' : '',
      };
    }

    if (sub === 'logout') {
      CardClient.forget();
      return { cleared: FILE.cardSession };
    }

    const client = CardClient.load();
    client.debug = debug;
    if (!client.authenticated) throw new NjtsError('unauthenticated', '一卡通未登录', '请先执行 njts card login');

    if (sub === 'balance') {
      const json = await client.walletMoney();
      // 响应结构见前端 /balance 页：list[].walletMoney（按钱包分，一个卡下可有多个钱包）
      const wallets = (json?.list || []).map((w) => ({
        card: w.alias || w.cardAccNum || '',
        wallet: w.ewalletName || w.walletName || '',
        balance: pickNumber(w, ['walletMoney', 'WalletMoney', 'balance', 'money']),
      }));
      const total = wallets.reduce((sum, w) => sum + (w.balance || 0), 0);
      return {
        total: Number(total.toFixed(2)),
        unit: '元',
        wallets,
        at: new Date().toISOString(),
        raw: debug ? json : undefined,
      };
    }

    if (sub === 'flow') {
      const days = Number(flag(flags, 'days', 'd') || 30);
      const count = Number(flag(flags, 'size') || 50);
      const json = await client.dealRec({ count, yearMonth: flag(flags, 'month') });

      // list[] 是按月分组的，dealDetail[] 才是平铺的流水
      const rows = [];
      for (const group of json?.list || []) {
        for (const d of group.dealDetail || []) {
          rows.push({
            date: d.dealDate || '',
            time: d.dealTime || '',
            item: d.feeNumStr || d.feeName || '',
            place: d.locationNumStr || d.deviceName || d.businessName || '',
            amount: pickNumber(d, ['money', 'Money']),
            payRecNum: d.payRecNum || '',
          });
        }
      }
      const spent = rows.filter((r) => (r.amount ?? 0) < 0).reduce((s, r) => s + Math.abs(r.amount), 0);
      const income = rows.filter((r) => (r.amount ?? 0) > 0).reduce((s, r) => s + r.amount, 0);
      return {
        days,
        count: rows.length,
        totalOnServer: json?.count,
        spent: Number(spent.toFixed(2)),
        income: Number(income.toFixed(2)),
        net: Number((income - spent).toFixed(2)),
        records: rows,
      };
    }

    if (sub === 'account') {
      const json = await client.accInfo();
      return {
        accNum: json?.AccNum || client.accNum,
        name: json?.accName || '',
        epid: json?.epid ?? client.epid,
        personId: json?.personId || '',
        cardNo: json?.cardNo || '',
      };
    }

    // 原 card services（通知公告 /GetNotice）**已移除**：该接口服务端坏了——
    // GET 返 405（说明路径在、只收 POST），而任何形状的 POST（空体 / 表单 /
    // 带 token / 带与不带 AccNum）均返 Tomcat 400「错误的请求」。
    // 留一个永远失败的命令比没有更糟，所以删掉；情报存在 src/card.js 里备查。
    throw inputError(
      `未知的一卡通子命令：${sub || '(空)'}`,
      '可用：card login | card logout | card balance | card flow | card account',
    );
  },

  // -------------------------------------------------------------- 电费
  async power(args) {
    const [sub, ...rest] = args.rest;
    const { flags } = args;
    const debug = Boolean(flags.debug);

    if (sub === 'open') {
      return {
        url: CARD.h5Url,
        steps: ['在微信中打开「博i特师」公众号', '进入 业务系统 → 师生校园卡首页', '点击「生活缴费」→ 选择宿舍电控项目 → 充值'],
        note: '本工具不实现扣款，仅提供入口与步骤',
      };
    }

    const client = CardClient.load();
    client.debug = debug;
    if (!client.authenticated) throw new NjtsError('unauthenticated', '一卡通未登录', '请先执行 njts card login');

    if (sub === 'list') {
      const json = await client.pendingItems();
      // GetPendingItemH5New 返回的是**可缴费项目（分类）**：itemName/itemDetail/itemNum/islistmode
      const items = (json?.list || []).map((r) => ({
        item: r.itemName || '',
        detail: r.itemDetail || '',
        itemNum: r.itemNum || '',
        mode: r.islistmode === 2 ? '项目缴费' : r.islistmode === 1 ? '清单缴费' : '',
      }));
      return {
        count: items.length,
        items,
        note: items.length ? '这是缴费项目；用 njts power areas --item <itemNum> 往下查具体房间' : '没有可缴费项目',
      };
    }

    // ---------------------------------------------------- 电费发现链
    // 园区 → 楼栋 → [楼层] → 房间 → 剩余电费，与前端 /payIndex 页一一对应

    if (sub === 'areas') {
      const itemNum = flag(flags, 'item', 'i');
      if (!itemNum) throw inputError('缺少 --item', '先用 njts power list 看项目号，例如 --item 3');
      const json = await client.pendingItemDetail({ itemNum });
      const style = json?.list?.[0] || {};
      return {
        itemNum,
        item: style.itemName || '',
        remark: style.remark || '',
        needQuery: style.needQuery,
        limitMode: style.limitMode,
        limitMoney: style.limitMoney,
        areas: (style.dormList || []).map((d) => ({ name: d.name, no: d.no })),
        steps: (style.inputList || []).map((s) => ({ id: s.id, label: s.label, type: s.type })),
      };
    }

    if (sub === 'buildings') {
      const itemNum = flag(flags, 'item', 'i');
      const areaNo = flag(flags, 'area');
      if (!itemNum || areaNo === undefined) throw inputError('缺少 --item 或 --area', 'njts power areas --item 3 拿到 area 编号');
      const json = await client.buildingsByArea({ areaNo, itemNum });
      return { itemNum, areaNo, buildings: (json?.dormList || []).map((d) => ({ name: d.name, no: d.no })) };
    }

    if (sub === 'rooms') {
      const itemNum = flag(flags, 'item', 'i');
      const areaNo = flag(flags, 'area');
      const buildingNo = flag(flags, 'building');
      if (!itemNum || areaNo === undefined || buildingNo === undefined) {
        throw inputError('缺少 --item / --area / --building', '按 njts power list → areas → buildings → rooms 的顺序查');
      }
      const json = await client.roomsByBuilding({ areaNo, buildingNo, itemNum, floorNo: flag(flags, 'floor') });
      const list = (json?.dormList || []).map((d) => ({ name: d.name, no: d.no }));
      return {
        itemNum, areaNo, buildingNo,
        isFloor: list.length > 0 && String(list[0].name).includes('层'),
        rooms: list,
        hint: list.length && String(list[0].name).includes('层')
          ? '这一栋要再选楼层：njts power rooms --item … --area … --building … --floor <no>'
          : '',
      };
    }

    if (sub === 'balance') {
      const itemNum = flag(flags, 'item', 'i');
      const areaNo = flag(flags, 'area');
      const buildingNo = flag(flags, 'building');
      const roomNo = flag(flags, 'room');
      if (!itemNum || areaNo === undefined || buildingNo === undefined || roomNo === undefined) {
        throw inputError('缺少参数', '用法：njts power balance --item 3 --area <no> --building <no> --room <no> [--floor <no>]');
      }
      const json = await client.payAccInfo({ areaNo, buildingNo, roomNo, itemNum, floorNo: flag(flags, 'floor') });
      const balance = pickNumber(json, ['balance', 'Balance']);

      // 落一条快照，供 power trend 算日均消耗。
      // 失败**不能**拖垮查询：pi 沙盒对 ~/.njts-cli 只放行读（写会 EROFS），
      // 而快照只是锦上添花的副产品。
      const snapshot = { written: false };
      try {
        appendSnapshot(FILE.powerSnapshot, {
          at: Date.now(),
          items: [{ itemNum, areaNo, buildingNo, roomNo, balance }],
        });
        snapshot.written = true;
      } catch (err) {
        snapshot.reason = err.code || err.message;
        // 只读环境里 mkdir -p 会报 ENOENT 而不是 EROFS（递归创建失败被伪装成“父目录不存在”），
        // 所以这几个码都要当作“写不进去”来解释，否则提示会把人带偏。
        snapshot.hint = ['EROFS', 'EACCES', 'EPERM', 'ENOENT'].includes(err.code)
          ? '当前环境对 ~/.njts-cli 只读或不可写（例如 pi 沙盒只放行了读权限），快照没能落盘。'
            + 'power trend 靠多次快照算日均消耗，因此在只读环境里用不了；余额查询本身不受影响'
          : undefined;
      }

      return {
        room: { areaNo, buildingNo, roomNo, itemNum },
        balance,
        unit: '元',
        snapshot,
        note: '这是该房间的当前剩余电费',
        raw: debug ? json : undefined,
      };
    }

    if (sub === 'trend') {
      const days = Number(flag(flags, 'days', 'd') || 14);
      const snaps = readSnapshots(FILE.powerSnapshot).filter((s) => Date.now() - s.at <= days * 86400000);
      if (snaps.length < 2) {
        return {
          days,
          points: snaps.length,
          note: '快照不足两次，算不了趋势',
          howTo: '每跑一次 `njts power balance --item … --area … --building … --room …` 会落一条快照（写在 ~/.njts-cli/snapshots/power.jsonl），至少两次才能算日均消耗',
          caveat:
            '若在 pi 沙盒这类对 ~/.njts-cli 只读的环境里跑，快照永远落不了盘，本命令就一直会是 0 个点——那不是 bug；在能写盘的终端里跑几次即可',
        };
      }
      const first = snaps[0];
      const last = snaps[snaps.length - 1];
      const sum = (s) => (s.items || []).reduce((acc, i) => acc + (i.balance ?? 0), 0);
      const elapsedDays = (last.at - first.at) / 86400000 || 1;
      const delta = sum(first) - sum(last);
      const perDay = delta / elapsedDays;
      return {
        days,
        points: snaps.length,
        balanceFrom: sum(first),
        balanceTo: sum(last),
        perDay: Number(perDay.toFixed(2)),
        estimatedDaysLeft: perDay > 0 ? Number((sum(last) / perDay).toFixed(1)) : null,
      };
    }

    throw inputError(
      `未知的电费子命令：${sub || '(空)'}`,
      '可用：power list | power areas | power buildings | power rooms | power balance | power open',
    );
  },

  // -------------------------------------------------------------- 请假
  async leave(args) {
    const [sub] = args.rest;
    const { flags } = args;
    const debug = Boolean(flags.debug);

    // 草稿是纯本地生成，不需要任何会话（也不需要网络）
    if (sub === 'draft') {
      const text = args.rest.slice(1).join(' ') || flag(flags, 'text');
      if (!text) throw inputError('缺少描述', '例如：njts leave draft "周三下午发烧去医院，想请一天"');
      return draftLeave(text, readLeaveRules());
    }

    const cas = loadOrThrow(CasSession.load, '尚未登录', '请先执行 njts login（请假走统一身份认证）');
    const ehall = await ensureEhall(cas, debug);

    if (!sub || sub === 'status') {
      const userId = flag(flags, 'id') || cas.user;
      if (!userId) throw inputError('缺少学号', '用 --id 指定，或先执行 njts login 让本地记录学号');
      return ehall.leaveQuery({ userId, needFlow: flag(flags, 'no-flow') !== true });
    }

    if (sub === 'services') {
      return ehall.findServices(flag(flags, 'q') || '请假');
    }

    throw inputError(`未知的请假子命令：${sub}`, '可用：leave status | leave draft | leave services');
  },

  // -------------------------------------------------------------- WebVPN
  async vpn(args) {
    const [sub, ...rest] = args.rest;
    const { flags } = args;
    const debug = Boolean(flags.debug);

    if (sub === 'login') {
      const session = new VpnSession();

      // 两条路径。**默认优先 CAS**：它是用户实测能通的那条，而密码登录那条
      // 我们试了很多次都得到 20048（原因始终没查清）。
      //   --via-cas      强制走 CAS 票据
      //   --via-password 强制走密码登录
      const forcePwd = flags['via-password'] === true || flags['via-password-login'] === true;
      const cas = CasSession.load();

      // **首选：从网关登 CAS。**
      // 这是用户实测唯一能让"门户 + 资源"都能用的入口，也是唯一能建立
      // `.webvpn.njts.edu.cn` 网关会话的途径（直连 auth.njts.edu.cn 登不行）。
      if (flags['via-cas'] !== true) {
        // 默认就走这条。需要密码，但它是唯一能让资源也可达的路。
        const user = flag(flags, 'user', 'u') || process.env.NJTS_USER || (await promptVisible('学号 / 工号: '));
        const password = flag(flags, 'password', 'p') || process.env.NJTS_VPN_PASS || (await promptHidden('统一身份认证密码: '));
        if (!password) throw inputError('未提供密码');
        const r = await session.loginViaGatewayCas({ user, password, passwordMode: flag(flags, 'password-mode') });
        return {
          loggedIn: true,
          via: r.via,
          user: r.user,
          passwordMode: r.passwordMode,
          gatewayCookies: r.gatewayCookies,
          // 登录后去真门户报到那一步的结果。这一步才能拿到网关**自己**的会话 cookie，
          // 少了它资源请求会被踢回登录跳转（今天卡了一整天的就是这个）。
          portal: r.portal,
          chain: r.chain,
          store: FILE.vpnSession,
          hosts: Object.fromEntries(Object.entries(GATE_HOSTS).map(([k, v]) => [k, `http://${v}:${VPN.gatePort}`])),
          // ⚠️ 判断依据必须是**网关自己的**会话 cookie，不能只看"有没有 cookie"。
          // portal 那一趟带回来的 `SESSION_-_auth...` / `CASTGC_-_auth...` 是网关
          // 替 CAS 应用改名的 cookie，跟资源访问授权无关——早先版本把它们当成了
          // 成功标志，又报了一次假 200。
          note: (r.portal?.cookies || []).some((c) => c === 'TWFID' || c === 'sudy_log_token')
            ? '已拿到网关自己的会话 cookie，资源请求应当直接 200'
            : '网关 CAS 成功，但**没拿到网关自己域的会话 cookie**（缺 TWFID / sudy_log_token）——资源会被踢回登录跳转。这一步是门户 SPA 的 JS 完成的，纯 HTTP 复现不了：改跑 `njts vpn browser-login`，让真浏览器去跑那一跳',
        };
      }

      if ((flags['via-cas'] === true || cas?.authenticated) && !forcePwd) {
        const viaCas = await session.loginViaCas(cas);
        return {
          loggedIn: true,
          via: 'cas',
          user: viaCas.user,
          cookies: viaCas.cookies,
          store: FILE.vpnSession,
          hosts: Object.fromEntries(Object.entries(GATE_HOSTS).map(([k, v]) => [k, `http://${v}:${VPN.gatePort}`])),
          note: '用统一身份认证票据登录 WebVPN 成功（绕开了密码登录那条 20048 的路径）',
        };
      }

      const user = flag(flags, 'user', 'u') || process.env.NJTS_USER || (await promptVisible('学号 / 工号: '));
      const password = flag(flags, 'password', 'p') || process.env.NJTS_VPN_PASS || (await promptHidden('统一身份认证密码（WebVPN 与它同一套）: '));
      if (!password) throw inputError('未提供密码');

      const result = await session.login({ user, password });
      return {
        loggedIn: true,
        via: 'password',
        user,
        vpnVersion: result.vpnVersion,
        twfIdStored: result.twfId,
        store: FILE.vpnSession,
        reachable: Object.fromEntries(
          Object.entries(GATE_HOSTS).map(([k, v]) => [k, `http://${v}:${VPN.gatePort}`]),
        ),
        note: 'WebVPN 会话已建立。教务 / 办事大厅 / 一卡通均可经此网关访问',
      };
    }

    if (sub === 'logout') {
      const session = VpnSession.load();
      if (!session) return { loggedOut: false, note: '本来就没有 WebVPN 会话' };
      await session.logout();
      return { loggedOut: true };
    }

    if (sub === 'status' || !sub) {
      const session = VpnSession.load();
      const out = {
        authenticated: Boolean(session?.authenticated),
        user: session?.user || '',
        vpnVersion: session?.vpnVersion || '',
        store: FILE.vpnSession,
        gate: { suffix: VPN.gateSuffix, port: VPN.gatePort },
        hosts: Object.fromEntries(Object.entries(GATE_HOSTS).map(([k, v]) => [k, `http://${v}:${VPN.gatePort}`])),
      };
      if (session?.authenticated) {
        // 四个主机都探一遍。只探 jwxt 一个时，看不出"是会话问题还是该资源没配"。
        out.probe = {};
        for (const [name, target] of [
          ['jwxt', 'http://jwxt.njts.edu.cn/jwglxt/xtgl/login_slogin.html'],
          ['ehall', 'http://ehall.njts.edu.cn/jsonp/checkLogin'],
          ['portal', 'http://portal.njts.edu.cn/'],
        ]) {
          try {
            const res = await session.gate(target, { timeoutMs: 20000 });
            const loc = res.headers.get('location') || '';
            out.probe[name] = {
              status: res.status,
              ok: res.status < 400,
              redirectedToLogin: /webvpn\.njts\.edu\.cn:443/.test(loc) || undefined,
              location: loc ? loc.slice(0, 100) : undefined,
            };
          } catch (err) {
            out.probe[name] = { ok: false, kind: err.kind, message: err.message };
          }
        }
        out.jwxt = out.probe.jwxt;
      }
      return out;
    }

    throw inputError(`未知的 WebVPN 子命令：${sub || '(空)'}`, '可用：vpn login | vpn logout | vpn status | vpn check | vpn url');
  },


  async schedule(args) {
    // --capture：**人点、我抓**。
    //
    // 为什么改成这个：模拟点击那条路试了五六轮（隔离 world 点、主 world 重试、
    // 按下标重试、代它导航），每轮都在猜正方内部怎么开业务页，最后还把标签页
    // 卡死过一次。而唯一被证实可行的事实是：**用户在自己的浏览器窗口里点得开**。
    // 那就不猜了 —— 他点，我在旁边把页面和它自己发的请求抓下来。全程只观察。
    // --http：**浏览器登录，HTTP 取数**（cookie 移植）。
    //
    // 为什么是这个方案：前面为了拿课表，我一直在让 CLI「扮演用户去点菜单」，
    // 五六轮全失败。退一步想，其实一直没试最标准的那个办法 ——
    // **浏览器只用来把门打开（跑 JS、过跳转、建会话），门开了把 cookie 拿出来，
    // 剩下的用普通 HTTP 自己发**。网关会话就是一组 cookie，用 CDP 的
    // Storage.getCookies 原样读出来即可（不需要挂任何标签页，不碰用户的浏览器）。
    // --auto：**让浏览器跑完全程**（推荐）。
    //
    // 为什么把浏览器提到主力：这条链上每一关都是 JS 造的 ——
    // 网关的选路、CAS 的跳转、门户到教务的免密 SSO …… 纯 HTTP 复现不出来
    // （已经实测卡在"门户 → 教务"那一跳）。而浏览器做这些是天然就会的。
    //
    // 而且我此前那句「直接敲业务页地址会被弹回首页」，是**在正方没登录的时候测的** ——
    // 那时候当然会被弹回去。用一个无效的实验解释现象，还拿它当"实测"挡了好几轮。
    //
    // 这条路推翻了我之前两个当结论用的说法：
    //   · 「过门必须靠浏览器，那几关都是 JS 造的」—— 错，六跳全走完了；
    //   · 「资源主机的会话必须落在 .webvpn.njts.edu.cn 域上」—— 错，TWFID 跨域有效。
    // 详细链写在 src/gateway.js 头注释里。
    if (args.flags.http) {
      const out = await fetchScheduleHttp({
        home: ROOT,
        onProgress: (msg) => process.stderr.write(`· ${msg}\n`),
      });

      // 失败要按**契约的退出码**退，不能一律 0。
      // 之前这里无论成败都走到函数末尾 → 退出码恒为 0，
      // 而 README/QUICKSTART/SKILL 三份文档都写着「2 = 未登录、5 = 服务端」。
      // 文档和行为对不上，用脚本包这个命令的人会被坑。
      if (!out.ok) {
        // 坏在哪一层，就报哪一类错 —— 层信息在 out.layer 里（见 gateway.js 的 LAYERS）。
        // 注意各构造函数会自己补默认 hint/后缀，所以 here 只传"是哪一段"，句子归它们拼，
        // 不然会出现「…先跑 njts login 和 njts vpn login。已失效或未登录」这种重复尾巴。
        const authLayer = ['cookie', 'gateway', 'portal'].includes(out.layer);
        const where = {
          cookie: '课表会话', gateway: '网关会话', portal: '门户会话',
          sso: '门户到教务的免密登录', jwxt: '教务会话', term: '课表页的学年学期',
          'data-api': '课表接口',
        }[out.layer] || '课表会话';
        if (authLayer) {
          throw unauthenticated(where, `${out.verdict || ''} 按顺序跑：njts login → njts vpn login --via-cas → njts schedule --http`.trim());
        }
        const hint = `${out.verdict || ''} 诊断报告在 ${path.join(ROOT, 'last-schedule.json')}，里面的 hops 能看出断在哪一跳。`.trim();
        throw (out.layer === 'network' ? networkError : serviceError)(`${where}这一段没走通`, hint);
      }

      if (out.courses?.length) {
        const byDay = groupByWeekday(out.courses);
        process.stderr.write(`\n===== ${out.student?.XNM || ''} 学年 ${out.student?.XQMMC || ''} 学期课表 =====\n`);
        process.stderr.write(`${out.student?.XM || ''} ${out.student?.BJMC || ''}　学号 ${out.student?.XH || ''}\n\n`);
        for (const [day, list] of Object.entries(byDay)) {
          process.stderr.write(`${day}\n`);
          for (const c of list) {
            process.stderr.write(
              `  ${(c.sections + '节').padEnd(8)} ${c.name.padEnd(18)} ${(c.room || '').padEnd(18)} `
              + `${(c.teacher || '').padEnd(8)} ${c.weeks}\n`,
            );
          }
        }
      } else if (out.dataHead || out.landedHead || out.portalHead || out.pageHead) {
        // 坏了也要给人看现场，不是只丢一句判定
        process.stderr.write(`\n现场：${out.dataHead || out.landedHead || out.portalHead || out.pageHead}\n`);
      }
      if (out.verdict) process.stderr.write(`\n【判定】${out.verdict}\n\n`);

      const file = path.join(ROOT, 'last-schedule.json');
      try {
        writeJson(file, out);
      } catch {
        /* 写不进去也不该让命令失败 */
      }
      return { ...out, reportFile: file };
    }

    if (args.flags.ics) {
      const data = readTerms();
      const payload = readJson(flag(args.flags, 'from') || path.join(ROOT, 'schedule.json'));
      if (!payload) throw inputError('缺少课表数据', '请先用 --from 指定课表 JSON，或等教务模块实现');
      const { ics, eventCount } = buildIcs({
        semesterStart: flag(args.flags, 'semester-start') || data.semesterStart,
        numTeachingWeeks: Number(flag(args.flags, 'weeks') || data.numTeachingWeeks),
        excludedWeeks: data.excludedWeeks || [],
        sessions: payload.sessions || [],
        periodTimes: data.periodTimes || {},
      });
      const out = flag(args.flags, 'out') || 'njts-schedule.ics';
      fs.writeFileSync(out, ics);
      return { file: out, events: eventCount };
    }
    throw inputError(
      '请指定取数方式',
      '课表用 njts schedule --http（纯 HTTP 全链，不需要浏览器）；'
      + '另可用 --ics 从本地 JSON 生成日历文件。',
    );
  },

  async grades() {
    throw unsupported('成绩查询尚未实现', '依赖教务登录方式确认，见 plan §4 M2');
  },

  async week() {
    throw unsupported('教学周查询尚未实现', '依赖教务登录方式确认，见 plan §4 M2');
  },

  // -------------------------------------------------------------- skill
  async skill(args) {
    const [sub] = args.rest;
    if (sub !== 'install') throw inputError('用法：njts skill install [--path DIR]');
    const target = flag(args.flags, 'path') || path.join(process.env.HOME || '', '.pi', 'agent', 'skills', 'njts');
    ensureDir(target);
    fs.copyFileSync(SKILL_SRC, path.join(target, 'SKILL.md'));
    return { installed: path.join(target, 'SKILL.md'), hint: '重启 pi 或开新会话后生效；也可用 /skill:njts 手动触发' };
  },
};

// ---------------------------------------------------------------- 请假草稿

function readLeaveRules() {
  return readJson(path.join(DATA_DIR, 'leave-rules.json'), { thresholds: [], materials: {}, verified: false });
}

/**
 * 生成请假草稿。**只输出文本，不调用任何提交接口。**
 *
 * 关于审批链：本校学生走今日校园（WeCMP），纸质假条已停用，
 * 所以审批链**不在这里猜**——权威来源是系统本身（leave status 的 needFlow）。
 * 规则文件里没经过验证的数据就不拿来充数：宁返回 null 并说明去哪里看真的，
 * 也不要结一个像模像样的假答案——假答案会被当真。
 */
export function draftLeave(text, rules) {
  const days = /半天/.test(text) ? 0.5 : /一天|1\s*天/.test(text) ? 1 : /两|二|2\s*天/.test(text) ? 2 : /三|3\s*天/.test(text) ? 3 : null;
  const type = /病|发烧|医院|感冒|疼/.test(text) ? '病假' : /公|比赛|活动|会议/.test(text) ? '公假' : '事假';

  const thresholds = (rules.thresholds || []).filter((c) => Array.isArray(c.approvers) && c.approvers.length);
  const verified = Boolean(rules.verified) && thresholds.length > 0;

  let approvalChain = null;
  if (verified && days != null) {
    const hit = thresholds.find((c) => c.maxDays == null || days <= c.maxDays) || thresholds[thresholds.length - 1];
    approvalChain = hit.approvers;
  }

  const materials = (rules.materials && rules.materials[type]) || [];

  return {
    draft: {
      type,
      reason: text,
      days,
      startTime: '(待填)',
      endTime: '(待填)',
      contact: '(待填)',
    },
    approvalChain,
    approvalChainNote: verified
      ? '规则来自 data/leave-rules.json（已经过确认）'
      : '**审批链未知**：本校请假走今日校园，纸质假条已停用，本工具没有经过确认的分级规则。'
        + '真实审批节点以系统为准——提交后跑 `njts leave status`，返回的 needFlow 就是实际流程。',
    materials,
    materialsNote: materials.length
      ? '材料清单已确认'
      : type === '病假'
        ? '病假一般需要上传证明（病历 / 诊断证明），具体以今日校园表单提示为准——本校要求未确认。'
        : '本校材料要求未确认，以今日校园表单提示为准。',
    checklist: [
      '在今日校园 App → 请假 里按上述字段填写（本工具不代提交）',
      days == null ? '注意：没从描述里读出天数，请自己确认起止时间' : `描述里读出天数=${days}，请核对`, 
      '提交后可用 `njts leave status` 跟踪审批进度',
    ],
    reminder: '本命令只生成草稿，不会提交任何申请；提交请自行在今日校园 App 内完成。',
    warnings: verified ? [] : ['审批链未经验证，本草稿不给出"需要谁批"的结论，避免误导'],
  };
}

// ---------------------------------------------------------------- terms 数据

function readTerms() {
  return readJson(path.join(DATA_DIR, 'njts-terms.json'), {});
}

// ---------------------------------------------------------------- 主流程

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [command, ...rest] = args.rest;
  args.rest = rest;

  // 把 WebVPN 会话注入 HTTP 层，让需要校内网络的主机（jwxt/portal/ehall）
  // 自动改写成经网关的地址。这一步是**全局**的：每个请求各自判断。
  //   --direct  → 所有请求直连（诊断用，或在已连上 VPN 的校内网络里）
  //   --via-vpn → 强制全部经网关
  args.via = args.flags.direct ? 'direct' : args.flags['via-vpn'] ? 'vpn' : 'auto';
  setVpnSession(args.via === 'direct' ? null : VpnSession.load());

  if (!command || command === 'help' || args.flags.help) {
    return {
      usage: 'njts <command> [sub] [--flags]',
      commands: {
        'schedule --http': '★ 课表：纯 HTTP 全链，不用浏览器（推荐）',
        'schedule --ics [--from FILE]': '课表导出 ICS 日历（从本地 JSON 生成）',
        'card login|logout|balance|flow|account': '一卡通（学号 + 一卡通单独密码）',
        'power list|areas|buildings|rooms|balance|open': '宿舍电费（只读；topup 不实现）',
        'leave status|draft|services': '请假进度与草稿（不提交）',
        'login|whoami|logout': '统一身份认证',
        'vpn login --via-cas|logout|status': 'WebVPN 网关会话（用 CAS 票据换，不发密码）',
        status: '体检：VPN / CAS / ehall / 一卡通',
        'grades|week': '成绩 / 周次（未实现；接口没抓到，不猜）',
        'skill install': '把 SKILL.md 装进 pi',
      },
      boundary: '只读；不实现缴费、选课、请假提交、挂失、阀控',
    };
  }

  const handler = commands[command];
  if (!handler) throw inputError(`未知命令：${command}`, '执行 njts help 查看可用命令');
  return handler(args);
}

export function render(result) {
  process.stdout.write(`${JSON.stringify({ ok: true, data: result }, null, 2)}\n`);
}

export function renderError(err) {
  const known = err instanceof NjtsError ? err : null;
  const payload = {
    ok: false,
    error: known
      ? known.toJSON()
      : { kind: 'service', message: err?.message || String(err), hint: '这是未预期的错误，请带上 --debug 重试并反馈' },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (process.env.NJTS_DEBUG && !known) console.error(err);
  return known ? known.exitCode : EXIT.service;
}
