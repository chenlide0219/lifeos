import type { NotificationProvider, ProviderStatus } from './provider';
import { ManagedWechatProvider } from './providers/managed-wechat';

// 保留具体类型：多用户下"渠道状态"必须能逐账号说明（见 wechatAccountSummary）
const managedWechat = new ManagedWechatProvider();
const providers: NotificationProvider[] = [managedWechat];

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

/**
 * 微信通道的**逐账号**摘要（启动横幅、以及"为什么发不出去"的排查入口）。
 *
 * 多用户下"渠道可不可用"不再是一个布尔值：可能是 A 可发、B 等待上下文、C 窗口暂停。
 * 因此这里返回"已绑定几个 / 其中几个可发送 / 各自卡在什么状态"。
 */
export function wechatAccountSummary(): {
  bound: number;
  sendable: number;
  accounts: { userId: number; sendable: boolean; label: string }[];
  detail: string;
} {
  const accounts = managedWechat.accountStates();
  return {
    bound: accounts.length,
    sendable: accounts.filter((account) => account.sendable).length,
    accounts,
    detail: managedWechat.describe().detail,
  };
}

/**
 * 是否至少有一个渠道"已配置"（凭据齐备）。
 *
 * ⚠️ 多用户下**不能**用它表示"能发出去"：渠道可用与否是**逐账号**判定的
 * （见 `core.ts` 的 `claimDueJobs(sendableUserIds)`）。
 * 把这个全局布尔值当成闸门，正是改造前"B 绑定了就能发 A 的提醒"那个缺陷的来源。
 */
export function hasConfiguredProvider(): boolean {
  return providers.some((p) => p.isConfigured());
}

export function unconfiguredDetail(): string {
  const first = providers[0];
  return first ? first.describe().detail : '没有注册任何通知渠道';
}
