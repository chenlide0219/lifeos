/**
 * 通知提供方接口：把微信实现隔离在适配器之后（PRD FR-07）。
 *
 * 结果必须区分三态以上，不能只有"成功/失败"：
 * - rejected / needs_human：下游明确拒绝或需要人工介入 → 终止，不重试；
 * - retryable：下游明确可重试的失败 → 按退避重试；
 * - unknown：**无法确认下游是否已接受** → 绝不自动重试，避免重复送达。
 *   HTTP 200 不等于业务接受，缺少可靠回执一律归入 unknown。
 */
export type NotificationJobPayload = {
  jobId: string;
  title: string;
  body: string;
  subjectType: string;
  subjectId: string;
  /** 幂等键：用于派生稳定的下游 client_id，使重试携带同一标识 */
  idempotencyKey: string;
};

export type SendFailureKind = 'retryable' | 'rejected' | 'needs_human' | 'unknown';

export type SendResult =
  | { ok: true; detail: string }
  | { ok: false; kind: SendFailureKind; error: string };

/** 配置状态与实际连通状态分开报告，避免"填了环境变量"被当成"通道可用" */
export type ProviderStatus = {
  channel: string;
  name: string;
  /** 凭据是否齐备 */
  configured: boolean;
  /** 最近一次探测是否可达（null 表示尚未探测） */
  reachable: boolean | null;
  /** 最近一次探测的时间（ISO） */
  probedAt: string | null;
  detail: string;
};

export interface NotificationProvider {
  readonly channel: string;
  readonly name: string;
  isConfigured(): boolean;
  describe(): ProviderStatus;
  /** 只读连通性探测：不发送任何消息 */
  probe(): Promise<ProviderStatus>;
  send(payload: NotificationJobPayload): Promise<SendResult>;
}
