/**
 * DES 实现的参照向量测试。
 *
 * 参照值是怎么来的：用 Node + `--openssl-legacy-provider` 跑出的真实输出
 * （Node 24 默认已禁用单 DES，legacy provider 仍可用，正好拿来当参照）。
 * 其中 V3 是公开的标准 DES 测试向量，用于确认参照本身可信。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { desCbcEncrypt, desCbcDecrypt, desEncryptBlock, desDecryptBlock, des3EncryptBlock, tripleDesCbcEncrypt, tripleDesCbcDecrypt } from '../src/des.js';

test('标准 DES 测试向量（ECB 单块）', () => {
  const cipher = desEncryptBlock(Buffer.from('4E6F772069732074', 'hex'), Buffer.from('0123456789ABCDEF', 'hex'));
  assert.equal(cipher.toString('hex').toUpperCase(), '3FA40E8A984D4815');
});

test('标准向量可逆', () => {
  const key = Buffer.from('0123456789ABCDEF', 'hex');
  const plain = Buffer.from('4E6F772069732074', 'hex');
  assert.equal(desDecryptBlock(desEncryptBlock(plain, key), key).toString('hex').toUpperCase(), '4E6F772069732074');
});

test('易通协议向量：DES-CBC-PKCS7 key=iv=12347890（CryptoJS 兼容）', () => {
  assert.equal(desCbcEncrypt('123456', '12347890'), 'k2JQl7B27v4=');
  assert.equal(desCbcEncrypt('abc', '12347890'), 'TBGduGC3Msc=');
});

test('DES-CBC 往返', () => {
  for (const text of ['123456', 'abc', 'a'.repeat(32), '中文密码😀']) {
    assert.equal(desCbcDecrypt(desCbcEncrypt(text, '12347890'), '12347890'), text);
  }
});

test('PKCS7 填充长度：不足 8 字节也要补满一块', () => {
  // 8 字节整倍数时要额外补一整块，否则解密端会把最后一个字节当填充
  assert.equal(Buffer.from(desCbcEncrypt('12345678', '12347890'), 'base64').length, 16);
  assert.equal(Buffer.from(desCbcEncrypt('1234567', '12347890'), 'base64').length, 8);
});

// ---------------------------------------------------------------- 3DES

/**
 * 3DES 固化向量：期望值由 **CryptoJS 4.2.0 的 TripleDES** 实际跑出，
 * 不是自己推的（一卡通前端用的就是 CryptoJS）。写死在这里，
 * 这样以后改 des.js 不依赖 vendor 文件也会被抦住。
 */
const TRIPLE_DES_VECTORS = [
  ['123456789012345678901234', '12347890', '123456', 'O4XUbskfyNo='],
  ['AbCdEfGhIjKlMnOpQrStUvWx', '12347890', 'hello', 'rnukYyG3jqg='],
  ['123456789012345678901234', '00000000', '中文密码', 'Yt4IUFMphZuAaWOg2qbIvg=='],
  ['abcdefghijklmnopqrstuvwx', '12347890', '123456789012345678901234567890', 'g4s7OxackHIyiaDClvnxrF0ppaQwz6pehdJRnly/nww='],
];

test('3DES-CBC 与 CryptoJS 的参照向量一致', () => {
  for (const [key, iv, plain, expected] of TRIPLE_DES_VECTORS) {
    assert.equal(tripleDesCbcEncrypt(plain, key, iv), expected, `key=${key} plain=${plain}`);
  }
});

test('3DES 密钥顺序不能反（E_K1(D_K2(E_K3))) 是错的）', () => {
  // 用三段**不同**的子密钥才能区分顺序；A×24 这种退化情形区分不出
  const key = '123456789012345678901234';
  const k1 = Buffer.from(key.slice(0, 8));
  const k2 = Buffer.from(key.slice(8, 16));
  const k3 = Buffer.from(key.slice(16, 24));
  const block = Buffer.from('abcdefgh');
  const right = des3EncryptBlock(block, Buffer.from(key)).toString('hex');
  const wrong = desEncryptBlock(desDecryptBlock(desEncryptBlock(block, k3), k2), k1).toString('hex');
  assert.notEqual(right, wrong);
});

test('3DES 往返', () => {
  for (const [key, iv, plain] of TRIPLE_DES_VECTORS) {
    assert.equal(tripleDesCbcDecrypt(tripleDesCbcEncrypt(plain, key, iv), key, iv), plain);
  }
});

test('3DES 密钥必须是 24 字节（不是 16 或 8）', () => {
  assert.throws(() => tripleDesCbcEncrypt('x', '12347890', '12347890'), /24 字节/);
  assert.throws(() => tripleDesCbcEncrypt('x', '1234567890123456', '12347890'), /24 字节/);
});
