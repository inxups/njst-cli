/**
 * 纯 JS 的 DES-CBC / 3DES-CBC / PKCS#7 —— 零依赖实现。
 *
 * 为什么不用 node:crypto：
 *   Node 24 / OpenSSL 3 把单 DES 归入 legacy provider，`des-cbc` 默认不可用
 *   （getCiphers() 里没有它，createCipheriv 抛 ERR_OSSL_EVP_UNSUPPORTED）。
 *   唯一替代是要求用户设 NODE_OPTIONS=--openssl-legacy-provider，这对一个
 *   CLI 来说太脆弱，所以这里自己实现。顺带把 3DES 也用同样的 DES 块拼出来，
 *   就不再依赖 OpenSSL 是否还留着 3DES。
 *
 * 用途（一卡通「易通」协议，常量来自 H5 前端 app.js）：
 *   - 登录密码：3DES-CBC-PKCS7，key = 补齐到 24 位的 /GetRandomNumber 随机串，iv = "12347890"
 *   - 其他密码字段：DES-CBC-PKCS7，key = iv = "12347890"
 *   均与前端 CryptoJS `DES/TripleDES.encrypt(...).toString()` 一致（输出 Base64）。
 *
 * 3DES 密钥顺序是 **实测** 出来的，不是猜的：先用三段**不同**的子密钥造基准
 * （A×24 这种退化情形区分不出顺序），再拿 CryptoJS 4.2.0 的 TripleDES 对照，
 * 确认 C = E_K3(D_K2(E_K1(P)))。test/des.test.js 把这些基准钉死。
 */

// ---------------------------------------------------------------- 置换表

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
  8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];

const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

const SBOXES = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

// ---------------------------------------------------------------- 位运算工具

const permute = (bits, table) => table.map((p) => bits[p - 1]).join('');

function bytesToBits(buf) {
  let out = '';
  for (const byte of buf) out += byte.toString(2).padStart(8, '0');
  return out;
}

function bitsToBytes(bits) {
  const out = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.substr(i * 8, 8), 2);
  return out;
}

// ---------------------------------------------------------------- DES 核心

function keySchedule(keyBits) {
  const pc1 = permute(keyBits, PC1); // 56 bits
  let c = pc1.slice(0, 28);
  let d = pc1.slice(28);
  const subkeys = [];
  for (const shift of SHIFTS) {
    c = c.slice(shift) + c.slice(0, shift);
    d = d.slice(shift) + d.slice(0, shift);
    subkeys.push(permute(c + d, PC2)); // 48 bits
  }
  return subkeys;
}

function feistel(rightBits, subkey) {
  const expanded = permute(rightBits, E); // 32 -> 48
  let xored = '';
  for (let i = 0; i < 48; i++) xored += expanded[i] === subkey[i] ? '0' : '1';

  let substituted = '';
  for (let box = 0; box < 8; box++) {
    const chunk = xored.substr(box * 6, 6);
    const row = parseInt(chunk[0] + chunk[5], 2);
    const col = parseInt(chunk.slice(1, 5), 2);
    substituted += SBOXES[box][row * 16 + col].toString(2).padStart(4, '0');
  }
  return permute(substituted, P); // 32 bits
}

function cryptBlock(blockBits, subkeys, decrypt) {
  const ip = permute(blockBits, IP);
  let left = ip.slice(0, 32);
  let right = ip.slice(32);

  const order = decrypt ? [...subkeys].reverse() : subkeys;
  for (const subkey of order) {
    const next = feistel(right, subkey);
    let xored = '';
    for (let i = 0; i < 32; i++) xored += left[i] === next[i] ? '0' : '1';
    left = right;
    right = xored;
  }
  return permute(right + left, FP);
}

const keyBitsOf = (key) => bytesToBits(Buffer.from(key));

// ---------------------------------------------------------------- 对外接口

/** 单块 DES（ECB）。plainBlock / key 均为 8 字节 Buffer，返回 8 字节 Buffer。 */
export function desEncryptBlock(plainBlock, key) {
  return bitsToBytes(cryptBlock(bytesToBits(plainBlock), keySchedule(keyBitsOf(key)), false));
}

export function desDecryptBlock(cipherBlock, key) {
  return bitsToBytes(cryptBlock(bytesToBits(cipherBlock), keySchedule(keyBitsOf(key)), true));
}

/**
 * 3DES（EDE3）单块加密：C = E_K3(D_K2(E_K1(P)))
 * key24 为 24 字节：K1=0..7, K2=8..15, K3=16..23。顺序经 CryptoJS 实测确认。
 */
export function des3EncryptBlock(plainBlock, key24) {
  return desEncryptBlock(
    desDecryptBlock(desEncryptBlock(plainBlock, key24.subarray(0, 8)), key24.subarray(8, 16)),
    key24.subarray(16, 24),
  );
}

export function des3DecryptBlock(cipherBlock, key24) {
  return desDecryptBlock(
    desEncryptBlock(desDecryptBlock(cipherBlock, key24.subarray(16, 24)), key24.subarray(8, 16)),
    key24.subarray(0, 8),
  );
}

const pkcs7Pad = (buf, size = 8) => {
  const pad = size - (buf.length % size);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
};

const pkcs7Unpad = (buf) => {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 8 || pad > buf.length) return buf;
  return buf.subarray(0, buf.length - pad);
};

/** 通用 CBC 循环；encryptBlock 为 (8字节Buffer) => 8字节Buffer */
function cbcEncrypt(padded, ivBuf, encryptBlock) {
  const blocks = [];
  let prev = ivBuf;
  for (let offset = 0; offset < padded.length; offset += 8) {
    const block = padded.subarray(offset, offset + 8);
    const xored = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) xored[i] = block[i] ^ prev[i];
    const encrypted = encryptBlock(xored);
    blocks.push(encrypted);
    prev = encrypted;
  }
  return Buffer.concat(blocks);
}

/** 通用 CBC 解密循环；decryptBlock 为 (8字节Buffer) => 8字节Buffer */
function cbcDecrypt(data, ivBuf, decryptBlock) {
  const out = [];
  let prev = ivBuf;
  for (let offset = 0; offset < data.length; offset += 8) {
    const block = data.subarray(offset, offset + 8);
    const decrypted = decryptBlock(block);
    const xored = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) xored[i] = decrypted[i] ^ prev[i];
    out.push(xored);
    prev = block;
  }
  return pkcs7Unpad(Buffer.concat(out));
}

/**
 * DES-CBC 加密，PKCS#7 填充，输出 Base64 —— 与 CryptoJS
 * `CryptoJS.DES.encrypt(text, key, {iv, mode: CBC, padding: Pkcs7}).toString()` 等价。
 */
export function desCbcEncrypt(plainText, key, iv = key) {
  const keyBuf = Buffer.from(key);
  const padded = pkcs7Pad(Buffer.from(plainText, 'utf8'));
  return cbcEncrypt(padded, Buffer.from(iv), (b) => desEncryptBlock(b, keyBuf)).toString('base64');
}

/** DES-CBC 解密（对称，主要供测试与排障用）。 */
export function desCbcDecrypt(cipherBase64, key, iv = key) {
  const keyBuf = Buffer.from(key);
  const data = Buffer.from(cipherBase64, 'base64');
  return cbcDecrypt(data, Buffer.from(iv), (b) => desDecryptBlock(b, keyBuf)).toString('utf8');
}

/**
 * 3DES-CBC 加密，PKCS#7，输出 Base64 —— 等价于 CryptoJS
 * `TripleDES.encrypt(text, CryptoJS.enc.Utf8.parse(key24), {iv, mode: CBC, padding: Pkcs7}).toString()`。
 *
 * 一卡通登录就用它：key 是服务器下发的随机数（补齐到 24 位），iv 固定 "12347890"。
 */
export function tripleDesCbcEncrypt(plainText, key24, iv) {
  const keyBuf = Buffer.from(key24, 'utf8');
  if (keyBuf.length !== 24) {
    throw new Error(`3DES 需要 24 字节密钥，收到 ${keyBuf.length} 字节（密钥是服务器下发的随机数，不要自己造）`);
  }
  const padded = pkcs7Pad(Buffer.from(plainText, 'utf8'));
  return cbcEncrypt(padded, Buffer.from(iv, 'utf8'), (b) => des3EncryptBlock(b, keyBuf)).toString('base64');
}

/** 3DES-CBC 解密（对称，供测试与排障用）。 */
export function tripleDesCbcDecrypt(cipherBase64, key24, iv) {
  const keyBuf = Buffer.from(key24, 'utf8');
  const data = Buffer.from(cipherBase64, 'base64');
  return cbcDecrypt(data, Buffer.from(iv, 'utf8'), (b) => des3DecryptBlock(b, keyBuf)).toString('utf8');
}
