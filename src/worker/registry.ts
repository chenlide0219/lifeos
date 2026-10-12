import type { NotificationProvider, ProviderStatus } from './provider';
import { ManagedWechatProvider } from './providers/managed-wechat';

const providers: NotificationProvider[] = [new ManagedWechatProvider()];

export async function refreshProviders(): Promise<void> {
  for (const provider of providers) await provider.refresh?.();
}

export function getProvider(channel: string): NotificationProvider | undefined {
  return providers.find((p) => p.channel === channel);
}

export function listProviders(): NotificationProvider[] {
  return providers;
}

export function listProviderStatuses(): ProviderStatus[] {
  return providers.map((p) => p.describe());
}

/** 是否至少有一个可用渠道（凭据齐备）。未配置时 Worker 不领取任何发送任务。 */
export function hasConfiguredProvider(): boolean {
  return providers.some((p) => p.isConfigured());
}

export function unconfiguredDetail(): string {
  const first = providers[0];
  return first ? first.describe().detail : '没有注册任何通知渠道';
}
