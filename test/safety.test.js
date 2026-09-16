/**
 * 安全边界测试 —— 这是本仓库最重要的测试。
 *
 * plan §2.3 / §5 承诺了「不实现写操作」。承诺只写在文档里没有意义，
 * 这里用断言把它钉在代码上：源码里不允许出现任何写接口的路径。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readAllSources() {
  const out = [];
  for (const dir of ['src', 'bin']) {
    const abs = path.join(root, dir);
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.js')) out.push({ file: `${dir}/${name}`, text: fs.readFileSync(path.join(abs, name), 'utf8') });
    }
  }
  return out;
}

/** 一卡通写接口：支付、退款、挂失、开卡、阀控、提现、转账 */
const FORBIDDEN_CARD_PATHS = [
  '/PayFeeItemNew',
  '/hzsunPayByOtherType',
  '/getPayTypeFromAggregate',
  '/PayFeeListNew',
  '/ReportLost',
  '/OpenValve',
  '/CloseValve',
  '/WalletTransfer',
  '/BankTransfer',
  '/ApplyWithdraw',
  '/ApplyForCard',
  '/ModifyAccPassword',
  '/ResetAccPassword',
  '/SetAccountInfo',
  '/UploadAccPhoto',
];

/** 请假/学工写接口 */
const FORBIDDEN_LEAVE_PATHS = [
  '/wec-apis/leave/stu/submit',
  '/wec-apis/leave/stu/approve',
  '/wec-apis/leave/stu/cancel',
  'leaveSubmit',
  'submitSign',
];

test('源码中不出现任何一卡通写接口', () => {
  const offenders = [];
  for (const { file, text } of readAllSources()) {
    for (const p of FORBIDDEN_CARD_PATHS) {
      // 允许出现在注释/禁用说明里，但要在 READ_PATHS 白名单之外被显式调用则不行
      const callLike = new RegExp(`call(?:Checked)?\\(\\s*['"\`]${p.replace(/[/\\]/g, '\\$&')}`);
      if (callLike.test(text)) offenders.push(`${file} → ${p}`);
    }
  }
  assert.deepEqual(offenders, [], `发现写接口调用：\n${offenders.join('\n')}`);
});

test('源码中不出现任何请假提交接口', () => {
  const offenders = [];
  for (const { file, text } of readAllSources()) {
    for (const p of FORBIDDEN_LEAVE_PATHS) {
      if (text.includes(p)) offenders.push(`${file} → ${p}`);
    }
  }
  assert.deepEqual(offenders, [], `发现提交类接口：\n${offenders.join('\n')}`);
});

test('读接口白名单不含任何写操作', async () => {
  const { READ_PATHS } = await import('../src/card.js');
  const values = Object.values(READ_PATHS);
  for (const p of FORBIDDEN_CARD_PATHS) {
    assert.ok(!values.includes(p), `白名单里混入了写接口：${p}`);
  }
});

test('CLI 不注册任何 submit/topup 提交命令', async () => {
  const { main } = await import('../src/cli.js');
  const help = await main(['help']);
  const names = Object.keys(help.commands).join(' ');
  assert.ok(!/submit/i.test(names), 'help 中不应出现 submit');
  // 只检查“命令名”这一层：描述里写“topup 不实现”是允许且应该的
  assert.ok(!/\btopup\b/.test(names), '不应注册 topup 子命令');
  // 断言意图，而不是写死子命令清单——清单是改动方向，不是需求
  assert.ok(/power\s+list/.test(names), 'power list 应在 help 里');
  assert.ok(/balance/.test(names), 'power balance 应在 help 里');
  assert.ok(/power\s+[^\s]*open/.test(names), '人工引导入口 power open 应在 help 里');
});

test('未登录时拒绝执行敏感读取（不静默返回空）', async () => {
  // 必须跑子进程：
  //   1. store.js 的 ROOT 是模块加载时从 NJTS_HOME 算出来的常量，
  //      在测试里改 process.env 无效（还会污染其它测试文件）
  //   2. 开发机上用户可能真的已登录，直接调用 main() 会去请求真实接口
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const emptyHome = fs.mkdtempSync(path.join(os.default.tmpdir(), 'njts-empty-'));
  const cli = path.join(root, 'bin', 'njts.js');

  for (const args of [['card', 'balance'], ['leave', 'status']]) {
    let out = '';
    let status = 0;
    try {
      out = execFileSync(process.execPath, [cli, ...args], {
        env: { ...process.env, NJTS_HOME: emptyHome, NJTS_NO_PROXY: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      out = String(err.stdout || '');
      status = err.status;
    }
    assert.equal(status, 2, `${args.join(' ')} 应以 exit 2 退出，实际 ${status}`);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.kind, 'unauthenticated', `${args.join(' ')} 应报 unauthenticated`);
  }
});

test('交互输入路径存在且不能静默挂死（回归：promptVisible 曾被漏掉定义）', async () => {
  // 背景：`a || b || (await promptVisible(...))` 在环境变量存在时会短路，
  // 所以所有走环境变量的测试都绕过了那两个函数——它们曾因此**从未被定义**，
  // 直到用户第一次真在终端里登录才炸出 `promptVisible is not defined`。
  // 这个用例在没有凭据、且 stdin 不是 TTY 的情况下跑，保证该路径被执行到。
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const emptyHome = fs.mkdtempSync(path.join(os.default.tmpdir(), 'njts-tty-'));
  const cli = path.join(root, 'bin', 'njts.js');

  const env = { ...process.env, NJTS_HOME: emptyHome, NJTS_NO_PROXY: '1' };
  for (const k of ['NJTS_USER', 'NJTS_PASS', 'NJTS_CARD_USER', 'NJTS_CARD_PASS', 'NJTS_VPN_PASS']) {
    delete env[k];
  }

  for (const args of [['login'], ['card', 'login'], ['vpn', 'login', '--via-password'], ['vpn', 'browser-login']]) {
    let out = '';
    try {
      out = execFileSync(process.execPath, [cli, ...args], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      });
    } catch (err) {
      out = String(err.stdout || '');
      assert.notEqual(err.signal, 'SIGTERM', `${args.join(' ')} 挂住了（没在等 stdin）`);
    }

    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false, `${args.join(' ')} 在无凭据时不应成功`);
    // 关键断言：是「缺输入」这类预期错误，而不是 ReferenceError 那种代码 bug
    assert.equal(parsed.error.kind, 'input', `${args.join(' ')} 应报 input，实际：${out}`);
    assert.doesNotMatch(parsed.error.message, /is not defined|is not a function/, `${args.join(' ')} 爆了代码错误`);
  }
});
