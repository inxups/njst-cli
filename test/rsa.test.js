/**
 * RSA（苏迪 CAS 用的无填充裸 RSA）测试。
 *
 * 验证思路：本地生成一对密钥，用**真实算法**加密、再用 Node 的私钥解密往返。
 * 这样既验证了打包/取模/转 hex 全链路，又不需要真实服务端的私钥。
 *
 * 另外断言"真实模数下密文长度恰好 256 字符"——前端的
 * `if (thisPwd.length != 256)` 就是靠这个成立的，长度不对说明
 * chunkSize 推导错了（最可能的错法：忘了模数前导 "00" 会多出一个 0 字）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { rsaEncryptRaw, hexToDigits, highIndex, digitsToHex, NJTS_CAS_KEY, encryptCasPassword } from '../src/rsa.js';

const b64url = (buf) => buf.toString('base64url');

test('hexToDigits / highIndex 按 biFromHex 的切法工作', () => {
  // 4 个 hex 字符 = 1 个字
  assert.deepEqual(hexToDigits('0001'), [1n]);
  assert.deepEqual(hexToDigits('00010002'), [2n, 1n]); // 低位在前
  // 带前导 00 的 1024 位模数：6... 长度不是 4 的倍数时最左边单独成字
  const digits = hexToDigits(NJTS_CAS_KEY.modulus);
  assert.equal(digits.length, 65); // 258 个 hex 字符 → 65 个字
  assert.equal(digits[64], 0n); // 最左边那个字是 0
  assert.equal(highIndex(digits), 63);
});

test('digitsToHex 只去掉高于最高非零「字」的部分（与 biToHex 一致）', () => {
  // digits=[0,0,1]：最高非零字下标是 2，所以三个字都会输出（含中间的两个零字）
  assert.equal(digitsToHex([0n, 0n, 1n]), '000100000000');
  // digits=[0x1234,0]：最高非零字下标是 0，上位的 0 字不输出
  assert.equal(digitsToHex([0x1234n, 0n]), '1234');
  // 全 0 时保底 4 位
  assert.equal(digitsToHex([0n]), '0000');
});

test('真实模数下密文长度恰好 256 字符（关键：证明 chunkSize 推导正确）', () => {
  for (const pw of ['12345678', 'a', 'this-is-a-longer-password-123']) {
    const hex = encryptCasPassword(pw);
    assert.equal(hex.length, 256, `密码 "${pw}" 的密文长度应为 256，实际 ${hex.length}`);
    assert.match(hex, /^[0-9a-f]{256}$/);
  }
});

test('chunkSize 必须按"带前导 00 的模数多一个 0 字"来算', () => {
  // 站点的模数是 "008aed7e..."（258 个 hex 字符）→ 65 个字 → biHighIndex 63 → chunkSize 126
  const digits = hexToDigits(NJTS_CAS_KEY.modulus);
  assert.equal(2 * highIndex(digits), 126);
  // 如果天真地认为"1024 位 = 64 个字、chunkSize = 128"，块会多 2 个字符，
  // 结果长度就不会是 256。这里用一个超长密码把它暴露出来：
  const long = 'x'.repeat(200); // 200 > 126，会分成两块
  const hex = encryptCasPassword(long);
  assert.equal(hex.split(' ').length, 2, '200 字符应当切成 2 块');
  for (const block of hex.split(' ')) assert.equal(block.length, 256);
});

test('加密是确定性的且与明文一一对应', () => {
  assert.equal(encryptCasPassword('123456'), encryptCasPassword('123456'));
  assert.notEqual(encryptCasPassword('123456'), encryptCasPassword('123457'));
});

test('往返：本地生成的密钥对能解回原文', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const jwk = publicKey.export({ format: 'jwk' });
  const modulus = Buffer.from(jwk.n, 'base64url').toString('hex');
  const exponent = Buffer.from(jwk.e, 'base64url').toString('hex');

  const modBytes = Buffer.from(modulus, 'hex').length;
  const chunkSize = 2 * highIndex(hexToDigits(modulus));

  for (const plain of ['12345678', 'hello', 'p@ss word!']) {
    const hex = rsaEncryptRaw(plain, { modulus, exponent });
    // 补到模数长度后用无填充私钥解密
    const cipher = Buffer.from(hex.padStart(modBytes * 2, '0'), 'hex');
    const raw = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_NO_PADDING },
      cipher,
    );
    // 解密结果是模数长度的大端整数；明文占末尾 chunkSize 字节（小端）
    const tail = raw.subarray(raw.length - chunkSize).reverse();
    const expected = Buffer.from(plain, 'utf8');
    assert.equal(tail.subarray(0, expected.length).toString('utf8'), plain);
    // 剩下的应当是补的 0
    for (const b of tail.subarray(expected.length)) assert.equal(b, 0);
  }
});

test('公钥常量与 login.js 里硬编码的一致', () => {
  assert.equal(NJTS_CAS_KEY.exponent, '010001');
  assert.equal(NJTS_CAS_KEY.modulus.length, 258);
  assert.ok(NJTS_CAS_KEY.modulus.startsWith('008aed7e'));
  assert.ok(NJTS_CAS_KEY.modulus.endsWith('928d0d403'));
  assert.equal(b64url(Buffer.from(NJTS_CAS_KEY.modulus.replace(/^00/, ''), 'hex')).length, 171);
});
