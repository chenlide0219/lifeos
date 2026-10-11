import type { AuthResponse, HealthResponse } from '@shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, '网络连接失败，请检查网络后重试', 'network_error');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const data = payload as { message?: string; error?: string } | null;
    throw new ApiError(
      response.status,
      data?.message || `请求失败（HTTP ${response.status}）`,
      data?.error,
    );
  }

  return payload as T;
}

export type ProviderStatusDto = {
  channel: string;
  name: string;
  /** 凭据是否齐备 */
  configured: boolean;
  /** 最近一次只读探测是否可达；null 表示尚未探测 */
  reachable: boolean | null;
  probedAt: string | null;
  detail: string;
};

export type SystemStatusResponse = {
  version: string;
  timezone: string;
  now: string;
  db: 'up' | 'down';
  ai: {
    asr: { configured: boolean; model: string; baseUrl: string };
    llm: { configured: boolean; model: string; baseUrl: string };
  };
  notifications: ProviderStatusDto[];
  providersProbedAt: string;
};

export type NotificationJobStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'missed';

export type NotificationJobDto = {
  id: string;
  subjectType: string;
  subjectId: string;
  title: string;
  status: NotificationJobStatus;
  /** retryable | rejected | needs_human | unknown | exhausted */
  failureKind: string | null;
  fireAt: string;
  sentAt: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
};

export type NotificationJobsResponse = {
  jobs: NotificationJobDto[];
  summary: Record<string, number>;
  total: number;
  limit: number;
  offset: number;
  providerReady: boolean;
};

export const api = {
  login: (username: string, password: string) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: { username, password } }),

  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () => request<AuthResponse>('/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),

  health: () => request<HealthResponse>('/health'),

  status: () => request<SystemStatusResponse>('/status'),

  notificationJobs: (params: { status?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    const suffix = query.toString();
    return request<NotificationJobsResponse>(`/notifications/jobs${suffix ? `?${suffix}` : ''}`);
  },
};
