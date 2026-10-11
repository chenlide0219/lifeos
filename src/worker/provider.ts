/**
 * 通知提供方接口：把微信实现隔离在适配器之后（PRD FR-07）。
 * 换渠道只需新增实现，Worker 调度逻辑不变。
 */
export type NotificationJobPayload = {
  jobId: string;
  title: string;
  body: string;
  subjectType: string;
  subjectId: string;
  /** 幂等键：下游若支持幂等应原样透传，避免重复送达 */
  idempotencyKey: string;
};

export type SendResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string; permanent?: boolean };

export type ProviderStatus = {
  channel: string;
  name: string;
  configured: boolean;
  /** 未配置时的原因，用于设置页展示 */
  detail: string;
};

export interface NotificationProvider {
  readonly channel: string;
  readonly name: string;
  isConfigured(): boolean;
  describe(): ProviderStatus;
  send(payload: NotificationJobPayload): Promise<SendResult>;
}
