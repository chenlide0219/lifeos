import type { ProviderStatus } from '../../worker/provider';
import { listProviders } from '../../worker/registry';

/**
 * 渠道状态（含只读连通性探测）的带缓存实现。
 *
 * 探测是外部网络调用，不能让每个页面请求都打出去，也不能让它拖慢接口。
 * 因此缓存 60 秒，并在探测失败时退回"未探测"而不是抛错。
 */
const PROBE_TTL_MS = 60_000;

let cache: { at: number; statuses: ProviderStatus[] } | null = null;
let inFlight: Promise<ProviderStatus[]> | null = null;

export async function getProviderStatuses(options: { force?: boolean } = {}): Promise<{
  statuses: ProviderStatus[];
  probedAt: string;
}> {
  if (!options.force && cache && Date.now() - cache.at < PROBE_TTL_MS) {
    return { statuses: cache.statuses, probedAt: new Date(cache.at).toISOString() };
  }

  // 并发请求合并为一次探测
  if (!inFlight) {
    inFlight = Promise.all(
      listProviders().map((p) => p.probe().catch(() => p.describe())),
    ).finally(() => {
      inFlight = null;
    });
  }

  const statuses = await inFlight;
  cache = { at: Date.now(), statuses };
  return { statuses, probedAt: new Date(cache.at).toISOString() };
}

/** 不触发探测的快速读取：只反映凭据是否齐备 */
export function getProviderConfiguredStatuses(): ProviderStatus[] {
  return listProviders().map((p) => p.describe());
}
