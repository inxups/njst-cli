/**
 * Node 版本下限的测试。
 *
 * 这一组存在的理由不是"版本号写对了"，而是**钉住一条容易被破坏的耦合**：
 * 只要 src 里出现 `Headers.getSetCookie()`，版本下限就必须 ≥ 20。
 * 没有这条，下一个人加了新 API、下限还留在旧值，就会重现
 * "Node 18 上静默收不到任何 cookie" 那个最难查的故障。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIN_NODE_MAJOR, nodeVersionProblem, currentNodeProblem } from '../src/version.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/njts.js', import.meta.url));

test('版本下限是 20（getSetCookie 在 19.7 进入，取到下一个 LTS）', () => {
  assert.equal(MIN_NODE_MAJOR, 20);
});

test('低于下限的版本要给出说明，不是静默通过', () => {
  for (const v of ['18.20.4', '18.0.0', '16.20.2', '19.6.0']) {
    const p = nodeVersionProblem(v);
    assert.ok(p, `${v} 应该被判为不合格`);
    assert.match(p, /getSetCookie/, 'hint 要说清根因，不能只说"版本太低"');
  }
});

test('19.7 与 20 以上要放行（19.7 起 getSetCookie 才有）', () => {
  for (const v of ['20.0.0', '20.11.1', '22.14.0', '24.21.0']) {
    assert.equal(nodeVersionProblem(v), '', `${v} 不该被拦`);
  }
});

test('版本号读不出来时也不许放行（宁可拦错，不能静默降级）', () => {
  for (const bad of ['', null, undefined, 'abc', 'v20']) {
    assert.ok(nodeVersionProblem(bad), `${JSON.stringify(bad)} 应该被判为不合格`);
  }
});

test('当前进程必须通过检查（否则这个包在跑测试的机器上就起不来）', () => {
  assert.equal(currentNodeProblem(), '');
});

test('★ 耦合断言：src 里出现 getSetCookie，版本下限就必须 ≥ 20', () => {
  const offenders = [];
  for (const name of fs.readdirSync(SRC)) {
    if (!name.endsWith('.js') || name === 'version.js') continue;
    const text = fs.readFileSync(path.join(SRC, name), 'utf8');
    // 只看真正的调用（注释里提到这个词不算）
    for (const line of text.split('\n')) {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      if (/\bgetSetCookie\s*[?(]/.test(line)) offenders.push(`${name}: ${line.trim().slice(0, 90)}`);
    }
  }
  assert.ok(offenders.length > 0, 'src 里一处 getSetCookie 都没有了？那这条耦合断言该重新审一遍');
  assert.ok(
    MIN_NODE_MAJOR >= 20,
    `用了 getSetCookie（Node 19.7+）就必须把 MIN_NODE_MAJOR 提到 ≥20，当前是 ${MIN_NODE_MAJOR}：\n${offenders.join('\n')}`,
  );
});

test('bin/njts.js 在**代理自举之前**就做了版本检查', () => {
  // 放后面就白做：自举会 spawn 一个子进程，子进程同样要过这一关。
  // 更要紧的是，代理自举那条路本身就调 fetch —— 版本不够时先崩在那儿更难查。
  const bin = fs.readFileSync(BIN, 'utf8');
  const iCheck = bin.indexOf('currentNodeProblem');
  const iProxy = bin.indexOf('NODE_USE_ENV_PROXY');
  assert.ok(iCheck > 0, 'bin 里没有版本检查');
  assert.ok(iProxy > 0, 'bin 里没有代理自举（如果删了，这条断言该一起改）');
  assert.ok(iCheck < iProxy, '版本检查必须排在代理自举前面');
});

test('package.json 的 engines 不能比 MIN_NODE_MAJOR 松', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = String(pkg.engines?.node || '');
  const m = declared.match(/>=\s*(\d+)/);
  assert.ok(m, `engines.node 写法不认识：${JSON.stringify(declared)}`);
  assert.ok(
    Number(m[1]) >= MIN_NODE_MAJOR,
    `package.json 写的是 ${declared}，但代码要求 ≥${MIN_NODE_MAJOR} —— 会误导用 Node 18 的人`,
  );
});

test('★ 端到端：真入口在 Node 18 下拒绝启动（exit 7），不是静默跑下去', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const hook = path.join(os.tmpdir(), `njts-fake-old-node-${process.pid}.mjs`);
  // process.versions.node 是只读属性，普通赋值在 ESM 严格模式下会抛
  fs.writeFileSync(
    hook,
    "Object.defineProperty(process.versions, 'node', { value: '18.20.4', configurable: true });\n",
  );
  try {
    execFileSync(process.execPath, [BIN, '--help'], {
      env: { ...process.env, NODE_OPTIONS: `--import=file://${hook}` },
      stdio: 'pipe',
    });
    assert.fail('Node 18 下竟然正常退出了 —— 版本守卫没生效');
  } catch (e) {
    assert.equal(e.status, 7, `应该是退出码 7（unsupported），实际 ${e.status}`);
    const out = JSON.parse(e.stdout.toString());
    assert.equal(out.ok, false);
    assert.equal(out.error.kind, 'unsupported');
    assert.match(out.error.hint, /getSetCookie/, 'hint 要说清根因');
  } finally {
    fs.rmSync(hook, { force: true });
  }
});
