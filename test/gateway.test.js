/**
 * 教务纯 HTTP 全链（src/gateway.js）的测试。
 *
 * 样本都是**真实的**，不是编的：
 *   · test/fixtures/kb-2026-1.json —— 2026-09-16 从课表接口拿到的完整 JSON（29 条课程）
 *   · test/fixtures/kbpage-selects.json —— 同一张课表页里 xnm/xqm 两个 select 的原文
 *
 * 链本身（门户 → SSO → 正方）要真会话才能跑，这里只测**能离线验的部分**：
 * 参数提取、改写、解析。链的实测结论记在 src/gateway.js 的头注释里。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractTerm,
  parseKbList,
  parseWeeks,
  parseSections,
  rewriteToGate,
  groupByWeekday,
  mergedJar,
  GATE,
  KB_PATH,
} from '../src/gateway.js';

const FIX = new URL('./fixtures/', import.meta.url);
const kb = JSON.parse(fs.readFileSync(new URL('kb-2026-1.json', FIX), 'utf8'));
const selects = JSON.parse(fs.readFileSync(new URL('kbpage-selects.json', FIX), 'utf8'));

/* ---------------------------------------------------------------- */

test('真实样本：接口返回的 29 条课程能全部解出来，字段对得上', () => {
  assert.equal(kb.kbList.length, 29, '样本本身变了？');
  const courses = parseKbList(kb.kbList);
  assert.equal(courses.length, 29);

  const first = courses[0];
  // 字段名来自接口原文（kcmc / xm / xqj / jcs / zcd / cdmc …），逐项核对
  assert.equal(first.name, '线性代数A');
  assert.equal(first.teacher, '教师甲');
  assert.equal(first.weekday, 1);
  assert.equal(first.weekdayName, '星期一');
  assert.equal(first.sections, '3-5');
  assert.deepEqual(first.sectionList, [3, 4, 5]);
  assert.equal(first.weeks, '4-9周');
  assert.deepEqual(first.weekList, [4, 5, 6, 7, 8, 9]);
  assert.equal(first.room, 'D310');
  assert.equal(first.roomFull, 'D栋教学楼310');
  assert.equal(first.building, 'D栋教学楼');
  assert.equal(first.campus, '江宁校区');
  assert.equal(first.credit, '3');
  assert.equal(first.hours, '48');
  assert.equal(first.className, '线性代数A-0002');
  assert.equal(first.classComposition, '智能0000;智能2622');
  assert.equal(first.courseCode, '30621033');
  assert.equal(first.nature, '必修');
  assert.equal(first.mark, '★');
  // 原始记录必须留着：字段对不上时要能对着看，而不是再抓一遍
  assert.equal(first.raw.kcmc, '线性代数A');
});

test('真实样本：29 条里没有一条丢字段（name/teacher/weekday/sections 全非空）', () => {
  const courses = parseKbList(kb.kbList);
  for (const c of courses) {
    assert.ok(c.name, `课程名空的: ${JSON.stringify(c.raw).slice(0, 80)}`);
    assert.ok(c.teacher, `${c.name} 没老师`);
    assert.ok(c.weekday >= 1 && c.weekday <= 7, `${c.name} 星期不对: ${c.weekday}`);
    assert.ok(c.sectionList.length > 0, `${c.name} 节次解不出来: ${c.sections}`);
    assert.ok(c.weekList.length > 0, `${c.name} 周次解不出来: ${c.weeks}`);
  }
});

test('周次：三种真实形状都要认（区间 / 多段 / 第N周）', () => {
  assert.deepEqual(parseWeeks('4-9周'), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parseWeeks('4-5周,7-13周,17周'), [4, 5, 7, 8, 9, 10, 11, 12, 13, 17]);
  assert.deepEqual(parseWeeks('第14周'), [14]);
  assert.deepEqual(parseWeeks('4周,7-17周'), [4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(parseWeeks(''), []);
  assert.deepEqual(parseWeeks('无'), []);
});

test('节次：字符串与数组都要对', () => {
  assert.deepEqual(parseSections('3-5'), [3, 4, 5]);
  assert.deepEqual(parseSections('3-5节'), [3, 4, 5]);
  assert.deepEqual(parseSections('11-14'), [11, 12, 13, 14]);
  assert.deepEqual(parseSections('1'), [1]);
  assert.deepEqual(parseSections(''), []);
});

test('学年/学期取自真实课表页的下拉框原文', () => {
  const t = extractTerm(selects.xnm + selects.xqm);
  assert.equal(t.xnm, '2026');
  assert.equal(t.xqm, '3');
  assert.ok(t.xnmOptions.length >= 10, '选项列表要给全，便于核对');
  assert.ok(t.xnmOptions.some((o) => o.value === '2026' && o.label === '2026-2027'));
});

test('读不到 selected 就返回空 —— 绝不许退化成"第一个选项"', () => {
  // 这就是我栽的那个坑：正方的第一个选项是空壳 `<option value="" >`，
  // 用 [^"'>\s]+ 会跳过它，"第一个选项"静默变成 2031（最高学年）。
  // 发出去还是个合法请求，接口老老实实返回空列表 —— 于是"0 条课"被报成成功。
  const noSelected = '<select name="xnm" id="xnm"><option value="" ></option>'
    + '<option value="2031">2031-2032</option><option value="2026">2026-2027</option></select>';
  const t = extractTerm(noSelected);
  assert.equal(t.xnm, '', '没有 selected 就不许瞎选一个');
  assert.equal(t.xqm, '', 'xqm 同理');

  // 也绝不能拿 label 当 selected（label 里出现过 selected 字样不算）
  assert.equal(extractTerm('').xnm, '');
});

test('selected 写在 value 前面也要认（两种渲染都见过）', () => {
  const a = '<select id="xnm"><option value="2026" selected="selected">2026-2027</option></select>';
  const b = '<select id="xnm"><option selected value="2025">2025-2026</option></select>';
  assert.equal(extractTerm(a).xnm, '2026');
  assert.equal(extractTerm(b).xnm, '2025');
});

test('门户给的教务地址必须改写到网关主机 —— 不许自己拼地址', () => {
  assert.equal(
    rewriteToGate('http://jwxt.njts.edu.cn/sso/Sudylogin'),
    `${GATE.jwxt}/sso/Sudylogin`,
  );
  assert.equal(
    rewriteToGate('https://jwxt.njts.edu.cn/sso/Sudylogin'),
    `${GATE.jwxt}/sso/Sudylogin`,
  );
  // 已经是网关地址的不动
  const already = `${GATE.jwxt}/jwglxt/xtgl/index_initMenu.html`;
  assert.equal(rewriteToGate(already), already);
});

test('按星期分组，先给课多的天排好节次顺序', () => {
  const byDay = groupByWeekday(parseKbList(kb.kbList));
  assert.deepEqual(Object.keys(byDay).slice(0, 3), ['星期一', '星期二', '星期三']);
  const mon = byDay['星期一'];
  const starts = mon.map((c) => c.sectionList[0]);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), '星期一应按起始节次升序');
  assert.equal(mon[0].name, '线性代数A');
});

test('cookie jar 按 {域名:{名:值}} 的形状读 —— 这个形状踩过坑', () => {
  // 一度按 {名:值} 去拼，拼出「域名=[object Object]」，服务器当没登录，
  // 拿到一个 302 却得出"域不对"的错误结论。空目录只许返回空 jar。
  const { jar, sources } = mergedJar('/nonexistent-dir-for-test');
  assert.equal(jar.size, 0);
  assert.deepEqual(sources, []);
});

test('课表接口地址与实测一致（页面 xskbcx.js 自己调的那个）', () => {
  assert.match(KB_PATH, /^\/jwglxt\/kbcx\/xskbcx_cxXsgrkb\.html\?gnmkdm=N253508&sf_request_type=ajax$/);
});

test('全链只读：gateway.js 里不许出现任何写操作', () => {
  const src = fs.readFileSync(new URL('../src/gateway.js', import.meta.url), 'utf8');
  for (const bad of [
    'ticketlogin?uid', // 那是跟跳时 URL 里出现的，不该被当成我们要调的东西 —— 但更不该出现写接口
    'xkkg', 'submit', 'save', 'PayFee', 'update', 'delete', 'Cancel',
  ]) {
    if (bad === 'ticketlogin?uid') continue; // 跟跳会出现，见下方单独断言
    assert.ok(!src.includes(bad), `gateway.js 不该出现 ${bad}`);
  }
  // 只允许 GET/POST 到查询路径
  const calls = [...src.matchAll(/method:\s*'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(calls)], ['POST'], '只该有 POST（课表查询），没有别的动作');
});

test('★ 契约：schedule --http 失败必须退 2，不能退 0', async () => {
  // 这条是补一个真实存在的坑：以前这个分支无论成败都走到函数末尾，
  // **退出码恒为 0** —— 而 README / QUICKSTART / SKILL 三份文档都写着「2 = 未登录」。
  // 文档和行为对不上，用脚本包这个命令的人会被坑（`if njts schedule; then …` 永远为真）。
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'njts-empty-home-'));
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../bin/njts.js', import.meta.url)), 'schedule', '--http'], {
      env: { ...process.env, NJTS_HOME: empty, NJTS_NO_PROXY: '1' },
      stdio: 'pipe',
    });
    assert.fail('空会话目录下竟然退 0 —— 契约（2 = 未登录）又和实现脱钩了');
  } catch (e) {
    assert.equal(e.status, 2, `应该是 2（unauthenticated），实际 ${e.status}`);
    const out = JSON.parse(e.stdout.toString());
    assert.equal(out.ok, false);
    assert.equal(out.error.kind, 'unauthenticated');
    assert.match(out.error.message, /会话/, '消息要说清是哪一段的会话');
    // hint 不许出现自相重复的尾巴（unauthenticated() 会自己拼一句，别再叠一遍）
    assert.ok(!/已失效或未登录.*已失效或未登录/.test(out.error.hint), 'hint 里重复了');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
