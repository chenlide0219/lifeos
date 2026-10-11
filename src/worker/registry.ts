import type { NotificationProvider } from './provider';
import { ClawbotProvider } from './providers/clawbot';

const providers: NotificationProvider[] = [new ClawbotProvider()];

export function getProvider(channel: string): NotificationProvider | undefined {
  return providers.find((p) => p.channel === channel);
}

export function listProviderStatuses() {
  return providers.map((p) => p.describe());
}
