/**
 * 课表 → ICS
 *
 * 两个已知的坑（plan §4 M3）：
 *   1) 不用 RRULE + EXDATE 跳假期周：EXDATE 不会让 RRULE 的 COUNT 顺延，
 *      假期之后的所有事件会整体错位一周。这里改为**逐周展开 VEVENT**。
 *   2) 时区用 IANA 名（Asia/Shanghai）并附 VTIMEZONE，而不是手写偏移。
 */

import { serviceError } from './errors.js';

const pad = (n) => String(n).padStart(2, '0');

function toIcsDate(date, time = '00:00') {
  const [h, m] = time.split(':').map(Number);
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(h)}${pad(m)}00`
  );
}

/** 加/减天数，保持本地时间语义 */
function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

const WEEKDAY_INDEX = { 周一: 1, 星期一: 1, monday: 1, mon: 1, 周二: 2, 星期二: 2, tuesday: 2, tue: 2, 周三: 3, 星期三: 3, wednesday: 3, wed: 3, 周四: 4, 星期四: 4, thursday: 4, thu: 4, 周五: 5, 星期五: 5, friday: 5, fri: 5, 周六: 6, 星期六: 6, saturday: 6, sat: 6, 周日: 7, 星期日: 7, 星期天: 7, sunday: 7, sun: 7 };

export function weekdayIndex(day) {
  const key = String(day).trim().toLowerCase();
  return WEEKDAY_INDEX[key] ?? (Number(day) >= 1 && Number(day) <= 7 ? Number(day) : null);
}

/**
 * 展开课表为 ICS 事件。
 *
 * @param {object} opts
 * @param {string} opts.semesterStart 教学第 1 周的**周一**，YYYY-MM-DD
 * @param {number} opts.numTeachingWeeks
 * @param {number[]} [opts.excludedWeeks] 假期周（1-based，教学周序号），这些周不排课
 * @param {Array} opts.sessions 每节课：
 *        { course_name, teacher, room, day, period_start, period_end, weeks?: number[]|string }
 * @param {Record<number,[string,string]>} opts.periodTimes 节次 → [开始, 结束]，如 {1:['08:00','08:45']}
 * @param {string} [opts.timezone='Asia/Shanghai']
 * @param {string} [opts.calendarName]
 */
export function buildIcs({
  semesterStart,
  numTeachingWeeks,
  excludedWeeks = [],
  sessions = [],
  periodTimes = {},
  timezone = 'Asia/Shanghai',
  calendarName = 'NJTS 课表',
  now = new Date(),
}) {
  if (!semesterStart) {
    throw serviceError('缺少学期开始日期（教学第 1 周周一）', '请在 data/njts-terms.json 里补齐，或传 --semester-start');
  }
  if (!Object.keys(periodTimes).length) {
    throw serviceError('缺少节次时间表（第 N 节 = 几点到几点）', '请在 data/njts-terms.json 里补齐——不猜时间');
  }

  const start = new Date(`${semesterStart}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    throw serviceError(`semesterStart 不是合法日期：${semesterStart}`);
  }

  const excluded = new Set(excludedWeeks.map(Number));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//njts-cli//course schedule//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${timezone}`,
    ...vtimezone(timezone),
  ];

  let count = 0;
  let skipped = 0;

  for (const s of sessions) {
    const wd = weekdayIndex(s.day);
    if (!wd) {
      skipped += 1;
      continue;
    }
    const weeks = normalizeWeeks(s.weeks, numTeachingWeeks);
    const [pStart, pEnd] = periodTimes[String(s.period_start)] || [];
    if (!pStart || !pEnd) {
      skipped += 1;
      continue;
    }

    for (const week of weeks) {
      if (excluded.has(week)) continue;
      const dayOffset = (week - 1) * 7 + (wd - 1);
      const date = addDays(start, dayOffset);

      const startLocal = toIcsDate(date, pStart);
      const endLocal = s.period_end && periodTimes[String(s.period_end)]
        ? toIcsDate(date, periodTimes[String(s.period_end)][1])
        : toIcsDate(date, pEnd);

      lines.push(
        'BEGIN:VEVENT',
        `UID:njts-${week}-${wd}-${s.period_start}-${count}@njts-cli`,
        `DTSTAMP:${toIcsDate(now, `${pad(now.getHours())}:${pad(now.getMinutes())}`)}Z`,
        `DTSTART;TZID=${timezone}:${startLocal}`,
        `DTEND;TZID=${timezone}:${endLocal}`,
        `SUMMARY:${escapeText(s.course_name || '课程')}`,
        `LOCATION:${escapeText(s.room || '')}`,
        `DESCRIPTION:${escapeText([s.teacher && `教师：${s.teacher}`, `第 ${week} 教学周`, s.period_start && `第 ${s.period_start}-${s.period_end || s.period_start} 节`].filter(Boolean).join('\\n'))}`,
        'BEGIN:VALARM',
        'TRIGGER:-PT15M',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(`${s.course_name || '课程'} 15 分钟后开始`)}`,
        'END:VALARM',
        'END:VEVENT',
      );
      count += 1;
    }
  }

  lines.push('END:VCALENDAR');
  return { ics: `${lines.join('\r\n')}\r\n`, eventCount: count, skippedSessions: skipped };
}

function normalizeWeeks(weeks, total) {
  if (Array.isArray(weeks) && weeks.length) return weeks.map(Number).filter((w) => w >= 1 && w <= total);
  if (typeof weeks === 'string' && weeks.trim()) {
    const out = [];
    for (const part of weeks.split(/[,，、\s]+/)) {
      const range = part.match(/^(\d+)\s*[-~—]\s*(\d+)$/);
      if (range) {
        for (let w = Number(range[1]); w <= Number(range[2]); w++) out.push(w);
      } else if (/^\d+$/.test(part)) {
        out.push(Number(part));
      }
    }
    return out.filter((w) => w >= 1 && w <= total);
  }
  return Array.from({ length: total }, (_, i) => i + 1);
}

function escapeText(text = '') {
  return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** 只生成中国标准时间的 VTIMEZONE（无夏令时），够用且不会错 */
function vtimezone(tzid) {
  if (tzid !== 'Asia/Shanghai') return [];
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

// 末尾无额外依赖（错误构造器已在文件顶部 import）
