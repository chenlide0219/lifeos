import crypto from 'node:crypto';

export const ILINK_LOGIN_BASE = 'https://ilinkai.weixin.qq.com';
/** Login redirects may change the host, never allow arbitrary credential destinations. */
export function trustedIlinkBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')) || url.pathname !== '/') {
    throw new Error('微信返回了不受信任的服务地址');
  }
  return url.origin;
}
export async function ilinkRequest(base: string, endpoint: string, options: { token?: string; body?: unknown; signal?: AbortSignal; timeout?: number } = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '1' };
  if (options.body !== undefined) {
    Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE())).toString('base64') });
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${trustedIlinkBase(base)}/${endpoint}`, {
    method: options.body === undefined ? 'GET' : 'POST', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body), redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? 35_000)]) : AbortSignal.timeout(options.timeout ?? 35_000),
  });
  if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('微信接口返回格式异常');
  return data as Record<string, unknown>;
}
