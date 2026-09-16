/**
 * 一卡通「易通」签名与编码测试 —— 锁住算法顺序。
 *
 * 这些期望值不是"我算出来应该是这样"，而是从 H5 前端源码逐行读出来的行为：
 *
 *   app.js 的 axios 请求拦截器：
 *     t.Time || (t.Time = getFormatDate("yyyymmddhhmmss"));
 *     for (var a = Object.keys(t).sort(), n = "", o = 0; o < a.length; o++) {
 *         n += t[a[o]] + "|";            // ← 每个值后面跟一个竖线
 *     }
 *     n = MD5(n + Md5Key).toString();
 *     t.Sign = n;                        // ← 先签名
 *     t.ContentType = "application/json"; // ← 才加 ContentType（所以它不参与签名）
 *     for (var m in t)
 *         t[m] = encodeURIComponent(t[m]), l += "&" + m + "=" + t[m];
 *
 * 登录页 chunk 14：
 *     PassWord: encryptBy3DESModeCBC(密码, random补齐24位)
 *     { TypeNum: 1, UserNumber, PassWord [, EPID] }
 *
 * 两个曾经真错过的点，各自单独一条测试盯着：
 *   1. 签名里 Md5Key 前面有**多一个竖线**（少了它服务端返回 Tomcat 400）
 *   2. ContentType **不**参与签名
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSignedBody, loginKeyFrom, parseRemainingAttempts, CARD, timestamp, pickTable, pickNumber } from '../src/card.js';
import { tripleDesCbcEncrypt } from '../src/des.js';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------- CryptoJS 基准

const vendorPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'crypto-js.min.js');
const CryptoJS = (() => {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', fs.readFileSync(vendorPath, 'utf8'))(m, m.exports, () => {});
  return m.exports;
})();
const U = CryptoJS.enc.Utf8;

const cryptoJsSign = (obj) => {
  const keys = Object.keys(obj).sort();
  let n = '';
  for (const k of keys) n += obj[k] + '|';
  return CryptoJS.MD5(n + CARD.md5Key).toString();
};

// ---------------------------------------------------------------- 签名

test('Sign = MD5(排序后的值各自带尾竖线 + Md5Key)', () => {
  const { params } = buildSignedBody({ UserName: 'b', Password: 'a' }, { time: '20240101000000' });
  // 排序后：Password, Time, UserName → "a|20240101000000|b|" + Md5Key
  assert.equal(params.Sign, md5('a|20240101000000|b|' + CARD.md5Key));
  // 且与 CryptoJS 算的一致
  assert.equal(params.Sign, cryptoJsSign({ Password: 'a', Time: '20240101000000', UserName: 'b' }));
});

test('回归：Md5Key 前面必须有一个多余的竖线（少了它服务端验签必失败）', () => {
  const { params } = buildSignedBody({ UserNumber: '2023001' }, { time: '20240101000000' });
  // 排序后是 Time, UserNumber → "Time值|UserNumber值|"
  const withPipe = md5('20240101000000|2023001|' + CARD.md5Key);
  const withoutPipe = md5('20240101000000|2023001' + CARD.md5Key);
  assert.equal(params.Sign, withPipe);
  assert.notEqual(params.Sign, withoutPipe);
});

test('回归：ContentType 与 Sign 都不参与签名', () => {
  const { params } = buildSignedBody({ UserNumber: '2023001' }, { time: '20240101000000' });
  // 若把 ContentType 算进去，得到的会是下面这个值——必须不相等
  const wrong = md5('20240101000000|2023001|application/json|' + CARD.md5Key);
  assert.notEqual(params.Sign, wrong);
  assert.equal(params.ContentType, 'application/json');
  assert.deepEqual(Object.keys(params).sort(), ['ContentType', 'Sign', 'Time', 'UserNumber']);
});

test('Time 缺省自动补齐为 14 位；显式传入时不被覆盖', () => {
  assert.match(buildSignedBody({ UserNumber: 'x' }).params.Time, /^\d{14}$/);
  assert.equal(buildSignedBody({ UserNumber: 'x' }).params.Time, timestamp());
  assert.equal(buildSignedBody({ UserNumber: 'x' }, { time: '20240101000000' }).params.Time, '20240101000000');
});

// ---------------------------------------------------------------- 表单体

test('表单体：每个值 encodeURIComponent 后拼 k=v&（不用 URLSearchParams）', () => {
  const { body } = buildSignedBody({ UserNumber: 'a b&c', Nick: "it's" }, { time: '20240101000000' });
  assert.equal(typeof body, 'string');
  assert.match(body, /UserNumber=a%20b%26c/); // 空格编码成 %20 而不是 +
  assert.match(body, /Nick=it's/); // encodeURIComponent 不转义单引号（URLSearchParams 会转成 %27）
  assert.match(body, /ContentType=application%2Fjson/);
});

test('encodeURIComponent 与 CryptoJS 前的编码行为一致（对照前端写法）', () => {
  const { body, params } = buildSignedBody({ A: '1+2=3', B: '李四' }, { time: '20240101000000' });
  let expected = '';
  for (const m in params) expected += `&${m}=${encodeURIComponent(params[m])}`;
  assert.equal(body, expected.slice(1));
});

// ---------------------------------------------------------------- 3DES 登录密钥

test('随机数补齐到 24 位', () => {
  assert.equal(loginKeyFrom('123456'), '123456' + '0'.repeat(18));
  assert.equal(loginKeyFrom('1'.repeat(24)), '1'.repeat(24));
  assert.equal(loginKeyFrom('1'.repeat(24)).length, CARD.loginKeyLength);
  assert.throws(() => loginKeyFrom(''), (e) => e.kind === 'service');
  assert.throws(() => loginKeyFrom('x'.repeat(25)), (e) => e.kind === 'service');
});

test('登录密码用 3DES-CBC，key=补齐后的随机数，iv=12347890（与 CryptoJS 逐字节一致）', () => {
  const key24 = loginKeyFrom('98765432109876543210');
  const mine = tripleDesCbcEncrypt('123456', key24, CARD.keyCryptoPhone);
  const cryptojs = CryptoJS.TripleDES.encrypt('123456', U.parse(key24), {
    iv: U.parse(CARD.keyCryptoPhone),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).toString();
  assert.equal(mine, cryptojs);

  // 换了密钥就必须变（否则说明 key 根本没参与运算）
  assert.notEqual(mine, tripleDesCbcEncrypt('123456', loginKeyFrom('00000000000000000000'), CARD.keyCryptoPhone));
  // iv 固定为 keyCryptoPhone，不是密钥本身
  assert.notEqual(mine, tripleDesCbcEncrypt('123456', key24, '00000000'));
});

test('登录请求的字段名与前端一致：TypeNum / UserNumber / PassWord', () => {
  // 这三个名字是从登录页 chunk 里读出来的，写错了就是 400
  const { params } = buildSignedBody(
    { TypeNum: 1, UserNumber: '2023001', PassWord: 'ENC' },
    { time: '20240101000000' },
  );
  assert.deepEqual(
    Object.keys(params).sort(),
    ['ContentType', 'PassWord', 'Sign', 'Time', 'TypeNum', 'UserNumber'],
  );
  // 前端签名 key 排序后是 ContentType 之外的那几个
  assert.equal(params.Sign, cryptoJsSign({ TypeNum: 1, UserNumber: '2023001', PassWord: 'ENC', Time: '20240101000000' }));
});

// ---------------------------------------------------------------- 差分测试

/**
 * 把前端那套流水线用 CryptoJS 原样复刻一遍，再和我的实现对比。
 * 这是本文件里最有价值的一条测试：它不是"我算的对不对"，
 * 而是"我和真正的客户端行为是否逐字节相同"。
 */
test('差分测试：签名+编码+加密，与 CryptoJS 复刻的前端流水线逐字节一致', () => {
  const cases = [
    { user: '2023001', password: '123456', random: '81654321098765432109', time: '20240101000000' },
    { user: '2023113', password: '000000', random: '11223344556677889900', time: '20260915103000' },
    { user: 'teacher01', password: 'aB3#xY', random: '55555555555555555555', time: '20251231235959' },
  ];

  for (const { user, password, random, time } of cases) {
    const key24 = loginKeyFrom(random);

    // ① 加密：前端 encryptBy3DESModeCBC(password, key24)
    const mineEnc = tripleDesCbcEncrypt(password, key24, CARD.keyCryptoPhone);
    const frontEnc = CryptoJS.TripleDES.encrypt(password, U.parse(key24), {
      iv: U.parse(CARD.keyCryptoPhone),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }).toString();
    assert.equal(mineEnc, frontEnc, `加密不一致：${user}`);

    // ② 签名：前端拦截器（注意尾竖线，且此时还没加 ContentType）
    const { params, body } = buildSignedBody(
      { TypeNum: 1, UserNumber: user, PassWord: mineEnc },
      { time },
    );
    const frontSign = cryptoJsSign({ TypeNum: 1, UserNumber: user, PassWord: frontEnc, Time: time });
    assert.equal(params.Sign, frontSign, `签名不一致：${user}`);

    // ③ 表单体：前端 for...in + encodeURIComponent
    let frontBody = '';
    for (const key in params) frontBody += `&${key}=${encodeURIComponent(params[key])}`;
    assert.equal(body, frontBody.slice(1), `表单体不一致：${user}`);
  }
});

// ---------------------------------------------------------------- 会话

/**
 * 只测序列化，不测落盘。
 * 不要在这里改 NJTS_HOME：store.js 的 ROOT 是**模块加载时**从它算出来的常量，
 * 改了之后再 import 会把 ROOT 永久指到临时目录（node --test 多个文件共享模块缓存），
 * 直接污染同一进程里的其它测试文件。而且真的 save() 一次会覆盖用户真实会话。
 */
test('cookie jar 能序列化/反序列化（登录握手靠它把随机数绑到同一个 session）', async () => {
  const { CookieJar } = await import('../src/http.js');
  const jar = new CookieJar();
  jar.absorb('http://aggrepay.njts.edu.cn:8080/easytong_app/GetRandomNumber', [
    'JSESSIONID=ABC123; Path=/; HttpOnly',
  ]);
  const back = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar.toJSON())));
  assert.match(back.header('aggrepay.njts.edu.cn'), /JSESSIONID=ABC123/);

  // 过期 cookie 不应被带回去
  jar.absorb('http://aggrepay.njts.edu.cn:8080/', ['JSESSIONID=; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
  assert.equal(jar.header('aggrepay.njts.edu.cn'), '');
});

test('能识别服务端报的剩余尝试次数（这个数字比报错本身重要）', () => {
  assert.equal(parseRemainingAttempts('密码错误，还可以输入5次'), 5);
  assert.equal(parseRemainingAttempts('密码错误,还可以输入 2 次'), 2);
  assert.equal(parseRemainingAttempts('随机数为空或session不一致'), null);
  assert.equal(parseRemainingAttempts(undefined), null);
});

// ---------------------------------------------------------------- 常量与解析

test('底地址与常量与逆向结果一致', () => {
  assert.equal(CARD.base, 'http://aggrepay.njts.edu.cn:8080/easytong_app');
  assert.equal(CARD.md5Key, 'ok15we1@oid8x5afd@');
  assert.equal(CARD.keyCrypto, '12347890');
  assert.equal(CARD.keyCryptoPhone, '12347890');
  assert.equal(CARD.loginKeyLength, 24);
});

test('pickTable 兼容数组/单对象/多种字段名', () => {
  assert.deepEqual(pickTable({ Table: [1, 2] }), [1, 2]);
  assert.deepEqual(pickTable({ Table: { a: 1 } }), [{ a: 1 }]);
  assert.deepEqual(pickTable({ data: [3] }), [3]);
  assert.deepEqual(pickTable({}), []);
});

test('pickNumber 能从字符串金额里取数', () => {
  assert.equal(pickNumber({ Balance: '12.34' }, ['Balance']), 12.34);
  assert.equal(pickNumber({ data: { Balance: '￥5.00' } }, ['Balance']), 5);
  assert.equal(pickNumber({}, ['Balance']), null);
});
