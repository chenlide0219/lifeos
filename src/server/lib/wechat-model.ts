/**
 * V1.1 模型集成层（PRD 4、5）。
 *
 * 职责边界（PRD 1.3 的核心约束）：
 *   - **Jev** 只做受控意图路由：在固定选项里挑一个，不生成自由文本；
 *   - **DeepSeek** 只做字段抽取与草稿补丁：输出受约束的 JSON；
 *   - **权限、状态转换、校验、查询与写入全部由服务端负责**。
 *     模型输出置信度只用于路由与澄清，**永不授权写库**。
 *
 * 关键安全默认：**任何模型故障都不得触发未确认写入**（PRD 4.3、10）。
 * 因此本层所有函数在失败时返回明确的失败结果，由上层决定追问还是报错，
 * 绝不"猜一个草稿继续"。
 */
import { choiceOf, jevSystemOne, type JevQuestion } from './ai/jev';
import { callLlmRaw, formatWithOffset, parseToDraft } from './ai/deepseek';
import type { AiDraft } from '../../shared/types';
import { emptyDraft, normalizeOffsets, type Draft, type DraftKind } from './wechat-draft';
import { config } from '../config';

/**
 * 是否允许调用模型。
 *
 * 用于在无凭据环境（本地/测试）退回确定性行为，避免"发一条消息就抛异常"。
 * 生产必须为默认值 1：模型是 V1.1 自然语言路径的必要组件。
 */
export function modelCallsEnabled(): boolean {
  return (process.env.WECHAT_MODEL_CALLS ?? '1') !== '0';
}

/* ────────────────────────── 意图路由 ────────────────────────── */

/** 第一阶段语义类别（PRD 4.2）；枚举名可自定，语义边界不可变 */
export type Intent =
  | 'create'
  | 'query'
  | 'patch_draft'
  | 'unsupported_operation'
  | 'out_of_scope'
  | 'unclear';

export const INTENT_CRITERIA: Record<Intent, string> = {
  create: '用户想新建一个日程或待办（说出一件要做的事或一个安排）',
  query: '用户想查看已有的安排或待办（如今天有什么、明天有什么、某天有什么）',
  patch_draft: '用户在补充或修改**正在待确认的那条草稿**（如补充时间、改地点、说不要提醒）',
  unsupported_operation:
    '用户想修改、取消、删除、完成或重开一件**已经保存**的事项',
  out_of_scope: '闲聊、知识问答、写代码等与日程待办无关的内容',
  unclear: '无法判断用户想做什么',
};

export type ClassifyResult =
  | { ok: true; intent: Intent; confidence: number; route: string }
  | { ok: false; error: string; kind: string };

/** 供测试与缓存使用的稳定问题定义 */
export function intentQuestion(): JevQuestion {
  return {
    type: 'choice',
    instructions:
      '判断这条用户消息属于哪一类。只依据消息本身与给出的草稿状态，不要猜测用户没说的话。',
    criteria: INTENT_CRITERIA,
  };
}

/**
 * 用 Jev 判定意图。
 *
 * 传入活动草稿的**结构化摘要**（而非完整聊天历史）：PRD 4.3 明确只发送
 * 当前消息、必要的草稿结构及固定时间基准。
 */
export async function classifyIntent(
  text: string,
  context: { hasActiveDraft: boolean; draftSummary?: string | null; now: Date; fetchImpl?: typeof fetch },
): Promise<ClassifyResult> {
  if (!modelCallsEnabled()) {
    return { ok: false, error: '模型调用已关闭（WECHAT_MODEL_CALLS=0）', kind: 'disabled' };
  }

  const state = [
    `当前时间：${formatWithOffset(context.now, config.timezone)}（时区 ${config.timezone}）`,
    context.hasActiveDraft
      ? `当前有一条尚未保存的草稿：${context.draftSummary ?? '（详情略）'}`
      : '当前没有未保存的草稿',
    '',
    '用户消息：',
    text,
  ].join('\n');

  const result = await jevSystemOne({
    state,
    questions: { intent: intentQuestion() },
    fetchImpl: context.fetchImpl,
  });

  if (!result.ok) {
    return { ok: false, error: result.error, kind: result.kind };
  }

  const answer = choiceOf(result.answers, 'intent');
  if (!answer) {
    return { ok: false, error: '意图问题的答案不是 choice 类型', kind: 'bad_output' };
  }
  if (!(answer.choice in INTENT_CRITERIA)) {
    return { ok: false, error: `返回了未定义的意图「${answer.choice}」`, kind: 'bad_output' };
  }

  return { ok: true, intent: answer.choice as Intent, confidence: answer.confidence, route: result.route };
}

/* ────────────────────────── 字段抽取 ────────────────────────── */

export type ExtractResult =
  | { ok: true; draft: Draft; ambiguities: string[] }
  | { ok: false; error: string; kind: string };

function draftKind(value: unknown): DraftKind {
  return value === 'task' ? 'task' : 'event';
}

function toText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 把 DeepSeek 的 AiDraft 映射为内部草稿。
 *
 * 两个必须守住的点：
 * - **绝对日期相对解析基准**：相对日期用消息入站时冻结的基准解释，
 *   重试不得用新的"现在"重新解释"明天"（PRD 5）。
 * - **providedFields 只记录真正出现过的字段**：类型转换时不得凭空生成字段（16.1-5）。
 */
export function toDraft(ai: AiDraft): { draft: Draft; ambiguities: string[] } {
  const kind = draftKind(ai.kind);
  const draft: Draft = { ...emptyDraft(kind) };

  draft.title = (ai.title ?? '').trim();
  if (draft.title) draft.providedFields.push('title');

  if (kind === 'event') {
    if (ai.start_at) {
      const parsed = new Date(ai.start_at);
      if (!Number.isNaN(parsed.getTime())) {
        draft.startAt = parsed.toISOString();
        draft.providedFields.push('startAt');
      }
    }
    if (ai.end_at) {
      const parsed = new Date(ai.end_at);
      if (!Number.isNaN(parsed.getTime())) {
        draft.endAt = parsed.toISOString();
        draft.providedFields.push('endAt');
      }
    }
  } else {
    if (ai.due_date) {
      draft.dueDate = ai.due_date;
      draft.providedFields.push('dueDate');
    }
    if (ai.due_time) {
      draft.dueTime = ai.due_time.slice(0, 5);
      draft.providedFields.push('dueTime');
    }
  }

  if (ai.location) {
    draft.location = ai.location;
    draft.providedFields.push('location');
  }
  if (ai.note) {
    draft.note = ai.note;
    draft.providedFields.push('note');
  }

  if (ai.reminder_enabled === true && Array.isArray(ai.reminder_offsets) && ai.reminder_offsets.length > 0) {
    draft.reminderEnabled = true;
    draft.reminderOffsets = normalizeOffsets(ai.reminder_offsets);
    draft.providedFields.push('reminder');
  }

  // "不要提醒"必须与"没说提醒"区分开（16.1-2）
  const ambiguities = Array.isArray(ai.ambiguities) ? ai.ambiguities.filter((a) => a && a.trim()) : [];
  return { draft, ambiguities };
}

/**
 * 从一句话抽取**新草稿**。
 * 相对日期以 `parseBasisAt` 为基准（该值来自入站消息，重试不变）。
 */
export async function extractNewDraft(text: string, parseBasisAt: Date): Promise<ExtractResult> {
  if (!modelCallsEnabled()) {
    return { ok: false, error: '模型调用已关闭（WECHAT_MODEL_CALLS=0）', kind: 'disabled' };
  }

  const parsed = await parseToDraft({ text, now: parseBasisAt, timezone: config.timezone });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, kind: parsed.kind };
  }

  const { draft, ambiguities } = toDraft(parsed.draft);
  return { ok: true, draft, ambiguities };
}

/* ────────────────────────── 草稿补丁 ────────────────────────── */

const PATCH_SYSTEM_PROMPT = `你是日程助手。用户正在确认一条**尚未保存的草稿**，现在说了新的内容。
请判断这条新内容要修改草稿的哪些字段，只输出 JSON，不要解释、不要 markdown。

输出结构（未提到的字段一律不要出现）：
{
  "title": string,                       // 仅当用户明确给出新的标题
  "start_at": string,                    // 事件开始，ISO 8601 带时区偏移
  "end_at": string,
  "due_date": string,                    // 待办截止 "YYYY-MM-DD"
  "due_time": string,                    // 待办截止 "HH:mm"
  "location": string,
  "note": string,
  "reminder_declined": boolean,          // 仅当用户明确说"不要提醒/不用提醒"
  "reminder_enabled": boolean,
  "reminder_offsets": number[],          // 提前分钟数，只能取 1440/120/60/30/10/5
  "convert_to": "event" | "task",        // 仅当用户明确要求改成另一种类型
  "ambiguous": string                    // 无法确定时写明原因，此时不要输出上面任何字段
}

规则：
1. 用户说"下午三点"这类时间补充时，结合草稿已有的日期推出完整时间；草稿没有日期就只回 ambiguous。
2. 用户没有提到的字段，绝对不要输出，也不要补默认值。
3. 不要编造地点、备注。`;

export type PatchResult =
  | { ok: true; patch: Record<string, unknown>; ambiguous: string | null }
  | { ok: false; error: string; kind: string };

/** 让模型基于"当前草稿 + 新内容"给出字段补丁 */
export async function extractDraftPatch(
  text: string,
  current: Draft,
  parseBasisAt: Date,
): Promise<PatchResult> {
  if (!modelCallsEnabled()) {
    return { ok: false, error: '模型调用已关闭（WECHAT_MODEL_CALLS=0）', kind: 'disabled' };
  }

  const summary = draftSummary(current);
  const userPrompt = [
    `当前时间：${formatWithOffset(parseBasisAt, config.timezone)}（时区 ${config.timezone}）`,
    `当前草稿：${summary}`,
    '',
    `用户补充/修改：${text}`,
    '请只输出需要修改的字段。',
  ].join('\n');

  const result = await callLlmRaw(PATCH_SYSTEM_PROMPT, userPrompt);
  if (!result.ok) return { ok: false, error: result.error, kind: result.kind };

  const ambiguous = toText(result.object.ambiguous);
  return { ok: true, patch: result.object, ambiguous };
}

/* ────────────────────────── 查询条件抽取 ────────────────────────── */

export type QuerySpec = {
  /** 相对日期关键词：today | tomorrow | week | date */
  preset: 'today' | 'tomorrow' | 'week' | 'date';
  /** preset=date 时的目标日期 */
  date: string | null;
  /** 是否只看事件或只看待办 */
  filter: 'all' | 'event' | 'task';
};

const QUERY_SYSTEM_PROMPT = `你是日程助手。用户想查询已有安排，请只输出 JSON，不要解释。

输出结构：
{
  "preset": "today" | "tomorrow" | "week" | "date",
  "date": string,          // 仅 preset=date 时给出 "YYYY-MM-DD"
  "filter": "all" | "event" | "task"
}

规则：
1. "今天/今日" → today；"明天/明日" → tomorrow；"未来七天/这周/接下来" → week；
   指定某天（如"10 月 20 号""下周三"）→ date 并给出 YYYY-MM-DD。
2. 用户只问日程 → event；只问待办/要做的事 → task；没限定 → all。
3. 相对日期以给定的当前时间为基准。`;

export type QueryParseResult =
  | { ok: true; spec: QuerySpec }
  | { ok: false; error: string; kind: string };

export async function extractQuery(
  text: string,
  parseBasisAt: Date,
): Promise<QueryParseResult> {
  if (!modelCallsEnabled()) {
    return { ok: false, error: '模型调用已关闭（WECHAT_MODEL_CALLS=0）', kind: 'disabled' };
  }

  const userPrompt = [
    `当前时间：${formatWithOffset(parseBasisAt, config.timezone)}（时区 ${config.timezone}）`,
    '',
    `用户查询：${text}`,
  ].join('\n');

  const result = await callLlmRaw(QUERY_SYSTEM_PROMPT, userPrompt);
  if (!result.ok) return { ok: false, error: result.error, kind: result.kind };

  const object = result.object;
  const presetRaw = object.preset;
  const preset: QuerySpec['preset'] =
    presetRaw === 'today' || presetRaw === 'tomorrow' || presetRaw === 'week' || presetRaw === 'date'
      ? presetRaw
      : 'today';
  const filterRaw = object.filter;
  const filter: QuerySpec['filter'] =
    filterRaw === 'event' || filterRaw === 'task' ? filterRaw : 'all';

  return { ok: true, spec: { preset, date: toText(object.date), filter } };
}

/* ────────────────────────── 摘要 ────────────────────────── */

/** 草稿的结构化摘要，用于发给模型（不含任何历史会话） */
export function draftSummary(draft: Draft): string {
  const parts: string[] = [
    `类型=${draft.kind === 'event' ? '日程' : '待办'}`,
    `标题=${draft.title || '（未填）'}`,
  ];
  if (draft.kind === 'event') {
    parts.push(`开始=${draft.startAt ?? '（未填）'}`);
    if (draft.endAt) parts.push(`结束=${draft.endAt}`);
  } else {
    parts.push(`截止日=${draft.dueDate ?? '（未填）'}`);
    parts.push(`截止时刻=${draft.dueTime ?? '（未填）'}`);
  }
  if (draft.location) parts.push(`地点=${draft.location}`);
  if (draft.reminderDeclined) parts.push('提醒=用户已关闭');
  else if (draft.reminderOffsets.length > 0) parts.push(`提醒=提前${draft.reminderOffsets.join('/')}分钟`);
  return parts.join('，');
}
