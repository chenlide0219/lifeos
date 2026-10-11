/**
 * 微信 iLink 发送适配器（PRD FR-07）。
 *
 * 协议来源：只读复用既有实现，未改动也未重启原项目
 *   - E:\0Y\项目\MultiHarnessWechatNotifier\src\multiharness_notify\channels\wechat_bridge.py
 *     （v0.1.0，Proprietary，提交 ef53993）——封装层与结果映射语义
 *   - E:\0Y\codex-wechat-handoff\codex-wechat-ilink.ts
 *     （MIT，提交 8fd2a0a，5945 行）——classifySendBusiness / sendTextMessage 实际协议
 *
 * 为什么在 LifeOS 内重新实现而不是调用原 CLI：
 *   原 CLI 深度绑定 bun（`#!/usr/bin/env bun`、`Bun.spawn`、`Bun.argv`）且状态目录在 Windows，
 *   直接调用会要求"Windows 常开"或整体迁移 Harness，均被明确禁止。
 *   发送本体只是一次 HTTPS POST，因此按同一协议在 Linux 上原生实现。
 *
 * 凭据边界：使用 LifeOS **自己的** ILINK_* 配置；不读取、不复制原项目的
 * account.json / context_tokens.json，不触碰其队列，不重发历史 UNKNOWN。
 *
 * 判定原则：HTTP 200 不是成功凭据。必须由业务回执 ret / errcode / message_id 判定，
 * 无法确认时必须归入 unknown 且不得自动重试。
 */
import crypto from 'node:crypto';
import type {
  NotificationJobPayload,
  NotificationProvider,
  ProviderStatus,
  SendFailureKind,
  SendResult,
} from '../provider';

/** 微信单条文本上限（与既有实现一致） */
const MAX_TEXT_CHARS = 3500;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const MSG_ITEM_TEXT = 1;
const CHANNEL_VERSION = '0.1.0';
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

type IlinkBody = {
  ret?: number | null;
  errcode?: number | null;
  errmsg?: string | null;
  message_id?: unknown;
};

type ChunkOutcome =
  | { kind: 'accepted'; detail: string }
  | { kind: 'auth_or_context'; detail: string }
  | { kind: 'business_error'; detail: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'http_error'; detail: string }
  | { kind: 'unknown'; detail: string };

export class IlinkWechatProvider implements NotificationProvider {
  readonly channel = 'wechat';
  readonly name = '微信（iLink 发送通道）';

  // 配置动态读取而非构造时快照：
  // 运维在 .env 补上凭据后，Worker 下一轮即可使用，无需重启；
  // 也让"渠道未配置 → 恢复"这一场景可被真实测试覆盖。
  private get baseUrl(): string {
    return (process.env.ILINK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private get token(): string {
    return (process.env.ILINK_TOKEN ?? '').trim();
  }

  private get toUserId(): string {
    return (process.env.ILINK_TO_USER_ID ?? '').trim();
  }

  private get contextToken(): string {
    return (process.env.ILINK_CONTEXT_TOKEN ?? '').trim();
  }

  private get timeoutMs(): number {
    return Number(process.env.ILINK_TIMEOUT_MS ?? 15_000);
  }

  private lastReachable: boolean | null = null;
  private lastProbedAt: string | null = null;

  isConfigured(): boolean {
    return Boolean(this.token && this.toUserId);
  }

  describe(): ProviderStatus {
    if (!this.token) {
      return this.status(false, '未配置发送凭据（缺少 ILINK_TOKEN），微信提醒不会发出');
    }
    if (!this.toUserId) {
      return this.status(false, '未配置收件人（缺少 ILINK_TO_USER_ID），微信提醒不会发出');
    }
    const contextNote = this.contextToken
      ? ''
      : '；未配置 ILINK_CONTEXT_TOKEN，将按既有实现以空上下文尝试发送';
    return this.status(true, `凭据已齐备，通道地址 ${safeHost(this.baseUrl)}${contextNote}`);
  }

  private status(configured: boolean, detail: string): ProviderStatus {
    return {
      channel: this.channel,
      name: this.name,
      configured,
      reachable: this.lastReachable,
      probedAt: this.lastProbedAt,
      detail,
    };
  }

  /**
   * 只读连通性探测：只验证 DNS/TLS/HTTP 是否可达，**不发送任何消息**。
   * 可达 ≠ 凭据有效 ≠ 业务接受，三者分开呈现。
   */
  async probe(): Promise<ProviderStatus> {
    const probedAt = new Date().toISOString();
    try {
      const response = await fetch(`${this.baseUrl}/`, {
        method: 'GET',
        signal: AbortSignal.timeout(8_000),
        redirect: 'manual',
      });
      // 任何 HTTP 状态码都说明链路可达（服务在线）；网络层异常才算不可达
      this.lastReachable = true;
      this.lastProbedAt = probedAt;
      const base = this.describe();
      return {
        ...base,
        detail: `${base.detail}；链路可达（HTTP ${response.status}）`,
      };
    } catch (err) {
      this.lastReachable = false;
      this.lastProbedAt = probedAt;
      const base = this.describe();
      return {
        ...base,
        detail: `${base.detail}；链路不可达：${sanitize((err as Error).message).slice(0, 120)}`,
      };
    }
  }

  async send(payload: NotificationJobPayload): Promise<SendResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        kind: 'needs_human',
        error: 'ILINK_NOT_CONFIGURED',
      };
    }

    const text = `${payload.title}\n${payload.body}`.trim();
    if (!text) {
      return { ok: false, kind: 'rejected', error: 'empty_text' };
    }

    // client_id 由幂等键派生：同一任务重试时携带同一标识，
    // 下游若按 client_id 去重即可避免重复送达（尽力而为，不承诺恰好一次）。
    const baseClientId = `lifeos:${payload.idempotencyKey}`;
    const chunks = chunkText(text, MAX_TEXT_CHARS);

    const outcomes: ChunkOutcome[] = [];
    for (let i = 0; i < chunks.length; i++) {
      outcomes.push(
        await this.sendChunk(chunks[i]!, chunks.length > 1 ? `${baseClientId}#${i + 1}` : baseClientId),
      );
    }

    const accepted = outcomes.filter((o) => o.kind === 'accepted').length;
    const total = outcomes.length;
    const codes = outcomes.map((o) => o.detail).join(' | ').slice(0, 300);

    // ── 汇总语义与既有实现一致：部分接受绝不算整体成功 ──
    if (accepted === total && total > 0) {
      return { ok: true, detail: `business_accepted:${accepted}/${total}` };
    }
    if (accepted > 0 && accepted < total) {
      return {
        ok: false,
        kind: 'unknown',
        error: `partial_acceptance_remote_may_have_accepted:${accepted}/${total}:${codes}`,
      };
    }
    const auth = outcomes.find((o) => o.kind === 'auth_or_context');
    if (auth) {
      return { ok: false, kind: 'needs_human', error: `auth_or_context:${auth.detail}`.slice(0, 300) };
    }
    const biz = outcomes.find((o) => o.kind === 'business_error');
    if (biz) {
      return { ok: false, kind: 'retryable', error: `business_error:${biz.detail}`.slice(0, 300) };
    }
    const timeout = outcomes.find((o) => o.kind === 'timeout');
    if (timeout) {
      return {
        ok: false,
        kind: 'unknown',
        error: `timeout_remote_may_have_accepted:${timeout.detail}`.slice(0, 300),
      };
    }
    const httpErr = outcomes.find((o) => o.kind === 'http_error');
    if (httpErr) {
      return { ok: false, kind: 'retryable', error: `http_error:${httpErr.detail}`.slice(0, 300) };
    }
    const unknown = outcomes.find((o) => o.kind === 'unknown');
    return {
      ok: false,
      kind: 'unknown',
      error: `unconfirmed_remote_may_have_accepted:${unknown?.detail ?? 'no_outcome'}`.slice(0, 300),
    };
  }

  private async sendChunk(text: string, clientId: string): Promise<ChunkOutcome> {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: this.toUserId,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: this.contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };

    try {
      const response = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: buildHeaders(this.token, body),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        return { kind: 'http_error', detail: `HTTP ${response.status} ${sanitize(raw).slice(0, 120)}` };
      }

      const raw = await response.text();
      let parsed: IlinkBody | null = null;
      try {
        parsed = JSON.parse(raw) as IlinkBody;
      } catch {
        // HTTP 200 但业务体非 JSON：不能当作成功，也无法判定拒绝
        return { kind: 'unknown', detail: `malformed_business_body:${sanitize(raw).slice(0, 120)}` };
      }

      return classify(this, parsed);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // AbortSignal.timeout 触发时，请求可能已被对端处理 → 结果未知，绝不自动重试
      if (/abort|timeout|timed out/i.test(message)) {
        return { kind: 'timeout', detail: 'send timeout; remote result unknown' };
      }
      return { kind: 'unknown', detail: `network_error:${sanitize(message).slice(0, 120)}` };
    }
  }
}

/** 与既有实现 classifySendBusiness 等价的业务码判定 */
function classify(_provider: IlinkWechatProvider, body: IlinkBody | null): ChunkOutcome {
  if (!body || typeof body !== 'object') {
    return { kind: 'unknown', detail: 'missing_business_body' };
  }

  const ret = body.ret;
  const errcode = body.errcode;
  const errmsg = typeof body.errmsg === 'string' ? body.errmsg : '';

  const retSet = ret !== undefined && ret !== null;
  const errSet = errcode !== undefined && errcode !== null;
  const retBad = retSet && ret !== 0;
  const errBad = errSet && errcode !== 0;

  if (retBad || errBad) {
    const authLike =
      errcode === -14 ||
      ret === -14 ||
      errcode === -2 ||
      ret === -2 ||
      /session timeout|login|auth|token|unauthorized/i.test(errmsg);
    const detail = `ret=${ret ?? '-'},errcode=${errcode ?? '-'},errmsg=${sanitize(errmsg).slice(0, 80)}`;
    return authLike
      ? { kind: 'auth_or_context', detail }
      : { kind: 'business_error', detail };
  }

  const messageId = body.message_id;
  const hasServerId =
    (typeof messageId === 'string' && messageId.trim().length > 0) ||
    (typeof messageId === 'number' && Number.isFinite(messageId) && messageId > 0);

  if (ret === 0 || errcode === 0 || hasServerId) {
    // 边角：业务码为 0 但 errmsg 明确报错 → 不算接受
    if (errmsg && /fail|error|invalid|denied|timeout|expired/i.test(errmsg)) {
      return { kind: 'unknown', detail: `zero_codes_but_error_msg:${sanitize(errmsg).slice(0, 80)}` };
    }
    return { kind: 'accepted', detail: hasServerId ? 'server_message_id_ack' : 'business_ok' };
  }

  // 有 HTTP 200 但无任何可确认成功的业务码
  return { kind: 'unknown', detail: 'business_unconfirmed' };
}

function buildHeaders(token: string, body: unknown): Record<string, string> {
  const encoded = JSON.stringify(body);
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    Authorization: `Bearer ${token}`,
    'Content-Length': String(Buffer.byteLength(encoded, 'utf-8')),
  };
}

/** 与既有实现一致：uint32 十进制字符串的 base64 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // 尽量在换行处断开，避免把一行消息劈成两半
    const window = rest.slice(0, limit);
    const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'));
    const cut = breakAt > limit * 0.5 ? breakAt + 1 : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(无效地址)';
  }
}

/** 脱敏：日志与数据库中不得残留完整 token 或长标识（PRD FR-08） */
function sanitize(text: string): string {
  return (text || '')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/[A-Za-z0-9._\-]{24,}/g, '***');
}

export type { SendFailureKind };
