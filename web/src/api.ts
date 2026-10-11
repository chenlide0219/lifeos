import type { AiDraft, AuthResponse, HealthResponse } from '@shared/types';

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

export type ReminderResult = {
  created: number;
  resurrected: number;
  cancelled: number;
  /** 创建时已经过去、按政策不补发的提醒数 */
  skippedPast: number;
  /** 已发送过、为避免重复送达而保留不动的提醒数 */
  skippedSent: number;
  ruleEnabled: boolean;
};

export type EventDto = {
  id: string;
  title: string;
  startAt: string;
  endAt: string | null;
  location: string | null;
  note: string | null;
  status: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskDto = {
  id: string;
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  status: string;
  completedAt: string | null;
  note: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type CalendarItemDto = {
  type: 'event' | 'task' | 'subscription';
  id: string;
  title: string;
  start: string;
  end: string | null;
  date: string;
  time: string | null;
  allDay: boolean;
  status: string;
  inactive: boolean;
  meta: Record<string, unknown>;
};

export type CalendarResponse = {
  items: CalendarItemDto[];
  counts: Record<string, number>;
  range: { from: string; to: string; fromDate: string; toDate: string };
};

export type OverviewResponse = {
  today: string;
  horizonDate: string;
  events: { id: string; title: string; startAt: string; date: string; time: string; location: string | null }[];
  tasksDueToday: { id: string; title: string; dueDate: string | null; dueTime: string | null }[];
  tasksDueTodayCount: number;
};

export type TaskView = 'inbox' | 'today' | 'upcoming' | 'done';

export type EventInput = {
  title: string;
  startAt: string;
  endAt?: string | null;
  location?: string | null;
  note?: string | null;
  reminderEnabled?: boolean;
  reminderOffsets?: number[];
  source?: 'manual' | 'voice';
};

export type TaskInput = {
  title: string;
  dueDate?: string | null;
  dueTime?: string | null;
  note?: string | null;
  reminderEnabled?: boolean;
  reminderOffsets?: number[];
  source?: 'manual' | 'voice';
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

  events: {
    list: (range: { from?: string; to?: string } = {}) => {
      const query = new URLSearchParams();
      if (range.from) query.set('from', range.from);
      if (range.to) query.set('to', range.to);
      const suffix = query.toString();
      return request<{ events: EventDto[] }>(`/events${suffix ? `?${suffix}` : ''}`);
    },
    create: (input: EventInput) =>
      request<{ event: EventDto; reminder: ReminderResult }>('/events', { method: 'POST', body: input }),
    update: (id: string, input: Partial<EventInput>) =>
      request<{ event: EventDto; reminder: ReminderResult }>(`/events/${id}`, {
        method: 'PATCH',
        body: input,
      }),
    cancel: (id: string) =>
      request<{ event: EventDto; reminder: ReminderResult }>(`/events/${id}/cancel`, { method: 'POST' }),
    remove: (id: string) => request<{ ok: boolean }>(`/events/${id}`, { method: 'DELETE' }),
  },

  tasks: {
    list: (view: TaskView) => request<{ tasks: TaskDto[]; view: TaskView; today: string }>(`/tasks?view=${view}`),
    counts: () =>
      request<{ counts: Record<TaskView, number>; today: string }>('/tasks/counts'),
    create: (input: TaskInput) =>
      request<{ task: TaskDto; reminder: ReminderResult }>('/tasks', { method: 'POST', body: input }),
    update: (id: string, input: Partial<TaskInput>) =>
      request<{ task: TaskDto; reminder: ReminderResult }>(`/tasks/${id}`, {
        method: 'PATCH',
        body: input,
      }),
    complete: (id: string) =>
      request<{ task: TaskDto; reminder: ReminderResult }>(`/tasks/${id}/complete`, { method: 'POST' }),
    reopen: (id: string) =>
      request<{ task: TaskDto; reminder: ReminderResult }>(`/tasks/${id}/reopen`, { method: 'POST' }),
    remove: (id: string) => request<{ ok: boolean }>(`/tasks/${id}`, { method: 'DELETE' }),
  },

  calendar: {
    range: (range: { from: string; to: string }) =>
      request<CalendarResponse>(
        `/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
    overview: () => request<OverviewResponse>('/calendar/overview'),
  },

  voice: {
    status: () =>
      request<{
        asr: { configured: boolean; model: string };
        llm: { configured: boolean; model: string };
        limits: { maxAudioBytes: number };
      }>('/voice/status'),

    /** 音频以 base64 上传；服务端只在内存中处理，不落盘 */
    transcribe: (audio: string, format: 'wav' | 'mp3') =>
      request<{ text: string; seconds: number | null; model: string }>('/voice/transcribe', {
        method: 'POST',
        body: { audio, format },
      }),

    /** 只返回草稿，不落库；确认创建由 events/tasks 接口完成 */
    parse: (text: string) =>
      request<{ draft: AiDraft; persisted: boolean; timezone: string }>('/voice/parse', {
        method: 'POST',
        body: { text },
      }),
  },
};
