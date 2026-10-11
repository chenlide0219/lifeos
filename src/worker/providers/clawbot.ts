import type {
  NotificationJobPayload,
  NotificationProvider,
  ProviderStatus,
  SendResult,
} from '../provider';

/**
 * 微信 Clawbot 适配器。
 *
 * 现状（技术预研结论）：PRD 要求复用 MultiHarnessNotifier 中的 Clawbot 发送能力，
 * 但该项目的源代码位置与授权方式尚未提供，因此本适配器**尚未接通**。
 *
 * 按 PRD 第 11 节第 4 条：Clawbot 无法迁移属 V1 上线阻塞项，不得暗称已实现。
 * 在接通之前：
 *   - isConfigured() 返回 false；
 *   - Worker 不消费任何提醒任务（保持 pending），不会丢任务，也不会伪造送达；
 *   - 设置页如实显示“未配置”。
 *
 * 接通方式：在 .env 配置 CLAWBOT_ENDPOINT / CLAWBOT_TOKEN 后，
 * 将下方 send() 的请求体替换为 Clawbot 实际协议即可，其余代码无需改动。
 */
export class ClawbotProvider implements NotificationProvider {
  readonly channel = 'wechat';
  readonly name = 'Clawbot 微信';

  private readonly endpoint = process.env.CLAWBOT_ENDPOINT ?? '';
  private readonly token = process.env.CLAWBOT_TOKEN ?? '';

  isConfigured(): boolean {
    return Boolean(this.endpoint && this.token);
  }

  describe(): ProviderStatus {
    if (!this.isConfigured()) {
      return {
        channel: this.channel,
        name: this.name,
        configured: false,
        detail: 'Clawbot 发送端点未配置（缺少 CLAWBOT_ENDPOINT / CLAWBOT_TOKEN），微信提醒暂不会发出',
      };
    }
    return {
      channel: this.channel,
      name: this.name,
      configured: true,
      detail: '已配置',
    };
  }

  async send(payload: NotificationJobPayload): Promise<SendResult> {
    if (!this.isConfigured()) {
      return { ok: false, error: 'CLAWBOT_NOT_CONFIGURED', permanent: false };
    }

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          // 下游若不支持幂等，Worker 侧靠租约与幂等键尽力去重（PRD FR-07）
          idempotency_key: payload.idempotencyKey,
          text: `${payload.title}\n${payload.body}`,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // 4xx 多为配置/参数问题，重试无益；5xx 与 429 可重试
        const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
        return {
          ok: false,
          error: `HTTP ${response.status} ${sanitize(text).slice(0, 200)}`,
          permanent,
        };
      }

      return { ok: true, detail: `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, error: sanitize((err as Error).message).slice(0, 200) };
    }
  }
}

/** 脱敏：日志与数据库中不得残留完整 token 或会话凭证（PRD FR-08） */
function sanitize(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/[A-Za-z0-9._\-]{32,}/g, '***');
}
