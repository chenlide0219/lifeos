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
  configured: boolean;
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
};
