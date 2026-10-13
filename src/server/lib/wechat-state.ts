/**
 * 微信绑定状态：**每个账号一份**（多用户改造的核心变化之一）。
 *
 * 改造前这里是一行全局 `settings` 记录，绑定、接收游标、上下文与 8/10 发送窗口
 * 全系统共用一份。多用户下那会造成两类严重问题：
 *   1. 把 A 的提醒发到 B 的微信上（跨账号泄露）；
 *   2. B 的发送窗口用尽连带停掉 A 的提醒（互相干扰）。
 * 因此状态改为按 `user_id` 存表（见 `db/schema.ts` 的 `wechat_accounts`）。
 *
 * 保留的外在约定：
 * - 函数名与改造前一致，只是第一个参数变成 `userId`——调用点加一个参数即可，
 *   漏改的地方 `tsc` 会全部指出来，不会静默失效。
 * - 发送前的"预约"与发送后的"回填"仍靠 `revision` 校验：预约与结果必须在同一修订号上，
 *   否则说明期间发生了刷新/换绑，旧结果不得覆盖新状态。
 * - 凭据仍是 AES-256-GCM 加密存储；AAD 沿用全局字符串（残留风险见 schema.ts 注释）。
 */
import crypto from 'node:crypto';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { wechatAccounts } from '../db/schema';

/** 仅用于：业务导出排除历史设置行，以及迁移脚本识别旧记录 */
export const WECHAT_STATE_KEY = 'wechat.private-channel';
export const WARN_AT = 8;
export const PAUSE_AT = 10;

export type WechatCredentials = { token: string; userId: string; botId: string; baseUrl: string };

export type WechatAccount = {
  userId: number;
  generation: string;
  revision: string;
  /** 加密后的凭据；null 表示该账号尚未绑定 */
  account: string | null;
  /** 加密后的上下文 token */
  context: string | null;
  cursor: string;
  boundAt: number | null;
  refreshedAt: number | null;
  used: number;
  accepted: number;
  failed: number;
  unknown: number;
  warned: boolean;
  warningResult: string | null;
  pausedReason: string | null;
  seen: string[];
  lastInboundTime: number;
  listenerAt: number | null;
  listenerError: string | null;
};

/** 保留旧名，避免调用方大范围改名 */
export type WechatState = WechatAccount;

/**
 * 尚未绑定的账号状态。
 *
 * 注意 `generation` 每次调用都是新的：它只在"没有绑定"时出现，而那时所有
 * 依赖代际的逻辑都会先因 `account === null` 提前返回，因此不存在"两次读到的
 * 空代际不一致"的实际后果。
 */
export function emptyWechatState(userId: number): WechatAccount {
  return {
    userId,
    generation: crypto.randomUUID(),
    revision: crypto.randomUUID(),
    account: null,
    context: null,
    cursor: '',
    boundAt: null,
    refreshedAt: null,
    used: 0,
    accepted: 0,
    failed: 0,
    unknown: 0,
    warned: false,
    warningResult: null,
    pausedReason: null,
    seen: [],
    lastInboundTime: 0,
    listenerAt: null,
    listenerError: null,
  };
}

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET ?? '';
  if (secret.length < 32) throw new Error('微信凭据加密需要至少 32 位 SESSION_SECRET');
  return crypto.createHash('sha256').update('lifeos:wechat:v1\0').update(secret).digest();
}

export function seal(value: unknown): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(WECHAT_STATE_KEY));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function unseal<T>(value: string): T {
  const [nonce, tag, data] = value.split('.').map((v) => Buffer.from(v, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), nonce!);
  decipher.setAAD(Buffer.from(WECHAT_STATE_KEY));
  decipher.setAuthTag(tag!);
  return JSON.parse(Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8')) as T;
}

type AccountRow = typeof wechatAccounts.$inferSelect;

function toMs(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

function fromMs(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}

function rowToAccount(row: AccountRow): WechatAccount {
  return {
    userId: row.userId,
    generation: row.generation,
    revision: row.revision,
    account: row.accountEnc,
    context: row.contextEnc,
    cursor: row.cursor,
    boundAt: toMs(row.boundAt),
    refreshedAt: toMs(row.refreshedAt),
    used: row.used,
    accepted: row.accepted,
    failed: row.failed,
    unknown: row.unknown,
    warned: row.warned,
    warningResult: row.warningResult,
    pausedReason: row.pausedReason,
    seen: Array.isArray(row.seen) ? (row.seen as string[]) : [],
    lastInboundTime: toMs(row.lastInboundAt) ?? 0,
    listenerAt: toMs(row.listenerAt),
    listenerError: row.listenerError,
  };
}

function accountToRow(account: WechatAccount): Partial<AccountRow> {
  return {
    generation: account.generation,
    revision: account.revision,
    accountEnc: account.account,
    contextEnc: account.context,
    cursor: account.cursor,
    boundAt: fromMs(account.boundAt),
    refreshedAt: fromMs(account.refreshedAt),
    used: account.used,
    accepted: account.accepted,
    failed: account.failed,
    unknown: account.unknown,
    warned: account.warned,
    warningResult: account.warningResult,
    pausedReason: account.pausedReason,
    seen: account.seen,
    lastInboundAt: fromMs(account.lastInboundTime || null),
    listenerAt: fromMs(account.listenerAt),
    listenerError: account.listenerError,
    updatedAt: new Date(),
  };
}

/** 读某账号的绑定状态；未绑定（或从未写过）时返回空状态，不产生写入 */
export async function readWechatState(userId: number): Promise<WechatAccount> {
  const [row] = await db.select().from(wechatAccounts).where(eq(wechatAccounts.userId, userId)).limit(1);
  return row ? rowToAccount(row) : emptyWechatState(userId);
}

/** 事务客户端（只声明本模块需要的方法），供回调在同一事务里做额外读写 */
export type WechatStateTx = {
  select: typeof db.select;
  insert: typeof db.insert;
  update: typeof db.update;
  delete: typeof db.delete;
  execute: typeof db.execute;
};

/**
 * 在**同一事务**内读-改-写某账号的状态，用 `SELECT ... FOR UPDATE` 串行化。
 *
 * 回调会拿到事务句柄 `tx`：像"插入入站消息 + 推进游标 + 刷新上下文"这类必须与原状态
 * 原子完成的操作，要在这个回调里用 `tx` 做，**不要另开连接**——否则会出现
 * "游标已推进但消息丢失"或"消息重复但游标未动"。
 *
 * 关键约束：绝不能在持有该事务时等待 iLink 的网络响应（那会把行锁与连接一起占住）。
 * 因此发送流程是"先预约（+未知计数）→ 提交事务 → 发网络请求 → 新事务回填结果"。
 */
export async function updateWechatState<T>(
  userId: number,
  fn: (state: WechatAccount, tx: WechatStateTx) => T | Promise<T>,
): Promise<T> {
  /**
   * 显式校验账号 id。
   *
   * 不做这层校验的话，`userId` 为 undefined 时它会被渲染成空值，最终报出
   * `syntax error at or near ","` 这种与真实原因毫无关系的 SQL 错误——
   * 排查成本极高。这里直接说清是"少了账号 id"。
   */
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`微信状态操作缺少有效的账号 id（收到：${String(userId)}）`);
  }

  return db.transaction(async (tx) => {
    // 先确保行存在（没有则建），再锁住它；ON CONFLICT 使并发调用不会互相报错
    await tx.execute(sql`
      INSERT INTO wechat_accounts (user_id, generation, revision)
      VALUES (${userId}, ${crypto.randomUUID()}, ${crypto.randomUUID()})
      ON CONFLICT (user_id) DO NOTHING
    `);

    const [row] = await tx
      .select()
      .from(wechatAccounts)
      .where(eq(wechatAccounts.userId, userId))
      .for('update')
      .limit(1);

    const state = rowToAccount(row!);
    const result = await fn(state, tx as WechatStateTx);

    await tx.update(wechatAccounts).set(accountToRow(state)).where(eq(wechatAccounts.userId, userId));
    return result;
  });
}

/**
 * 已绑定的全部账号（Worker 轮询入口）。
 *
 * 只返回真正有凭据的行：未绑定的账号既不需要轮询，也不该被算进"渠道已配置"。
 */
export async function listBoundWechatAccounts(): Promise<WechatAccount[]> {
  const rows = await db
    .select()
    .from(wechatAccounts)
    .where(isNotNull(wechatAccounts.accountEnc));
  return rows.map(rowToAccount);
}

/** 绑定：只有当前代际与预期一致才生效，避免并发扫码互相覆盖 */
export async function bindWechat(
  userId: number,
  credentials: WechatCredentials,
  expectedGeneration: string,
): Promise<boolean> {
  const encrypted = seal(credentials);
  return updateWechatState(userId, (s) => {
    if (s.generation !== expectedGeneration) return false;
    Object.assign(s, emptyWechatState(userId), { account: encrypted, boundAt: Date.now() });
    return true;
  });
}

/** 解绑/重置：清空凭据与窗口，并换代际使旧草稿与旧回复失效 */
export async function resetWechatAccount(userId: number): Promise<void> {
  await updateWechatState(userId, (s) => {
    Object.assign(s, emptyWechatState(userId));
  });
}

export function canSendWechat(s: WechatAccount): boolean {
  return Boolean(s.account && s.context && !s.pausedReason && s.used < PAUSE_AT);
}

export function publicWechatState(s: WechatAccount) {
  let account: WechatCredentials | null = null;
  let unreadable = false;
  try {
    account = s.account ? unseal<WechatCredentials>(s.account) : null;
  } catch {
    unreadable = true;
  }
  return {
    bound: Boolean(account),
    botId: account?.botId ?? null,
    ready: !unreadable && canSendWechat(s),
    state: unreadable
      ? 'credential_error'
      : !s.account
        ? 'unbound'
        : !s.context
          ? 'awaiting_message'
          : s.pausedReason || s.used >= PAUSE_AT
            ? 'paused'
            : 'ready',
    used: s.used,
    accepted: s.accepted,
    failed: s.failed,
    unknown: s.unknown,
    warnAt: WARN_AT,
    pauseAt: PAUSE_AT,
    estimatedRemaining: Math.max(0, PAUSE_AT - s.used),
    refreshedAt: s.refreshedAt ? new Date(s.refreshedAt).toISOString() : null,
    warned: s.warned,
    warningResult: s.warningResult,
    pausedReason: s.pausedReason,
    listenerAt: s.listenerAt ? new Date(s.listenerAt).toISOString() : null,
    listenerError: s.listenerError,
  };
}
