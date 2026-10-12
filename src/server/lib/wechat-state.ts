import crypto from 'node:crypto';
import { pool } from '../db/client';

export const WECHAT_STATE_KEY = 'wechat.private-channel';
export const WARN_AT = 8;
export const PAUSE_AT = 10;
export type WechatCredentials = { token: string; userId: string; botId: string; baseUrl: string };
export type WechatState = {
  account: string | null; context: string | null; cursor: string;
  generation: string; revision: string; boundAt: number; refreshedAt: number | null;
  used: number; accepted: number; failed: number; unknown: number;
  warned: boolean; warningResult: string | null; pausedReason: string | null;
  seen: string[]; lastInboundTime: number; listenerAt: number | null; listenerError: string | null;
};
export function emptyWechatState(): WechatState {
  return { account: null, context: null, cursor: '', generation: crypto.randomUUID(), revision: crypto.randomUUID(),
    boundAt: 0, refreshedAt: null, used: 0, accepted: 0, failed: 0, unknown: 0, warned: false,
    warningResult: null, pausedReason: null, seen: [], lastInboundTime: 0, listenerAt: null, listenerError: null };
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
  return [nonce, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
}
export function unseal<T>(value: string): T {
  const [nonce, tag, data] = value.split('.').map(v => Buffer.from(v, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), nonce!);
  decipher.setAAD(Buffer.from(WECHAT_STATE_KEY));
  decipher.setAuthTag(tag!);
  return JSON.parse(Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8')) as T;
}
export async function readWechatState(): Promise<WechatState> {
  const row = await pool.query<{ value: WechatState }>('SELECT value FROM settings WHERE key=$1', [WECHAT_STATE_KEY]);
  return row.rows[0]?.value ?? emptyWechatState();
}
/** Never hold a DB transaction while waiting for iLink. Serialize reservations and refreshes. */
export async function updateWechatState<T>(fn: (s: WechatState) => T): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING', [WECHAT_STATE_KEY, JSON.stringify(emptyWechatState())]);
    const row = await client.query<{ value: WechatState }>('SELECT value FROM settings WHERE key=$1 FOR UPDATE', [WECHAT_STATE_KEY]);
    const s = row.rows[0]!.value;
    const result = fn(s);
    await client.query('UPDATE settings SET value=$2,updated_at=now() WHERE key=$1', [WECHAT_STATE_KEY, JSON.stringify(s)]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK'); throw err;
  } finally { client.release(); }
}
export async function bindWechat(credentials: WechatCredentials, expectedGeneration: string): Promise<boolean> {
  const encrypted = seal(credentials);
  return updateWechatState(s => {
    if (s.generation !== expectedGeneration) return false;
    Object.assign(s, emptyWechatState(), { account: encrypted, boundAt: Date.now() });
    return true;
  });
}
export function canSendWechat(s: WechatState): boolean {
  return Boolean(s.account && s.context && !s.pausedReason && s.used < PAUSE_AT);
}
export function publicWechatState(s: WechatState) {
  let account: WechatCredentials | null = null;
  let unreadable = false;
  try { account = s.account ? unseal<WechatCredentials>(s.account) : null; }
  catch { unreadable = true; }
  return { bound: Boolean(account), botId: account?.botId ?? null, ready: !unreadable && canSendWechat(s),
    state: unreadable ? 'credential_error' : !s.account ? 'unbound' : !s.context ? 'awaiting_message' :
      s.pausedReason || s.used >= PAUSE_AT ? 'paused' : 'ready',
    used: s.used, accepted: s.accepted, failed: s.failed, unknown: s.unknown,
    warnAt: WARN_AT, pauseAt: PAUSE_AT, estimatedRemaining: Math.max(0, PAUSE_AT - s.used),
    refreshedAt: s.refreshedAt ? new Date(s.refreshedAt).toISOString() : null,
    warned: s.warned, warningResult: s.warningResult, pausedReason: s.pausedReason,
    listenerAt: s.listenerAt ? new Date(s.listenerAt).toISOString() : null, listenerError: s.listenerError };
}
