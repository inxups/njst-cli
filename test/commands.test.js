/**
 * 冒烟测试：**每个命令都要能跑起来**。
 *
 * 为什么要有这个文件：删掉浏览器那套老路径时，我把 `probeJwxt()`（在 zf.js 里）
 * 一起删了，但 `njts status` 还在调它 —— 结果 `status` 直接报
 * 「probeJwxt is not defined」，而**当时的测试一条都没红**。
 * 单测覆盖的是函数，覆盖不到"命令分发链上有没有悬空引用"。
 *
 * 所以这里从**真实入口**（bin/njts.js）把每个只读命令跑一遍，
 * 断言它给出的是**已知的 error.kind**，而不是 `is not defined` / `not a function`
 * 这类暴露内部断链的意外错误。
 *
 * 用空的 NJTS_HOME，所以不会碰任何真实会话，也不需要网络。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/njts.js', import.meta.url));

/** 契约里允许的 kind（见 src/errors.js 的 EXIT） */
const KNOWN_KINDS = new Set(['unauthenticated', 'login', 'network', 'service', 'input', 'unsupported']);

/** 不该出现的错误：这些说明代码内部断了，而不是环境/会话问题 */
const INTERNAL_LEAK = /\bis not defined\b|\bis not a function\b|Cannot read propert|Cannot find module|\bundefined is not\b/;

/** 只读命令（空会话下它们应当明确报"未登录"，而不是崩） */
const COMMANDS = [
  ['help'],
  ['status'],
  ['whoami'],
  ['card', 'balance'],
  ['card', 'flow'],
  ['card', 'account'],
  ['power', 'list'],
  ['power', 'areas'],
  ['power', 'open'],
  ['leave', 'status'],
  ['leave', 'services'],
  ['schedule', '--http'],
  ['vpn', 'status'],
  ['grades'],
  ['week'],
];

function run(args, home) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, NJTS_HOME: home, NJTS_NO_PROXY: '1' },
      stdio: 'pipe',
      timeout: 60_000,
    });
    return { status: 0, stdout: stdout.toString() };
  } catch (e) {
    return { status: e.status ?? -1, stdout: (e.stdout || Buffer.from('')).toString() };
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'njts-smoke-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

for (const args of COMMANDS) {
  test(`njts ${args.join(' ')} 不崩、不泄漏内部错误`, () => {
    const r = run(args, home);
    let out;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      assert.fail(`stdout 不是 JSON（退出码 ${r.status}）：${r.stdout.slice(0, 200)}`);
    }
    assert.equal(typeof out.ok, 'boolean', 'ok 必须是布尔');
    if (!out.ok) {
      assert.ok(
        KNOWN_KINDS.has(out.error.kind),
        `kind 不在契约里：${out.error.kind}（${out.error.message}）`,
      );
      assert.ok(
        !INTERNAL_LEAK.test(`${out.error.message} ${out.error.hint || ''}`),
        `暴露了内部错误 —— 说明命令链上有悬空引用：${out.error.message}`,
      );
      // 消息必须能给人看，不能是空串或 "undefined"
      assert.ok(out.error.message && !/^undefined/.test(out.error.message), '错误消息不能是空的');
    }
    // 退出码必须和 kind 对得上（契约见 README）
    const EXPECT = { unauthenticated: 2, login: 3, network: 4, service: 5, input: 6, unsupported: 7 };
    const want = out.ok ? 0 : EXPECT[out.error.kind];
    assert.equal(r.status, want, `${out.ok ? 'ok' : `kind=${out.error?.kind}`} 应对应退出码 ${want}，实际 ${r.status}`);
  });
}

test('help 必须列出 schedule --http（课表是主力功能）', () => {
  const out = JSON.parse(run(['help'], home).stdout);
  const keys = Object.keys(out.data.commands);
  assert.ok(keys.some((k) => k.startsWith('schedule --http')), `help 里没有 schedule --http：${keys}`);
  // 已删除的老路径不许再出现在 help 里
  for (const gone of ['--auto', '--capture', '--browser', 'jwxt', 'vpn check', 'vpn probe', 'vpn url']) {
    assert.ok(
      !keys.some((k) => k.includes(gone)),
      `help 里还留着已经删掉的 ${gone}`,
    );
  }
});
