/**
 * 微信回复构造与长度控制（PRD 3.5、12.1 第 18 项）。
 *
 * 已确认参数（PRD 16.2）：
 *   - 单次回复最多 8 条事项；
 *   - 单条回复上限 600 **全角字符**；
 *   - 两项同时生效、先到者为准；
 *   - 截断时必须标注结果总数与已显示条数，**不得声称显示了 8 条**。
 *
 * 长度按"全角字符"计：CJK 与全角标点算 1，ASCII 算 0.5，这样 600 字的口径
 * 对中文列表是稳定的，也不会因为夹杂数字/英文而忽长忽短。
 */
import { config } from '../config';

export const QUERY_MAX_ITEMS = Number(process.env.WECHAT_QUERY_MAX_ITEMS ?? 8);
export const QUERY_MAX_CHARS = Number(process.env.WECHAT_QUERY_MAX_CHARS ?? 600);

/** 全角字符宽度：CJK、全角标点与 emoji 记 1，其余记 0.5 */
export function fullWidthLength(text: string): number {
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // 韩文字母
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首..注音
      (code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式
      (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff); // emoji
    total += wide ? 1 : 0.5;
  }
  return total;
}

/** 按全角宽度截断，尽量不切在多字节字符中间 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (fullWidthLength(text) <= maxWidth) return text;
  let acc = 0;
  let out = '';
  for (const ch of text) {
    const w = fullWidthLength(ch);
    if (acc + w > maxWidth) break;
    acc += w;
    out += ch;
  }
  return out;
}

export type QueryItem = {
  type: 'event' | 'task' | 'subscription';
  title: string;
  /** 展示用时间，例如 "10-14 15:00" 或 "10-14 全天" */
  when: string;
  detail?: string | null;
};

export type GroupedQueryItems = {
  /** 分组标题 → 该组条目 */
  groups: { label: string; items: QueryItem[] }[];
};

const TYPE_LABEL: Record<QueryItem['type'], string> = {
  event: '日程',
  task: '待办',
  subscription: '订阅',
};

function itemLine(item: QueryItem): string {
  const parts = [`· ${item.when} ${item.title}`, `[${TYPE_LABEL[item.type]}]`];
  if (item.detail) parts.push(item.detail);
  return parts.join(' ');
}

export type FormatResult = {
  body: string;
  /** 实际显示的条目数 */
  shown: number;
  /** 命中的总条目数 */
  total: number;
  /** 是否因条数上限被裁 */
  cappedByCount: boolean;
  /** 是否因长度上限被截断 */
  truncatedByLength: boolean;
};

/**
 * 组装查询回复。
 *
 * 顺序很重要：**先按条数上限裁，再按长度上限截**。
 * 反过来先截长度会让"剩余条数"的标注失去意义。
 * 截断后仍要如实说明"共 X 条，已显示 Y 条"，而不是报告 8 条。
 */
export function formatQueryReply(input: {
  title: string;
  groups: GroupedQueryItems;
  /** 无结果时的替代文案 */
  emptyText: string;
  maxItems?: number;
  maxChars?: number;
}): FormatResult {
  const maxItems = input.maxItems ?? QUERY_MAX_ITEMS;
  const maxChars = input.maxChars ?? QUERY_MAX_CHARS;

  const flat: QueryItem[] = input.groups.groups.flatMap((g) => g.items);
  const total = flat.length;

  if (total === 0) {
    return {
      body: `${input.title}\n${input.emptyText}`,
      shown: 0,
      total: 0,
      cappedByCount: false,
      truncatedByLength: false,
    };
  }

  // 1) 条数上限
  let budget = maxItems;
  let cappedByCount = false;
  const limitedGroups: { label: string; items: QueryItem[] }[] = [];
  for (const group of input.groups.groups) {
    if (budget <= 0) break;
    const take = group.items.slice(0, budget);
    if (take.length < group.items.length) cappedByCount = true;
    budget -= take.length;
    if (take.length > 0) limitedGroups.push({ label: group.label, items: take });
  }
  if (flat.length > maxItems) cappedByCount = true;

  const shownAfterCount = limitedGroups.reduce((n, g) => n + g.items.length, 0);

  // 2) 组装并检查长度
  const lines: string[] = [input.title];
  for (const group of limitedGroups) {
    lines.push('', `【${group.label}】`);
    for (const item of group.items) lines.push(itemLine(item));
  }

  const withinLength = lines.join('\n');
  if (fullWidthLength(withinLength) <= maxChars) {
    const suffix = cappedByCount
      ? `\n\n另有 ${total - shownAfterCount} 条未显示，请到工作站查看完整列表`
      : '';
    return {
      body: withinLength + suffix,
      shown: shownAfterCount,
      total,
      cappedByCount,
      truncatedByLength: false,
    };
  }

  // 3) 长度超限：按行累加，保留能放下的部分，并如实标注
  const kept: string[] = [];
  let shown = 0;
  let currentGroup: string | null = null;
  // 预留标注文字的空间，避免"标注本身把内容顶掉"
  const noteReserve = 120;
  const limit = Math.max(50, maxChars - noteReserve);

  let acc = fullWidthLength(input.title);
  kept.push(input.title);

  outer: for (const group of limitedGroups) {
    for (const item of group.items) {
      const head = group.label !== currentGroup ? `\n\n【${group.label}】` : '';
      const line = `\n${itemLine(item)}`;
      const cost = fullWidthLength(head + line);
      if (acc + cost > limit) break outer;
      if (head) {
        kept.push(head.trimStart());
        currentGroup = group.label;
      }
      kept.push(line.trimStart());
      acc += cost;
      shown += 1;
    }
  }

  const remaining = total - shown;
  const note = `\n\n共 ${total} 条，已显示 ${shown} 条（内容过长已截断）${remaining > 0 ? `，另有 ${remaining} 条` : ''}，请到工作站查看完整列表`;
  const body = truncateToWidth(kept.join('\n') + note, maxChars + noteReserve);

  return {
    body,
    shown,
    total,
    cappedByCount,
    truncatedByLength: true,
  };
}

/** 草稿预览（PRD 3.2）：必须显示绝对日期、时区与实际可排的提醒 */
export type PreviewInput = {
  shortCode: string;
  draftKind: 'event' | 'task';
  title: string;
  /** 已格式化的本地时间，例如 "2026-10-14 15:00（北京时间）" */
  timeText: string | null;
  location: string | null;
  note: string | null;
  /** 已排定的提醒，含实际触发时刻；空数组表示本次不安排提醒 */
  reminderLines: string[];
  /** 不安排提醒的原因（缺日期/时刻、或时间已过） */
  reminderBlockedReason: string | null;
  /** 地点因类型转换被移除时的说明 */
  droppedFields?: string[];
};

export function formatPreview(input: PreviewInput): string {
  const lines: string[] = [];
  lines.push(`📝 Life OS · 待确认 ${input.shortCode}`);
  lines.push(`事项：${input.title || '（未命名）'}`);
  lines.push(`类型：${input.draftKind === 'event' ? '日程事件' : '待办'}`);
  lines.push(`时间：${input.timeText ?? '未设置'}`);
  if (input.draftKind === 'event') lines.push(`地点：${input.location ?? '未设置'}`);
  if (input.note) lines.push(`备注：${input.note}`);
  if (input.droppedFields?.length) {
    lines.push(`变更：${input.droppedFields.join('；')}`);
  }

  if (input.reminderLines.length > 0) {
    lines.push(`提醒：${input.reminderLines.join('、')}`);
  } else if (input.reminderBlockedReason) {
    // 必须写明原因，不允许显示"已安排提醒"却没有可执行任务（PRD 5）
    lines.push(`提醒：${input.reminderBlockedReason}`);
  } else {
    lines.push('提醒：未设置');
  }

  lines.push('状态：尚未保存');
  lines.push('');
  lines.push(`回复「确认 ${input.shortCode}」保存`);
  lines.push('直接发送修改内容，或回复「取消」放弃');
  lines.push('/pending 查看当前草稿');
  return lines.join('\n');
}

/** 统一的发送前收敛：任何回复都不得突破长度上限 */
export function clampReply(body: string, maxChars = QUERY_MAX_CHARS): string {
  if (fullWidthLength(body) <= maxChars) return body;
  return truncateToWidth(body, maxChars);
}

export { config };
