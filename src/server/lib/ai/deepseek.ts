/**
 * DeepSeek 结构化解析客户端（PRD FR-03.3–03.4）。
 *
 * 使用服务端已配置的 Anthropic 兼容端点（实测可用）：
 *   POST {DEEPSEEK_BASE_URL}/v1/messages
 *   headers: x-api-key / anthropic-version
 *
 * 硬性要求：
 *   - 返回受 schema 约束的草稿；
 *   - **含糊时间必须回问用户，禁止擅自生成具体时刻**（PRD FR-03.4）；
 *   - 任何含糊之处写入 ambiguities，由界面提示补充。
 */
import type { AiDraft } from '../../../shared/types';
import { config } from '../../config';

export type ParseResult =
  | { ok: true; draft: AiDraft; raw?: string }
  | {
      ok: false;
      error: string;
      kind: 'not_configured' | 'rejected' | 'timeout' | 'bad_output';
      /** 上游原始输出，仅供排错；已脱敏，不回显给浏览器 */
      raw?: string;
    };

export function isLlmConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

export function llmModel(): string {
  return process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
}

/** 可选的提醒预设；模型只能从这里选，避免编造奇怪的提前量 */
const ALLOWED_OFFSETS = [1440, 120, 60, 30, 10, 5];

const SYSTEM_PROMPT = `你是个人日程助手，把用户的一句话整理成严格 JSON。只输出 JSON，不要任何解释、不要 markdown 代码块。

字段定义：
{
  "kind": "event" | "task",
  "title": string,                  // 必填，简洁的事件/待办名称
  "start_at": string | null,         // 事件开始，ISO 8601 带时区偏移，如 "2026-10-14T15:00:00+08:00"
  "end_at": string | null,           // 事件结束，可空
  "due_date": string | null,         // 待办截止日期 "YYYY-MM-DD"
  "due_time": string | null,         // 待办截止时刻 "HH:mm"
  "location": string | null,
  "note": string | null,
  "reminder_enabled": boolean,
  "reminder_offsets": number[],      // 提前分钟数，只能取 ${ALLOWED_OFFSETS.join('/')}
  "ambiguities": string[]            // 需要用户补充的含糊点
}

判定规则：
1. 有明确开始时间的是 event；只是"要做什么"的是 task。
2. **时间含糊时绝不编造**：例如"下周找时间""有空的时候"，必须把 start_at 设为 null，
   并在 ambiguities 里写明需要用户补充什么（中文）。
3. "下午三点"=15:00，"上午九点"=09:00，"晚上八点"=20:00。相对日期以给定的当前时间为基准。
4. 用户没提提醒时 reminder_enabled 为 false、reminder_offsets 为空数组。
5. 用户提到"提前一小时和十分钟"这类明确表述时 reminder_enabled 为 true，
   reminder_offsets 取 [60,10]。
6. 无法从原文确定的字段一律给 null，不要猜测。`;

export type ParseContext = {
  /** 用户转写或手输的原文 */
  text: string;
  /** 当前时间（用于相对日期换算） */
  now: Date;
  timezone: string;
};

export async function parseToDraft(context: ParseContext): Promise<ParseResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { ok: false, kind: 'not_configured', error: '未配置 DEEPSEEK_API_KEY' };
  }

  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic').replace(/\/+$/, '');
  const model = llmModel();

  const localNow = formatWithOffset(context.now, context.timezone);
  const userPrompt = [
    `当前时间：${localNow}（时区 ${context.timezone}）`,
    `今天是 ${weekdayOf(context.now, context.timezone)}`,
    '',
    '用户说：',
    context.text,
  ].join('\n');

  try {
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        // 该模型会先输出 thinking 再输出正文，max_tokens 太小会被 thinking 吃光
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: AbortSignal.timeout(Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 60_000)),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, kind: 'rejected', error: `HTTP ${response.status}: ${sanitize(text).slice(0, 200)}` };
    }

    const payload = (await response.json()) as { content?: { type?: string; text?: string }[] };
    // 只取正文块，忽略 thinking
    const textBlock = payload.content?.find((b) => b.type === 'text' && typeof b.text === 'string');
    if (!textBlock?.text) {
      return { ok: false, kind: 'bad_output', error: '上游未返回正文内容（可能被 thinking 占满 token）' };
    }

    const parsed = extractJson(textBlock.text);
    if (!parsed) {
      return { ok: false, kind: 'bad_output', error: '上游返回的内容不是合法 JSON', raw: textBlock.text };
    }

    return { ok: true, draft: normalizeDraft(parsed), raw: textBlock.text };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const isTimeout = /abort|timeout|timed out/i.test(message);
    return { ok: false, kind: isTimeout ? 'timeout' : 'rejected', error: sanitize(message).slice(0, 200) };
  }
}

/** 模型可能把 JSON 包在 ```json 里，或前后带解释，这里稳健提取第一个完整对象 */
export function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const direct = JSON.parse(trimmed) as unknown;
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>;
  } catch {
    /* 继续用括号匹配 */
  }

  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 把模型输出收敛到受约束的草稿结构：类型不对就退回安全值，绝不透传任意内容 */
export function normalizeDraft(raw: Record<string, unknown>): AiDraft {
  const kind = raw.kind === 'task' ? 'task' : 'event';
  const offsets = Array.isArray(raw.reminder_offsets)
    ? [...new Set(raw.reminder_offsets.filter((v): v is number => typeof v === 'number' && ALLOWED_OFFSETS.includes(v)))]
    : [];

  const ambiguities = Array.isArray(raw.ambiguities)
    ? raw.ambiguities.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];

  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const draft: AiDraft = {
    kind,
    title: str(raw.title) ?? '',
    start_at: str(raw.start_at),
    end_at: str(raw.end_at),
    due_date: str(raw.due_date),
    due_time: str(raw.due_time),
    location: str(raw.location),
    note: str(raw.note),
    reminder_enabled: raw.reminder_enabled === true && offsets.length > 0,
    reminder_offsets: offsets.sort((a, b) => b - a),
    ambiguities,
  };

  // 事件缺开始时间、待办缺日期，都视为含糊，必须回问用户
  if (kind === 'event' && !draft.start_at && !ambiguities.some((a) => a.includes('时间'))) {
    draft.ambiguities.push('没有识别到明确的开始时间，请补充具体日期与时刻');
  }
  if (kind === 'task' && !draft.due_date && !ambiguities.some((a) => a.includes('日期'))) {
    draft.ambiguities.push('没有识别到截止日期，可留空或补充');
  }

  return draft;
}

/** 生成带时区偏移的本地时间字符串，避免模型按 UTC 误算 */
export function formatWithOffset(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;

  // offsetMs = 本地墙上时间 - UTC。东八区应为 +480 分钟，
  // 符号搞反会让模型按错误偏移换算相对日期（曾输出 -08:00）。
  const offsetMinutes = offsetMsOf(date, timeZone) / 60_000;
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;

  const hour = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:00${offset}`;
}

function offsetMsOf(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = Number(p.value);
  return Date.UTC(map.year!, map.month! - 1, map.day!, map.hour! % 24, map.minute!, map.second!) - date.getTime();
}

function weekdayOf(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'long' }).format(date);
}

function sanitize(text: string): string {
  return (text || '')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/\b(sk-)[A-Za-z0-9._\-]{8,}/gi, '$1***');
}

export { config };
