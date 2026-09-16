/**
 * Node 版本下限。
 *
 * ## 为什么要有这个文件
 *
 * 代码里用到 `Headers.getSetCookie()`（`undici` 的扩展，**Node 19.7+** 才有）。
 * 而每一处调用都写了守卫：
 *
 *     r.headers.getSetCookie?.() || []
 *     typeof res.headers.getSetCookie === 'function' ? ... : []
 *
 * 守卫本身是好习惯，但它把"版本不够"变成了**静默降级**：在 Node 18 上不报错、
 * 不抛异常，只是永远返回空数组 —— **一个 Set-Cookie 都吸收不到，会话链断在半路，
 * 用户最后只看到一句莫名其妙的"未登录"**。
 *
 * 这和"读不到就静默给个默认值"是同一类错误，已经在课表学年上害过一次
 * （`extractTerm` 退化成"第一个选项"，学年读成 2031，接口老老实实返回空列表，
 *  差点把"0 条课"报成"课表拿到了"）。
 *
 * 所以：**版本不够就直接拒绝启动，让它坏得响亮。**
 *
 * 版本下限与 `getSetCookie` 的耦合由 test/version.test.js 钉住 ——
 * 以后谁再引入需要更高版本的 API，那条测试会要求把下限一起改上去。
 */

/** 需要 Node ≥ 20（`Headers.getSetCookie()` 在 19.7 进入，取整到下一个 LTS） */
export const MIN_NODE_MAJOR = 20;

/**
 * 版本够不够。返回空串表示通过，否则返回给人看的说明。
 * 只接收版本字符串，便于直接测边界（不用真去装一个 Node 18）。
 */
export function nodeVersionProblem(version) {
  const major = Number(String(version ?? '').split('.')[0]);
  if (!Number.isFinite(major) || major <= 0) {
    return `读不出 Node 版本号（拿到的是 ${JSON.stringify(version)}）`;
  }
  if (major < MIN_NODE_MAJOR) {
    return `需要 Node ≥ ${MIN_NODE_MAJOR}，当前是 v${version}。`
      + '本工具用到 Headers.getSetCookie()（Node 19.7 起），版本不够时会静默收不到任何 cookie，'
      + '表现为"莫名其妙一直未登录"，所以这里直接拒绝启动。'
      + `升级 Node 即可（nvm install ${MIN_NODE_MAJOR} 或去 nodejs.org 下 LTS）。`;
  }
  return '';
}

/** 当前进程的版本够不够。 */
export function currentNodeProblem() {
  return nodeVersionProblem(process.versions.node);
}
