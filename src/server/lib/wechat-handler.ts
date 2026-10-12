/**
 * 微信消息业务路由（PRD 3、4.1、6、10）。
 *
 * 路由优先级严格按 PRD 4.1：
 *   1. 校验代际/发送人/消息类型（由接收侧完成）；
 *   2. 确定性规则：完整确认短码、精确取消、`/pending`、`/recent` → **不调用模型**；
 *   3. `/add`、`/today`、`/tomorrow`、`/list`、`/help`；
 *   4. 其余文本结合**当前草稿状态**判断 create / query / patch / 不支持 / 歧义；
 *   5. 仅在结构化解析需要时调用 DeepSeek。
 *
 * 本模块只决定"做什么"，把"怎么写库"交给 wechat-operations（原子提交）。
 * 这样路由可以完全离线单测，而写入路径由事务测试覆盖。
 */
import type { Draft } from './wechat-draft';
import {
  applyPatch,
  draftTimeText,
  emptyDraft,
  missingFields,
  reminderSummary,
  validateBeforeCommit,
  type DraftPatch,
} from './wechat-draft';
import { formatPreview, type FormatResult } from './wechat-reply';
import type { ParsedCommand } from './wechat-command';

/** 由上层注入的依赖：生产用真实模型，测试用桩，保证路由可离线验证 */
export type HandlerDeps = {
  classifyIntent: (
    text: string,
    context: { hasActiveDraft: boolean; draftSummary?: string | null; now: Date },
  ) => Promise<
    | { ok: true; intent: 'create' | 'query' | 'patch_draft' | 'unsupported_operation' | 'out_of_scope' | 'unclear'; confidence: number }
    | { ok: false; error: string; kind: string }
  >;
  extractNewDraft: (
    text: string,
    parseBasisAt: Date,
  ) => Promise<{ ok: true; draft: Draft; ambiguities: string[] } | { ok: false; error: string; kind: string }>;
  extractDraftPatch: (
    text: string,
    current: Draft,
    parseBasisAt: Date,
  ) => Promise<
    | { ok: true; patch: Record<string, unknown>; ambiguous: string | null }
    | { ok: false; error: string; kind: string }
  >;
  extractQuery: (
    text: string,
    parseBasisAt: Date,
  ) => Promise<{ ok: true; spec: QuerySpec } | { ok: false; error: string; kind: string }>;
};

export type QuerySpec = {
  preset: 'today' | 'tomorrow' | 'week' | 'date';
  date: string | null;
  filter: 'all' | 'event' | 'task';
};

/** 活动草稿的只读视图（由 operations 层提供） */
export type ActiveOperationView = {
  id: string;
  version: number;
  shortCode: string | null;
  draft: Draft;
  status: string;
  /** 预览发送是否处于"结果未知"：未知时不得把裸确认当同意（PRD 3.3） */
  previewUnknown?: boolean;
};

export type HandlerAction =
  /** 回复一段文本，按 replyType 分类 */
  | { kind: 'reply'; replyType: string; body: string }
  /** 建立新草稿 */
  | {
      kind: 'create_draft';
      draft: Draft;
      missing: string[];
      /** 缺字段时的追问文案 */
      question: string | null;
      preview: string | null;
    }
  /** 更新草稿（补丁/转换） */
  | {
      kind: 'update_draft';
      patch: DraftPatch;
      preview: string;
      question: null;
    }
  /** 提交草稿 */
  | { kind: 'commit'; operationId: string; expectedVersion: number }
  /** 取消草稿 */
  | { kind: 'cancel'; operationId: string }
  /** 查询，交给查询执行层组装 */
  | {
      kind: 'query';
      spec: QuerySpec;
      /** 查询后要附带的草稿提示 */
      draftNotice: string | null;
    };

export type HandlerInput = {
  command: ParsedCommand;
  /** 原始文本（命令解析前的） */
  rawText: string;
  /** 该条消息的解析基准（入站时冻结，重试不变） */
  parseBasisAt: Date;
  now: Date;
  active: ActiveOperationView | null;
  deps: HandlerDeps;
};

/** 短码生成：排除易混字符 0/O、1/I/L（PRD 3.3 的"不可混淆"要求） */
const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SHORT_CODE_LENGTH = 4;

export function newShortCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i += 1) {
    out += SHORT_CODE_ALPHABET[Math.floor(rand() * SHORT_CODE_ALPHABET.length)]!;
  }
  return out;
}

/** 预览所需的提醒与时间文案由 draft 层提供 */
export function buildPreview(
  draft: Draft,
  shortCode: string,
  now: Date,
  droppedFields: string[] = [],
): string {
  const { lines, blockedReason } = reminderSummary(draft, now);
  return formatPreview({
    shortCode,
    draftKind: draft.kind,
    title: draft.title,
    timeText: draftTimeText(draft),
    location: draft.location,
    note: draft.note,
    reminderLines: lines,
    reminderBlockedReason: blockedReason,
    droppedFields,
  });
}

const HELP_TEXT = [
  '【Life OS 用法】',
  '/add 内容 — 新建日程或待办',
  '/today、/tomorrow、/list — 查询今天、明天、未来七天',
  '/pending — 查看当前草稿',
  '/recent — 查看最近操作结果',
  '确认 短码 — 保存草稿（只认完整短码）',
  '取消 — 放弃当前草稿',
  '',
  '直接用一句话描述也可以，例如「明天下午三点科研楼开组会」。',
  '已保存事项的修改、删除、完成请到工作站操作。',
].join('\n');

const UNSUPPORTED_TEXT =
  '这个操作本版还不支持。已保存事项的修改、删除、完成或重开，请到工作站操作。\n当前没有待编辑的草稿。';

const OUT_OF_SCOPE_TEXT =
  '我只负责日程与待办：新建、查看、以及确认尚未保存的草稿。\n其他问题建议用别的工具。发送 /help 查看用法。';

/**
 * 主路由。
 *
 * 注意：**任何模型失败都不会产生写入动作**，只会得到追问或明确的错误回复。
 */
export async function routeMessage(input: HandlerInput): Promise<HandlerAction> {
  const { command, active, now } = input;

  switch (command.kind) {
    case 'help':
      return { kind: 'reply', replyType: 'help', body: HELP_TEXT };

    case 'refresh_context':
      // 通道维护命令由发送/接收侧处理，这里只确认，不作为业务
      return {
        kind: 'reply',
        replyType: 'notice',
        body: '已收到刷新请求。提醒窗口会在收到你的消息后恢复。',
      };

    case 'pending':
      if (!active) {
        return { kind: 'reply', replyType: 'pending', body: '当前没有未保存的草稿。' };
      }
      return {
        kind: 'reply',
        replyType: 'pending',
        body: buildPreview(active.draft, active.shortCode ?? '????', now),
      };

    case 'recent':
      return { kind: 'reply', replyType: 'recent', body: '' };

    case 'cancel':
      if (!active) {
        return { kind: 'reply', replyType: 'cancelled', body: '当前没有可取消的草稿。' };
      }
      return { kind: 'cancel', operationId: active.id };

    case 'confirm':
      if (!active) {
        return {
          kind: 'reply',
          replyType: 'error',
          body: '当前没有待确认的草稿。直接发送一句话来新建事项。',
        };
      }
      if (!active.shortCode || active.shortCode !== command.code) {
        return {
          kind: 'reply',
          replyType: 'error',
          body: `短码不正确或已失效。当前有效短码是 ${active.shortCode ?? '（无）'}，请回复「确认 ${active.shortCode ?? ''}」。`,
        };
      }
      // 预览结果未知时不能把确认当成"看到了最新预览"的同意（PRD 3.3）
      if (active.previewUnknown) {
        return {
          kind: 'reply',
          replyType: 'error',
          body: `预览可能未送达。请先发送 /pending 查看当前草稿，再回复「确认 ${active.shortCode}」。`,
        };
      }
      {
        const check = validateBeforeCommit(active.draft, now);
        if (!check.ok) {
          return {
            kind: 'reply',
            replyType: 'error',
            body: `${check.reason}。发送 /pending 查看当前草稿。`,
          };
        }
      }
      return { kind: 'commit', operationId: active.id, expectedVersion: active.version };

    case 'today':
      return { kind: 'query', spec: { preset: 'today', date: null, filter: 'all' }, draftNotice: draftNoticeFor(active) };
    case 'tomorrow':
      return { kind: 'query', spec: { preset: 'tomorrow', date: null, filter: 'all' }, draftNotice: draftNoticeFor(active) };
    case 'list':
      return { kind: 'query', spec: { preset: 'week', date: null, filter: 'all' }, draftNotice: draftNoticeFor(active) };

    case 'unsupported_command':
      return {
        kind: 'reply',
        replyType: 'error',
        body: `不支持的命令 ${command.command}。发送 /help 查看可用命令。`,
      };

    case 'add_without_content':
      return {
        kind: 'reply',
        replyType: 'error',
        body: '请在 /add 后面写上内容，例如「/add 明天下午三点开组会」。',
      };

    case 'add':
      return handleCreate(input, command.rest);

    case 'free_text':
      return handleFreeText(input, command.text);

    default:
      return { kind: 'reply', replyType: 'error', body: '无法识别的消息。发送 /help 查看用法。' };
  }
}

function draftNoticeFor(active: ActiveOperationView | null): string | null {
  if (!active) return null;
  // 查询不得破坏草稿，但必须提示草稿仍在（PRD 3.5）
  return `当前仍有「${active.draft.title || '未命名'}」草稿未保存，可继续修改、确认或取消。`;
}

/** `/add 内容` 跳过意图分类，直接进入创建流程（PRD 3.1） */
async function handleCreate(input: HandlerInput, text: string): Promise<HandlerAction> {
  const { active, deps, parseBasisAt, now } = input;

  if (active) {
    return {
      kind: 'reply',
      replyType: 'error',
      body: `当前有未保存的草稿「${active.draft.title || '未命名'}」，请先确认或取消（回复「确认 ${active.shortCode ?? ''}」或「取消」）。`,
    };
  }

  const extracted = await deps.extractNewDraft(text, parseBasisAt);
  if (!extracted.ok) {
    return {
      kind: 'reply',
      replyType: 'error',
      body: `没能理解这条内容（${extracted.kind}）。请换个说法，或用 /add 明确表示新建。`,
    };
  }

  const { draft, ambiguities } = extracted;
  const missing = missingFields(draft);

  if (missing.length > 0) {
    // 缺字段：保存草稿并追问，而不是丢弃用户输入（PRD 3.1）
    return {
      kind: 'create_draft',
      draft,
      missing,
      question: buildQuestion(draft, missing, ambiguities),
      preview: null,
    };
  }

  const shortCode = newShortCode();
  return {
    kind: 'create_draft',
    draft,
    missing: [],
    question: null,
    preview: buildPreview(draft, shortCode, now),
  };
}

/** 自然语言：先看意图，再决定建草稿 / 查询 / 补丁 */
async function handleFreeText(input: HandlerInput, text: string): Promise<HandlerAction> {
  const { active, deps, parseBasisAt, now } = input;

  const classified = await deps.classifyIntent(text, {
    hasActiveDraft: Boolean(active),
    draftSummary: active ? draftTimeText(active.draft) : null,
    now,
  });

  if (!classified.ok) {
    return {
      kind: 'reply',
      replyType: 'error',
      body: `暂时无法判断这条消息（${classified.kind}）。请用 /add、/today、/help 等命令，或稍后重试。`,
    };
  }

  switch (classified.intent) {
    case 'unsupported_operation':
      return { kind: 'reply', replyType: 'error', body: UNSUPPORTED_TEXT };

    case 'out_of_scope':
      return { kind: 'reply', replyType: 'error', body: OUT_OF_SCOPE_TEXT };

    case 'query': {
      const spec = await deps.extractQuery(text, parseBasisAt);
      if (!spec.ok) {
        return {
          kind: 'reply',
          replyType: 'error',
          body: '没能理解要查询的范围。可以试试 /today、/tomorrow、/list。',
        };
      }
      return { kind: 'query', spec: spec.spec, draftNotice: draftNoticeFor(active) };
    }

    case 'patch_draft': {
      if (!active) {
        // 没有草稿却说要补充：按新建处理，避免用户白说一句
        return handleCreate(input, text);
      }
      const patched = await deps.extractDraftPatch(text, active.draft, parseBasisAt);
      if (!patched.ok) {
        return {
          kind: 'reply',
          replyType: 'error',
          body: `没能理解要改什么（${patched.kind}）。发送 /pending 查看当前草稿。`,
        };
      }
      if (patched.ambiguous) {
        return {
          kind: 'reply',
          replyType: 'error',
          body: `${patched.ambiguous}\n发送 /pending 查看当前草稿。`,
        };
      }
      return applyPatchAction(input, active, toDraftPatch(patched.patch));
    }

    case 'create': {
      if (active) {
        return {
          kind: 'reply',
          replyType: 'error',
          body: `当前有未保存的草稿「${active.draft.title || '未命名'}」。请先确认或取消（回复「确认 ${active.shortCode ?? ''}」或「取消」），再创建下一项。`,
        };
      }
      return handleCreate(input, text);
    }

    case 'unclear':
    default:
      return {
        kind: 'reply',
        replyType: 'error',
        body: '这条消息我不太确定意思。可以更具体一些，例如「明天下午三点开会」，或发送 /help 查看用法。',
      };
  }
}

function buildQuestion(draft: Draft, missing: string[], ambiguities: string[]): string {
  const lines: string[] = ['已记下这条内容，还需要补充信息才能保存：'];
  lines.push(`事项：${draft.title || '（未命名）'}`);
  lines.push(`类型：${draft.kind === 'event' ? '日程事件' : '待办'}`);
  for (const field of missing) {
    if (field === 'title') lines.push('· 请补充事项名称');
    if (field === 'start_at') lines.push('· 请补充开始时间（日期 + 时刻）');
  }
  for (const note of ambiguities.slice(0, 3)) lines.push(`· ${note}`);
  lines.push('');
  lines.push('直接回复补充内容即可，已确定的信息会保留。');
  return lines.join('\n');
}

/** 把模型返回的补丁对象收窄为内部补丁（禁止透传未知字段） */
export function toDraftPatch(raw: Record<string, unknown>): DraftPatch {
  const patch: DraftPatch = {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  if ('title' in raw) {
    const value = str(raw.title);
    if (value) patch.title = value;
  }
  if ('start_at' in raw) {
    const value = str(raw.start_at);
    if (value) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) patch.startAt = parsed.toISOString();
    }
  }
  if ('end_at' in raw) {
    const value = str(raw.end_at);
    if (value) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) patch.endAt = parsed.toISOString();
    }
  }
  if ('due_date' in raw) {
    const value = str(raw.due_date);
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) patch.dueDate = value;
  }
  if ('due_time' in raw) {
    const value = str(raw.due_time);
    if (value && /^\d{2}:\d{2}/.test(value)) patch.dueTime = value.slice(0, 5);
  }
  if ('location' in raw) {
    const value = str(raw.location);
    if (value) patch.location = value;
  }
  if ('note' in raw) {
    const value = str(raw.note);
    if (value) patch.note = value;
  }
  if (raw.reminder_declined === true) patch.reminderDeclined = true;
  if (typeof raw.reminder_enabled === 'boolean') patch.reminderEnabled = raw.reminder_enabled;
  if (Array.isArray(raw.reminder_offsets)) {
    const offsets = raw.reminder_offsets.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (offsets.length > 0) patch.reminderOffsets = offsets;
  }
  if (raw.convert_to === 'event' || raw.convert_to === 'task') {
    patch.convertTo = raw.convert_to;
  }
  return patch;
}

/** 应用补丁并生成新预览（版本与短码由上层递增） */
function applyPatchAction(
  input: HandlerInput,
  active: ActiveOperationView,
  patch: DraftPatch,
): HandlerAction {
  const { draft, dropped } = applyPatch(active.draft, patch, input.now);
  const shortCode = newShortCode();
  return {
    kind: 'update_draft',
    patch,
    preview: buildPreview(draft, shortCode, input.now, dropped),
    question: null,
  };
}

export { emptyDraft };
export type { FormatResult };
