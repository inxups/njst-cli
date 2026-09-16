/**
 * 本地存储 —— 凭据、会话、缓存、快照。
 *
 * 目录：~/.njts-cli/         (0700)
 *   credentials.json         (0600) 统一身份认证：课表/成绩/请假
 *   card-credentials.json    (0600) 一卡通：学号 + 一卡通单独密码（与上面完全分离）
 *   session.json             CAS 会话 cookie
 *   card-session.json        etToken
 *   cache/                   课表/成绩 TTL 缓存
 *   snapshots/power.jsonl    电费余额快照
 *
 * 可用 NJTS_HOME 覆盖根目录（测试用）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = process.env.NJTS_HOME
  ? path.resolve(process.env.NJTS_HOME)
  : path.join(os.homedir(), '.njts-cli');

export const FILE = {
  credentials: path.join(ROOT, 'credentials.json'),
  cardCredentials: path.join(ROOT, 'card-credentials.json'),
  session: path.join(ROOT, 'session.json'),
  cardSession: path.join(ROOT, 'card-session.json'),
  vpnSession: path.join(ROOT, 'vpn-session.json'),
  cacheDir: path.join(ROOT, 'cache'),
  snapshotDir: path.join(ROOT, 'snapshots'),
  powerSnapshot: path.join(ROOT, 'snapshots', 'power.jsonl'),
};

/** 建目录并设为 0700（含父目录） */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* Windows 等平台可能不支持，忽略 */
  }
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写入 + 0600。凭据文件永远不通过命令行参数传递。 */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, file);
  return file;
}

export function removeFile(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 时序快照：一行一条 JSON，便于追加与统计 */
export function appendSnapshot(file, record) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function readSnapshots(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- TTL 缓存

const cacheFile = (key) => path.join(FILE.cacheDir, `${key.replace(/[^\\w.-]/g, '_')}.json`);

export function cacheGet(key, ttlSeconds) {
  const entry = readJson(cacheFile(key));
  if (!entry || typeof entry.at !== 'number') return null;
  if (ttlSeconds != null && (Date.now() - entry.at) / 1000 > ttlSeconds) return null;
  return entry.value;
}

export function cacheSet(key, value) {
  ensureDir(FILE.cacheDir);
  writeJson(cacheFile(key), { at: Date.now(), value });
}

export function cacheClear() {
  try {
    for (const name of fs.readdirSync(FILE.cacheDir)) {
      fs.unlinkSync(path.join(FILE.cacheDir, name));
    }
  } catch {
    /* ignore */
  }
}
