/**
 * 入站消息处理器（PRD 6、7.2）。
 *
 * 这是把"接收"与"业务"接起来的唯一位置：
 *   claimInboxBatch → routeMessage → （建/改/提交/取消草稿 | 查询 | 回复） → 入 outbox → 标记 done
 *
 * 三条纪律：
 *   1. **模型调用永远不在事务内**（路由与抽取都在事务之外完成）；
 *   2. 提交只走 `commitOperation` 的原子事务，本模块不自己写业务表；
 *   3. 任何失败都要如实落到 inbox 终态或退避，不假装成功。
 */
import crypto from 'node:crypto';
import {
  claimInboxBatch,
  markInboxDone,
  markInboxFailed,
  type ClaimedMessage,
} from './wechat-inbox';
import {
  commitOperation,
  createOperation,
  cancelOperation,
  expireStaleOperations,
  loadActiveOperation,
  updateOperation,
  type OperationRow,
} from './wechat-operations';
import { enqueueReply, type ReplyType } from './wechat-outbox';
import { db } from '../db/client';
import { parseCommand } from './wechat-command';
import {
  buildPreview,
  newShortCode,
  routeMessage,
  type HandlerAction,
  type HandlerDeps,
} from './wechat-handler';
import { applyPatch, missingFields, type Draft } from './wechat-draft';
import { runQuery } from './wechat-query';
import { readWechatState } from './wechat-state';
import { classifyIntent, extractDraftPatch, extractNewDraft, extractQuery } from './wechat-model';

/** 生产依赖：真实模型 */
export const productionDeps: HandlerDeps = {
  classifyIntent: (text, context) => classifyIntent(text, context),
  extractNewDraft: (text, parseBasisAt) => extractNewDraft(text, parseBasisAt),
  extractDraftPatch: (text, current, parseBasisAt) => extractDraftPatch(text, current, parseBasisAt),
  extractQuery: (text, parseBasisAt) => extractQuery(text, parseBasisAt),
};

export type ProcessOutcome = {
  inboxId: string;
  /** 处理结果：done 表示已处理并落终态；retry/dead 表示失败 */
  result: 'done' | 'retry' | 'dead' | 'skipped';
  error?: string;
};

function toActiveView(row: OperationRow) {
  return {
    id: row.id,
    version: row.version,
    shortCode: row.shortCode,
    draft: row.draft as Draft,
    status: row.status,
    // 预览投递结果未知时不得把确认当作同意（PRD 3.3）
    previewUnknown: false,
  };
}

/**
 * 处理一条已领取的入站消息。
 *
 * `message.userId` 是这条消息的**归属来源**（来自 wechat_inbox 那一行的 user_id），
 * 本函数把它当成唯一权威：路由、草稿、查询、提交全部按它进行，
 * **不再去查 generation 对应的账号**——多一道反查就多一次漏掉或查错的机会。
 *
 * `inboundEnabled` 为 false 时（输入开关关闭）只推进终态，不做业务，
 * 但**主动提醒不受影响**——提醒由 notification_jobs 独立调度。
 */
export async function processInboxMessage(
  message: ClaimedMessage,
  options: { deps?: HandlerDeps; inboundEnabled?: boolean; now?: Date } = {},
): Promise<ProcessOutcome> {
  const deps = options.deps ?? productionDeps;
  const inboundEnabled = options.inboundEnabled ?? (process.env.WECHAT_INBOUND_ENABLED ?? '1') !== '0';
  const now = options.now ?? new Date();
  const userId = message.userId;

  if (!inboundEnabled) {
    await markInboxDone(userId, message.id, null);
    return { inboxId: message.id, result: 'skipped' };
  }

  try {
    // 先让过期的草稿失效，避免把新消息补到一个早已过期的草稿上。
    // 过期的必须**告知用户**（PRD 3.4）：只改状态的话，用户下次回复确认短码
    // 只会得到"短码不正确"，既不知道草稿已过期、也不知道它去了哪里。
    // 只扫**这条消息所属账号**的草稿（见 expireStaleOperations 注释）。
    const expired = await expireStaleOperations(userId, now);
    for (const item of expired) {
      await enqueueReply(db, {
        userId: item.userId,
        bindingGeneration: item.bindingGeneration,
        operationId: item.id,
        replyType: 'expired',
        body:
          `上一草稿${item.title ? `「${item.title}」` : ''}已过期（超过 30 分钟未确认），**未保存**。\n` +
          (item.shortCode ? `旧短码 ${item.shortCode} 已失效。\n` : '') +
          '直接重新发送一次内容即可再建草稿。',
        dedupeKey: `expired:${item.id}`,
        now,
      });
    }

    const operation = await loadActiveOperation(userId, message.bindingGeneration);
    const active = operation ? toActiveView(operation) : null;

    const command = parseCommand(message.text);
    const action = await routeMessage({
      command,
      rawText: message.text,
      parseBasisAt: message.parseBasisAt,
      now,
      active,
      deps,
    });

    await applyAction({
      action,
      userId,
      generation: message.bindingGeneration,
      inboxId: message.id,
      active: operation,
      now,
      deps,
      parseBasisAt: message.parseBasisAt,
    });

    await markInboxDone(userId, message.id, operation?.id ?? null);
    return { inboxId: message.id, result: 'done' };
  } catch (err) {
    const detail = (err as Error).message ?? String(err);
    const outcome = await markInboxFailed(userId, message.id, detail, now);
    return { inboxId: message.id, result: outcome === 'dead' ? 'dead' : 'retry', error: detail };
  }
}

/** 把路由结果落成实际操作；这是唯一写库的地方 */
async function applyAction(input: {
  action: HandlerAction;
  /** 归属账号：来自 inbox 行，`userId` 在入参里显式传递，不从别处推导 */
  userId: number;
  generation: string;
  inboxId: string;
  active: OperationRow | null;
  now: Date;
  deps: HandlerDeps;
  parseBasisAt: Date;
}): Promise<void> {
  const { action, generation, inboxId, active, userId, now } = input;

  const reply = async (replyType: string, body: string): Promise<void> => {
    await enqueueReply(db, {
      userId,
      bindingGeneration: generation,
      sourceInboxId: inboxId,
      operationId: active?.id ?? null,
      operationVersion: active?.version ?? null,
      replyType: replyType as ReplyType,
      body,
      dedupeKey: `reply:${inboxId}:${replyType}`,
      now,
    });
  };

  switch (action.kind) {
    case 'reply': {
      if (action.replyType === 'recent') {
        await reply('recent', await buildRecentText(userId, generation));
        return;
      }
      await reply(action.replyType, action.body);
      return;
    }

    case 'query': {
      const result = await runQuery(userId, action.spec, now, action.draftNotice);
      await reply('query', result.body);
      return;
    }

    case 'create_draft': {
      const shortCode = newShortCode();
      const created = await createOperation({
        userId,
        bindingGeneration: generation,
        draftKind: action.draft.kind,
        draft: action.draft,
        missingFields: action.missing,
        shortCode,
        sourceInboxId: inboxId,
        now,
      });

      if (!created) {
        // 偏唯一索引拒绝：说明已有活动草稿（并发或竞态），如实告知而不是静默失败
        await reply(
          'error',
          '当前已有一条未保存的草稿，请先确认或取消后再创建下一项。发送 /pending 查看。',
        );
        return;
      }

      const body =
        action.question ??
        buildPreview(action.draft, created.shortCode ?? shortCode, now);
      await enqueueReply(db, {
        userId,
        bindingGeneration: generation,
        sourceInboxId: inboxId,
        operationId: created.id,
        operationVersion: created.version,
        replyType: 'preview',
        body,
        dedupeKey: `preview:${created.id}:1`,
        now,
      });
      return;
    }

    case 'update_draft': {
      if (!active) {
        await reply('error', '当前没有可更新的草稿。直接发送一句话来新建事项。');
        return;
      }
      const { draft, dropped } = applyPatchFor(active.draft as Draft, action, input);
      const shortCode = newShortCode();
      const updated = await updateOperation({
        userId,
        operationId: active.id,
        draft,
        missingFields: missingFields(draft),
        shortCode,
        bumpVersion: true,
        now,
      });
      if (!updated) {
        await reply('error', '草稿已变更，请发送 /pending 查看当前状态。');
        return;
      }
      // 预览随版本变化 → 去重键带上版本，旧预览不会被这次覆盖（作废由发送前校验完成）
      await enqueueReply(db, {
        userId,
        bindingGeneration: generation,
        sourceInboxId: inboxId,
        operationId: updated.id,
        operationVersion: updated.version,
        replyType: 'preview',
        body: buildPreview(updated.draft as Draft, updated.shortCode ?? shortCode, now, dropped),
        dedupeKey: `preview:${updated.id}:${updated.version}`,
        now,
      });
      return;
    }

    case 'commit': {
      const result = await commitOperation(userId, action.operationId, action.expectedVersion, now);
      if (!result.ok) {
        await reply('error', `${result.reason}。发送 /pending 查看当前草稿。`);
        return;
      }
      // 已创建回复由 commitOperation 在同一事务内入队，这里不再重复入队
      return;
    }

    case 'cancel': {
      const cancelled = await cancelOperation(userId, action.operationId, now);
      await reply(
        'cancelled',
        cancelled ? '已取消，本次未保存。' : '这个草稿已经结束，无需再取消。',
      );
      return;
    }

    default:
      await reply('error', '暂时无法处理这条消息。发送 /help 查看用法。');
  }
}

/** 应用补丁（复用 draft 层的 applyPatch，保证与单测覆盖的是同一实现） */
function applyPatchFor(
  current: Draft,
  action: Extract<HandlerAction, { kind: 'update_draft' }>,
  input: { now: Date },
): { draft: Draft; dropped: string[] } {
  return applyPatch(current, action.patch, input.now);
}

/** `/recent` 的正文：读取真实操作记录，区分已提交/已取消/已过期（PRD 3.6） */
export async function buildRecentText(userId: number, generation: string): Promise<string> {
  const { listRecentOperations } = await import('./wechat-operations');
  const rows = await listRecentOperations(userId, generation, 5);
  if (rows.length === 0) return '还没有任何操作记录。';

  const lines: string[] = ['【最近操作】'];
  for (const row of rows) {
    const draft = (row.draft as Draft | null) ?? null;
    const title = draft?.title || '（未命名）';
    const label =
      row.status === 'committed'
        ? '已保存'
        : row.status === 'cancelled'
          ? '已取消'
          : row.status === 'expired'
            ? '已过期（未保存）'
            : row.status === 'invalidated'
              ? '已因换绑失效'
              : '未保存';
    const at = `${row.updatedAt.toISOString().slice(5, 10)} ${row.updatedAt.toISOString().slice(11, 16)}`;
    lines.push(`· ${at} UTC ${title} — ${label}`);
  }
  lines.push('');
  lines.push('以上为真实持久化状态，未重做任何业务。');
  return lines.join('\n');
}

/** 批量处理一轮：返回每条的结果，供日志与测试断言 */
export async function processInboxBatch(
  limit = 5,
  options: { deps?: HandlerDeps; inboundEnabled?: boolean; now?: Date } = {},
): Promise<ProcessOutcome[]> {
  const messages = await claimInboxBatch(limit, options.now ?? new Date());
  const outcomes: ProcessOutcome[] = [];
  for (const message of messages) {
    outcomes.push(await processInboxMessage(message, options));
  }
  return outcomes;
}

export { readWechatState, crypto };
