/**
 * 苏迪 CAS 用的 RSA —— 纯 BigInt 实现，无第三方依赖。
 *
 * 为什么不能用 node:crypto 的 publicEncrypt：
 *   学校用的是 Dave Shapiro 那套老 RSAUtils（security.js），它是**无填充的裸 RSA**：
 *   把明文字符按 16 位小端打包成整数，直接做 m^e mod n，再把结果转成 hex。
 *   而 node:crypto 只提供 PKCS#1 v1.5 / OAEP，加进去的填充会让服务端解出来一堆垃圾。
 *   所以这里按 RSAUtils 的语义**逐行对齐**重写。
 *
 * 关键细节（容易踩）：
 *   1) chunkSize = 2 * biHighIndex(modulus)，单位是**字节**，但等于明文一次推进的**字符数**。
 *      biFromHex 是"从右往左每 4 个 hex 字符取一个 16 位字"，
 *      所以带前导 "00" 的模数（本站就是 "008aed7e…"）会多出一个为 0 的字，
 *      biHighIndex 因此比"1024 位 = 64 个字"小 1，chunkSize = 126 而不是 128。
 *   2) 打包时用 charCodeAt（UTF-16 码元），digit = a[2j] + (a[2j+1] << 8)。
 *      ASCII 密码等价于"字节按 16 位小端打包"；非 ASCII 会溢出 16 位、
 *      与浏览器行为一致地出错，所以这里照样还原，不"顺手修好"。
 *   3) 输出用 biToHex 的语义：从最高非零字往下，每个字补足 4 位十六进制。
 *      密码短于一个块时结果正好 256 个字符——前端 `if (thisPwd.length != 256)`
 *      这个判断就是靠它成立的。
 *
 * 正确性由 test/rsa.test.js 锁定：用本地生成的密钥对做加解密往返，
 * 并断言真实模数下密文长度恰好是 256。
 */

const RADIX = 65536n; // 一个 16 位字

/** 按 RSAUtils.biFromHex 的切法把 hex 串转成 16 位字数组（低位在前） */
export function hexToDigits(hex) {
  const clean = String(hex).replace(/^0x/i, '');
  const digits = [];
  for (let i = clean.length; i > 0; i -= 4) {
    digits.push(BigInt(`0x${clean.slice(Math.max(i - 4, 0), i)}`));
  }
  return digits.length ? digits : [0n];
}

/** biHighIndex：最高非零字的下标 */
export function highIndex(digits) {
  let i = digits.length - 1;
  while (i > 0 && digits[i] === 0n) i -= 1;
  return i;
}

/** biToHex：从最高非零字往下输出，每个字 4 位（至少 4 位） */
export function digitsToHex(digits) {
  let out = '';
  for (let i = highIndex(digits); i >= 0; i -= 1) out += digits[i].toString(16).padStart(4, '0');
  return out;
}

/** 整数 → 16 位字数组（定长，低位在前） */
function toDigits(value, count) {
  const out = [];
  let v = value;
  for (let i = 0; i < count; i += 1) {
    out.push(v & 0xffffn);
    v >>= 16n;
  }
  return out;
}

const modPow = (base, exp, mod) => {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
};

/**
 * 等价于 RSAUtils.encryptedString(key, text)。
 * 返回十六进制密文；多块之间用空格连接（密码一般只有一块）。
 */
export function rsaEncryptRaw(text, { modulus, exponent }) {
  const modDigits = hexToDigits(modulus);
  const n = BigInt(`0x${String(modulus).replace(/^0x/i, '')}`);
  const e = BigInt(`0x${String(exponent).replace(/^0x/i, '')}`);

  // RSAUtils: this.chunkSize = 2 * biHighIndex(this.m)  —— 单位是字符数
  const chunkSize = 2 * highIndex(modDigits);
  if (chunkSize <= 0) throw new Error('RSA 模数太小：chunkSize 为 0');

  const codes = [];
  for (const ch of String(text)) {
    // 与浏览器一致：charCodeAt 取 UTF-16 码元
    const code = typeof ch === 'string' ? ch.charCodeAt(0) : Number(ch);
    codes.push(code);
  }
  // 不足一块时补 0（RSAUtils 的 `while (a.length % chunkSize != 0) a[i++] = 0`）
  while (codes.length % chunkSize !== 0) codes.push(0);
  if (codes.length === 0) codes.push(...new Array(chunkSize).fill(0));

  const blocks = [];
  for (let i = 0; i < codes.length; i += chunkSize) {
    // digit_j = a[2j] + (a[2j+1] << 8)
    let m = 0n;
    let place = 1n;
    for (let k = i; k < i + chunkSize; k += 2) {
      const digit = BigInt(codes[k] + (codes[k + 1] << 8));
      m += digit * place;
      place *= RADIX;
    }
    blocks.push(digitsToHex(toDigits(modPow(m, e, n), modDigits.length)));
  }
  return blocks.join(' ');
}

/** 本站在 login.js 里硬编码的公钥（不是动态下发，所以直接写死） */
export const NJTS_CAS_KEY = {
  exponent: '010001',
  modulus:
    '008aed7e057fe8f14c73550b0e6467b023616ddc8fa91846d2613cdb7f7621e3cada4cd5d812d627af6b87727ade4e26d26208b7326815941492b2204c3167ab2d53df1e3a2c9153bdb7c8c2e968df97a5e7e01cc410f92c4c2c2fba529b3ee988ebc1fca99ff5119e036d732c368acf8beba01aa2fdafa45b21e4de4928d0d403',
};

/** 本站 CAS 的密码加密 */
export function encryptCasPassword(plain) {
  return rsaEncryptRaw(plain, NJTS_CAS_KEY);
}
