/**
 * WebVPN 层的单元测试。
 *
 * 这里的每一条都对应今天踩过的**真实 bug**，不是凑数的：
 *
 *   1. `gate()` 必须跟重定向 —— 我连错两次（先是参数展开顺序写反，
 *      后来改成 `opts.redirect ?? 'follow'` 但调用方恰好传 `manual`）。
 *      两次的后果都是「拿到 302 就放弃」，资源永远进不去。
 *   2. CookieJar 必须尊重 `Set-Cookie` 的 `domain=` 属性 —— 网关的会话
 *      cookie 域是 `.webvpn.njts.edu.cn`，要共享给所有 `xxx-s.` 主机。
 *      忽略它 = 网关永远认为我们没登录。
 *   3. `svpn_rand_code` 无验证码时是**空串**，不是 `md5("")` —— 我按
 *      `hex_md5(randCode)` 推断成 md5("") 是错的，抓包才纠正过来。
 *   4. 查询串必须带 `apiversion=1` —— 漏了它服务端行为不同。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CookieJar, gateHost, gateUrl, VPN_GATE } from '../src/http.js';
import { VPN, parseAuthXml } from '../src/vpn.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------------------------------------------------------------- 地址映射

test('网关地址映射：点换横线 + -s 后缀（已实测的规则）', () => {
  assert.equal(gateHost('jwxt.njts.edu.cn'), 'jwxt-njts-edu-cn-s.webvpn.njts.edu.cn');
  assert.equal(gateHost('auth.njts.edu.cn'), 'auth-njts-edu-cn-s.webvpn.njts.edu.cn');
  assert.equal(
    gateUrl('http://jwxt.njts.edu.cn/jwglxt/xtgl/login_slogin.html'),
    `http://jwxt-njts-edu-cn-s.webvpn.njts.edu.cn:${VPN_GATE.port}/jwglxt/xtgl/login_slogin.html`,
  );
});

test('网关端口固定 8118（8119/8120/8000 实测都不通）', () => {
  assert.equal(VPN_GATE.port, '8118');
  assert.equal(VPN.gatePort, '8118');
});

// ---------------------------------------------------------------- gate 的契约

test('gate() 的 redirect 不允许被调用方覆盖（连错两次的那个 bug）', () => {
  const src = read('src/vpn.js');
  const start = src.indexOf('async gate(');
  assert.ok(start > -1, '找不到 gate()');
  // 切到下一个方法为止，并**剥掉行注释**——注释里也提到了这两个词，
  // 不剥的话索引会指到注释上（这个测试自己先踩了一次）
  const rest = src.slice(start + 'async gate('.length);
  const nextMethod = rest.search(/\n  (async |get |static )/);
  const body = (nextMethod > -1 ? rest.slice(0, nextMethod) : rest)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  const optsAt = body.indexOf('...opts');
  const followAt = body.indexOf("redirect: 'follow'");
  assert.ok(optsAt > -1, 'gate() 里应该展开 ...opts');
  assert.ok(followAt > -1, "gate() 必须写死 redirect: 'follow'");
  assert.ok(followAt > optsAt, "redirect: 'follow' 必须在 ...opts 之后，否则会被调用方覆盖");

  // 也不能是 opts.redirect ?? 'follow' —— 调用方传 manual 时依然不跟
  const code = body.slice(body.indexOf('const res = await request('));
  assert.doesNotMatch(code, /redirect:\s*opts\.redirect/, '不要给 redirect 留覆盖空间');

  // 调用方也不该再传 manual 给 gate()
  const cli = read('src/cli.js');
  for (const m of cli.matchAll(/\.gate\([^)]*redirect:\s*'manual'/g)) {
    assert.fail(`src/cli.js 里不该给 gate() 传 redirect:'manual'：${m[0].slice(0, 60)}`);
  }
});

// ---------------------------------------------------------------- cookie 域

test('CookieJar 尊重 Set-Cookie 的 domain 属性（网关靠它共享会话）', () => {
  const jar = new CookieJar();
  jar.absorb('http://auth-njts-edu-cn-s.webvpn.njts.edu.cn:8118/cas/login', [
    'SESSION_-_auth.njts.edu.cn=abc; Path=/cas/; domain=webvpn.njts.edu.cn',
  ]);

  // 必须落在**父域**下，而不是请求主机名
  assert.deepEqual(jar.cookies, { 'webvpn.njts.edu.cn': { 'SESSION_-_auth.njts.edu.cn': 'abc' } });

  // 子域请求要能带上它
  assert.equal(jar.header('jwxt-njts-edu-cn-s.webvpn.njts.edu.cn'), 'SESSION_-_auth.njts.edu.cn=abc');
  assert.equal(jar.header('webvpn.njts.edu.cn'), 'SESSION_-_auth.njts.edu.cn=abc');
});

test('CookieJar 不接收跨站的 domain（防伪造）', () => {
  const jar = new CookieJar();
  jar.absorb('http://evil.example.com/', ['X=1; domain=njts.edu.cn']);
  assert.equal(jar.cookies['njts.edu.cn'], undefined, '不该接受不覆盖当前主机的 domain');
  assert.deepEqual(jar.cookies['evil.example.com'], { X: '1' });
});

test('CookieJar 不带 domain 时仍是 host-only', () => {
  const jar = new CookieJar();
  jar.absorb('https://auth.njts.edu.cn/cas/login', ['CASTGC=TGT-1; Path=/cas/']);
  assert.deepEqual(jar.cookies, { 'auth.njts.edu.cn': { CASTGC: 'TGT-1' } });
  assert.equal(jar.header('other.njts.edu.cn'), '');
});

// ---------------------------------------------------------------- 登录请求形状





// ---------------------------------------------------------------- RSA





// ---------------------------------------------------------------- XML 解析

test('parseAuthXml 解析真实形状的响应', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<Auth>
<ErrorCode>1</ErrorCode>
<Message>login auth success</Message>
<CSRF_RAND_CODE>1376475040</CSRF_RAND_CODE>
<RndImg>0</RndImg>
<RSA_ENCRYPT_KEY>ABCDEF</RSA_ENCRYPT_KEY>
<RSA_ENCRYPT_EXP>65537</RSA_ENCRYPT_EXP>
<TwfID>b504fd68e780a105</TwfID>
<VPNVERSION>M7.6.8R2</VPNVERSION>
</Auth>`;
  const p = parseAuthXml(xml);
  assert.equal(p.errorCode, '1');
  assert.equal(p.message, 'login auth success');
  assert.equal(p.csrfRandCode, '1376475040');
  assert.equal(p.rsaKey, 'ABCDEF');
  assert.equal(p.rsaExp, '65537');
  assert.equal(p.twfId, 'b504fd68e780a105');
  assert.equal(p.vpnVersion, 'M7.6.8R2');
});

test('parseAuthXml 解析 20048（策略拒绝）与 20004（凭据错）的区别', () => {
  const denied = parseAuthXml(
    `<Auth><Note><![CDATA[It fails to comply with the login policy. Access was denied!]]></Note>` +
      `<ErrorCode>20048</ErrorCode><Result>0</Result>` +
      `<Message><![CDATA[No virtual portal access]]></Message></Auth>`,
  );
  assert.equal(denied.errorCode, '20048');
  assert.equal(denied.message, 'No virtual portal access');

  const badPw = parseAuthXml(`<Auth><ErrorCode>20004</ErrorCode><Note>Invalid username or password!</Note></Auth>`);
  assert.equal(badPw.errorCode, '20004');
});

// ---------------------------------------------------------------- 登录路径选择

test('vpn login 默认走网关 CAS（唯一能建立网关会话的路径）', () => {
  const vpn = read('src/vpn.js');
  assert.match(vpn, /async loginViaGatewayCas/);
  // 网关 CAS 的地址必须经网关主机，不能直连 auth.njts.edu.cn
  assert.match(vpn, /gateHost\('auth\.njts\.edu\.cn'\)/);

  const cli = read('src/cli.js');
  assert.match(cli, /flags\['via-cas'\] !== true/, '默认分支应该是网关 CAS，--via-cas 才用票据');
});

// ---------------------------------------------------------------- 「请登录」页识别

test('识别网关的「请登录」页（它不是 302，而是 200 + JS 跳转）', async () => {
  const { GATE_LOGIN_PAGE, extractGateRedirect } = await import('../src/vpn.js');

  // 逐字摘自 2026-09-15 从真实网关抓到的 6916 字节页面
  const page = `<script>
var g_lines = [];
/* 注释里也有 url:"..."，别被它骗了 */
g_lines = [{src:"",url:"https://webvpn.njts.edu.cn/portal?redirect_uri=http%3A%2F%2Fjwxt-njts-edu-cn-s.webvpn.njts.edu.cn%3A8118%2Fjwglxt%2Fxtgl%2Flogin_slogin.html",right:0}];
gotoLines();
</script>`;

  assert.ok(GATE_LOGIN_PAGE.test(page), '必须能识别出来——否则 200 会被误报成「资源可达」');
  assert.match(extractGateRedirect(page), /^https:\/\/webvpn\.njts\.edu\.cn\/portal\?redirect_uri=/);
  assert.match(decodeURIComponent(extractGateRedirect(page)), /jwglxt\/xtgl\/login_slogin\.html$/);
});

test('正常资源页面不会被误判成「请登录」页', async () => {
  const { GATE_LOGIN_PAGE } = await import('../src/vpn.js');
  for (const ok of [
    '<html><body><table id="tabGrid">课程表</table></body></html>',
    '<html><head><title>教学综合信息服务平台</title></head></html>',
    '',
    '<script>var gotoLinesCount = 3;</script>', // 像但不是调用
  ]) {
    assert.equal(GATE_LOGIN_PAGE.test(ok), false, `不该误判：${ok.slice(0, 40)}`);
  }
});

test('gate() 必须处理「请登录」页，不能只看状态码', () => {
  const src = read('src/vpn.js');
  const start = src.indexOf('async gate(');
  const rest = src.slice(start);
  const body = rest.slice(0, rest.search(/\n  [a-zA-Z]+\s*\(/) > 0 ? rest.search(/\n  [a-zA-Z]+\s*\(/) : 3000);
  assert.match(body, /GATE_LOGIN_PAGE\.test/, 'gate() 里必须检查「请登录」页');
  assert.match(body, /extractGateRedirect/, 'gate() 里必须跟着跳一次');
});
