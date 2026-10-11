/**
 * 时区工具：不引入额外依赖，用 Intl 完成 Asia/Shanghai 换算。
 *
 * 关键规则（PRD 第 5 节）：
 * - 时间型数据按 UTC 存 timestamptz；
 * - 日期型数据（全天待办、扣费日）是“日历日期”，不当作 UTC 午夜。
 */
import { config } from '../config';

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = partsCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(timeZone, dtf);
  }
  return dtf;
}

/** 某时刻在指定时区的偏移量（毫秒） */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(instant);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour % 24, map.minute, map.second);
  return asUtc - instant.getTime();
}

/** 把“某时区的墙上时间”换算成绝对时刻 */
export function zonedToInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  timeZone: string = config.timezone,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // 两轮迭代足以覆盖夏令时边界
  let ts = guess - offsetMs(new Date(guess), timeZone);
  ts = guess - offsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** 把绝对时刻格式化为该时区的 'YYYY-MM-DD' */
export function instantToDateString(instant: Date, timeZone: string = config.timezone): string {
  const parts = formatter(timeZone).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

/** 把绝对时刻格式化为该时区的 'HH:MM' */
export function instantToTimeString(instant: Date, timeZone: string = config.timezone): string {
  const parts = formatter(timeZone).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return `${map.hour === '24' ? '00' : map.hour}:${map.minute}`;
}

/** 该时区“今天”的日期字符串 */
export function todayInTz(timeZone: string = config.timezone): string {
  return instantToDateString(new Date(), timeZone);
}

/** 两个日期字符串相差的天数（b - a） */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 日期字符串加天数 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** 某月天数 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 按自然月推进日期，遇到 29/30/31 日时落到“对应月份最后一天”（PRD FR-05 默认设计）。
 */
export function addMonthsClamped(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const totalMonths = (y * 12 + (m - 1)) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  const clampedDay = Math.min(d, daysInMonth(targetYear, targetMonth));
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}
