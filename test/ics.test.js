/**
 * ICS 与输出契约测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, weekdayIndex } from '../src/ics.js';
import { NjtsError, EXIT, detectGatewayPage } from '../src/errors.js';
import { draftLeave } from '../src/cli.js';
import { normalizeLeave, pickCurrentApproval } from '../src/ehall.js';

const periodTimes = {
  1: ['08:00', '08:45'],
  2: ['08:50', '09:35'],
  3: ['09:50', '10:35'],
};

test('weekdayIndex 认得中文与英文', () => {
  assert.equal(weekdayIndex('周一'), 1);
  assert.equal(weekdayIndex('星期三'), 3);
  assert.equal(weekdayIndex('Friday'), 5);
  assert.equal(weekdayIndex('7'), 7);
  assert.equal(weekdayIndex('莫名其妙'), null);
});

test('ICS 逐周展开，事件数 = 周数 × 节次', () => {
  const { ics, eventCount } = buildIcs({
    semesterStart: '2026-09-07', // 周一
    numTeachingWeeks: 4,
    sessions: [{ course_name: '高等数学', day: '周一', period_start: 1, period_end: 2, weeks: [1, 2, 3, 4], room: 'A201', teacher: '张老师' }],
    periodTimes,
  });
  assert.equal(eventCount, 4);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 4);
  assert.match(ics, /DTSTART;TZID=Asia\/Shanghai:20260907T080000/);
  assert.match(ics, /DTEND;TZID=Asia\/Shanghai:20260907T093500/);
  assert.match(ics, /BEGIN:VTIMEZONE/);
  assert.match(ics, /BEGIN:VALARM/);
});

test('假期周被排除，且**后续周不发生错位**（不用 RRULE+EXDATE 的原因）', () => {
  const { ics, eventCount } = buildIcs({
    semesterStart: '2026-09-07',
    numTeachingWeeks: 4,
    excludedWeeks: [2],
    sessions: [{ course_name: '英语', day: '周一', period_start: 1, weeks: [1, 2, 3, 4] }],
    periodTimes,
  });
  assert.equal(eventCount, 3, '第 2 周应被跳过');
  // 第 3 周 = 9/7 + 14 天 = 9/21，第 4 周 = 9/28
  assert.match(ics, /20260921T080000/);
  assert.match(ics, /20260928T080000/);
  assert.ok(!ics.includes('20260914T080000'), '第 2 周（9/14）不应出现');
});

test('weeks 支持字符串区间', () => {
  const { eventCount } = buildIcs({
    semesterStart: '2026-09-07',
    numTeachingWeeks: 8,
    sessions: [{ course_name: 'X', day: '周三', period_start: 1, weeks: '1-3,5' }],
    periodTimes,
  });
  assert.equal(eventCount, 4);
});

test('缺少节次表或学期开始时报错而不是猜', () => {
  assert.throws(() => buildIcs({ numTeachingWeeks: 3, sessions: [], periodTimes }), (e) => e.kind === 'service');
  assert.throws(() => buildIcs({ semesterStart: '2026-09-07', numTeachingWeeks: 3, sessions: [], periodTimes: {} }), (e) => e.kind === 'service');
});

test('错误退出码与 plan §3.2 一致', () => {
  assert.equal(new NjtsError('unauthenticated', 'x').exitCode, 2);
  assert.equal(new NjtsError('login', 'x').exitCode, 3);
  assert.equal(new NjtsError('network', 'x').exitCode, 4);
  assert.equal(new NjtsError('service', 'x').exitCode, 5);
  assert.equal(new NjtsError('input', 'x').exitCode, 6);
  assert.equal(new NjtsError('unsupported', 'x').exitCode, 7);
  assert.equal(EXIT.ok, 0);
});

test('网关 502 页被翻译成 http 提示', () => {
  const html = '<h2>出错啦！该网站无法访问</h2><p>请检查请求地址以及 http/https 协议是否正确</p>';
  const err = detectGatewayPage(html);
  assert.ok(err);
  assert.equal(err.kind, 'network');
  assert.match(err.hint, /http:\/\//);
  assert.equal(detectGatewayPage('<html>正常页面</html>'), null);
});

test('请假草稿不提交，且绝不用未验证的规则编审批链', () => {
  // 未验证（verified 缺失）→ 必须拒绝给出审批链，宁可留空也不误导
  const unverified = draftLeave('周三下午发烧去医院，想请一天', { thresholds: [{ maxDays: 1, approvers: ['辅导员'] }] });
  assert.equal(unverified.draft.type, '病假');
  assert.equal(unverified.draft.days, 1);
  assert.equal(unverified.approvalChain, null, '规则未标 verified 时不得给出审批链');
  assert.match(unverified.approvalChainNote, /未/);
  assert.ok(unverified.warnings.length > 0, '未验证时必须有 warning');
  assert.match(unverified.reminder, /不会提交/);
});

test('请假草稿：已确认的规则（verified）才用于算审批链', () => {
  const verified = draftLeave('周三下午发烧去医院，想请一天', {
    verified: true,
    thresholds: [{ maxDays: 1, approvers: ['辅导员'] }],
    materials: { 病假: ['病历'] },
  });
  assert.deepEqual(verified.approvalChain, ['辅导员']);
  assert.deepEqual(verified.materials, ['病历']);
  assert.deepEqual(verified.warnings, []);
});

test('请假记录归一化 + 定位当前审批人', () => {
  const flow = [{ approverName: '王老师', status: '已通过' }, { approverName: '李院长', status: '待审批' }];
  const record = normalizeLeave(
    { id: '1', leaveType: '2', startTime: '2026-09-16 13:00:00', endTime: '2026-09-16 18:00:00', days: 0.5, reason: '看病', flow },
    { 2: '病假' },
  );
  assert.equal(record.type, '病假');
  assert.equal(record.currentApprover, '李院长');
  assert.equal(record.days, 0.5);
});

test('pickCurrentApproval 对空流程不炸', () => {
  assert.deepEqual(pickCurrentApproval(null), { approver: '', status: '' });
  assert.deepEqual(pickCurrentApproval([]), { approver: '', status: '' });
});
