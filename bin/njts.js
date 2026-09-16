#!/usr/bin/env node
/**
 * njts —— 南京特殊教育师范学院校园命令行工具
 *
 * 为 AI agent 与脚本设计：stdout 恒为单个 JSON，退出码语义化。
 * 只读优先：不实现缴费、选课、请假提交、挂失、阀控。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { currentNodeProblem, MIN_NODE_MAJOR } from '../src/version.js';
import { EXIT } from '../src/errors.js';

/**
 * 版本不够就别启动。
 *
 * 放第一位：比代理自举还早（自举会重新拉起一个子进程，检查放在后面就白做）。
 * 为什么必须硬失败而不是警告 —— 见 src/version.js 的注释：
 * 版本不够时不会报错，只会静默收不到任何 cookie。
 */
const versionProblem = currentNodeProblem();
if (versionProblem) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      kind: 'unsupported',
      message: `需要 Node ≥ ${MIN_NODE_MAJOR}`,
      hint: versionProblem,
    },
  })}\n`);
  process.exit(EXIT.unsupported ?? 7);
}

const argv = process.argv.slice(2);

/**
 * 代理自举。
 *
 * Node 的内置 fetch（undici）**默认不看 HTTP_PROXY / HTTPS_PROXY 环境变量**——
 * 这点和 curl 不一样，很容易误判成"网络不通/域名被拦"。实测在 pi 沙盒里，
 * 所有请求都报 EAI_AGAIN，而换个工具就能通，原因就在这。
 *
 * 让 fetch 认这些环境变量的开关是 NODE_USE_ENV_PROXY=1，但它**只在进程启动时读取**，
 * 在代码里改 process.env 无效。所以这里检测到有代理、又没开开关时，把自己重新拉起来一次。
 *
 * 想强制直连（比如代理是给别的工具配的、不该用于校园网）时，设 NJTS_NO_PROXY=1。
 */
const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const hasProxy = PROXY_VARS.some((k) => process.env[k]);

if (hasProxy && !process.env.NODE_USE_ENV_PROXY && !process.env.NJTS_NO_PROXY) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(child.status ?? 1);
}

const { main, render, renderError } = await import('../src/cli.js');

main(argv)
  .then((result) => {
    render(result);
    process.exitCode = 0;
  })
  .catch((err) => {
    process.exitCode = renderError(err);
  });
