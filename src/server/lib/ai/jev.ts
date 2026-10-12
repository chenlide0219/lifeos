/**
 * Jev（TypeSafe System One）客户端 —— V1.1 受控意图路由（PRD 第 4 节）。
 *
 * 调用优先级（AGENTS.md 的既定规则，实现为**运行时回退**而非静态选择）：
 *   1. 官方 key（`JEV_OFFICIAL_API_KEY`）+ 官方端点 `https://api.typesafe.ai/v1/systemone`；
 *   2. 官方不可用时回退到 `.env` 中的中转站（`JEV_BASE_URL` + `JEV_API_KEY`）。
 *
 * 实测事实（2026-10-12，两条命令的真实输出）：
 *   - 中国大陆出口调官方 → `451 Typesafe is not available in your region.`
 *   - 美国服务器调官方   → `200 {"model":"jev-1.13.0", "answers":{...}}`
 *   - 中转站（rsiai.net）从中美两地均 `200`，且提供 `jev-latest` / `jev-1.13.0`。
 * 因此"官方优先"在生产（美国 VPS）直连成功，在本地开发自动落到中转，无需人工切换。
 *
 * 接口契约（官方文档 primitives/choice 与实测确认，**易错点**）：
 *   - `criteria` 与 `type` / `instructions` **并列**，不能套在 `choice` 对象里；
 *   - Choice 的 `criteria` 是**映射**（选项名 → 描述），Score 才是数组；
 *   - 响应 `answers.<问题名>.choice` 为**选项名**，另含 `confidence` 与 `probabilities`。
 *   早期把它写成 `choice: { criteria: [...] }` 会得到 `422 Field required`。
 *
 * 硬性约束（PRD 4.3 / 6）：
 *   - 置信度只用于路由与澄清，**不授权写库**；
 *   - 超时、认证失败、限流、非法响应**均不触发未确认写入**；
 *   - 回退有上限，不因切换服务而放宽确认要求。
 */
import { config } from '../../config';

/** 官方端点固定写死：AGENTS.md 明确"走官方 baseurl"，不接受运行时改写 */
export const JEV_OFFICIAL_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export type JevRoute = 'official' | 'relay';

export type JevChoiceAnswer = {
  kind: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type JevNoulAnswer = {
  kind: 'noul';
  probability: number;
  confidence: number | null;
};

export type JevScoreAnswer = {
  kind: 'score';
  score: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export type JevResult =
  | {
      ok: true;
      /** 实际生效的路径，写入日志用于观测回退是否发生 */
      route: JevRoute;
      model: string;
      answers: Record<string, JevAnswer>;
      usage: { inputTokens: number; outputTokens: number } | null;
    }
  | {
      ok: false;
      /** not_configured：没有任何可用凭据；rejected：上游明确拒绝；timeout；bad_output；both_failed */
      kind: 'not_configured' | 'rejected' | 'timeout' | 'bad_output' | 'both_failed';
      error: string;
      /** 已尝试过的路径，便于排错 */
      attempted: JevRoute[];
    };

/**
 * 问题定义。Choice/Score 必须给 `criteria`。
 * 用映射而非数组是官方契约（见文件头）。
 */
export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };

export type JevRequestOptions = {
  state: string;
  questions: Record<string, JevQuestion>;
  /** 默认 PRD 指定的 jev-1.13.0 */
  model?: string;
  timeoutMs?: number;
  /** 供测试注入；生产不传 */
  fetchImpl?: typeof fetch;
};

/** 单个端点失败后是否值得尝试另一条路 */
function shouldFallback(status: number): boolean {
  // 451/403：区域封锁；404：端点不存在；408/429：超时或限流；5xx：上游故障
  return status === 451 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}

/**
 * PRD 4.3 指定模型为 `jev-1.13.0`，并要求"部署前核实该模型可用性，不静默替换版本"。
 * 因此默认值就是文档指定版本，而非 `jev-latest`（后者会把版本漂移藏起来）。
 * 已实测：官方端点与中转站均接受 `jev-1.13.0`。
 */
export const JEV_DOCUMENTED_MODEL = 'jev-1.13.0';

function modelOf(explicit?: string): string {
  return explicit ?? process.env.JEV_MODEL ?? JEV_DOCUMENTED_MODEL;
}

export function officialConfigured(): boolean {
  return Boolean((process.env.JEV_OFFICIAL_API_KEY ?? '').trim());
}

export function relayConfigured(): boolean {
  return Boolean((process.env.JEV_API_KEY ?? '').trim() && (process.env.JEV_BASE_URL ?? '').trim());
}

export function isJevConfigured(): boolean {
  return officialConfigured() || relayConfigured();
}

/** 中转 baseurl 可能已含 /v1/systemone，做归一化避免拼成 /v1/systemone/v1/systemone */
export function relayEndpoint(): string {
  const base = (process.env.JEV_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/v1\/systemone$/.test(base) ? base : `${base}/v1/systemone`;
}

type AttemptOutcome =
  | { ok: true; route: JevRoute; model: string; answers: Record<string, JevAnswer>; usage: { inputTokens: number; outputTokens: number } | null }
  | { ok: false; route: JevRoute; retryable: boolean; kind: 'rejected' | 'timeout' | 'bad_output'; error: string };

async function attempt(
  route: JevRoute,
  endpoint: string,
  key: string,
  options: JevRequestOptions,
): Promise<AttemptOutcome> {
  const timeoutMs = options.timeoutMs ?? Number(process.env.JEV_TIMEOUT_MS ?? 30_000);
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: options.state,
        model: modelOf(options.model),
        questions: options.questions,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const isTimeout = /abort|timeout|timed out/i.test(message);
    return {
      ok: false,
      route,
      // 超时属于"可能已送达"的不确定态，可尝试另一条路（另一条路是独立网关）
      retryable: true,
      kind: isTimeout ? 'timeout' : 'rejected',
      error: sanitize(message).slice(0, 200),
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      route,
      retryable: shouldFallback(response.status),
      kind: 'rejected',
      error: `HTTP ${response.status}: ${sanitize(text).slice(0, 200)}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, route, retryable: false, kind: 'bad_output', error: '上游返回的不是合法 JSON' };
  }

  const parsed = normalizeResponse(payload);
  if (!parsed) {
    return { ok: false, route, retryable: false, kind: 'bad_output', error: '上游响应缺少 answers' };
  }
  return { ok: true, route, ...parsed };
}

/**
 * 发送一次 System One 请求。
 * 官方优先；仅在"值得重试"的失败上落到中转，避免把参数错误也重放一遍。
 */
export async function jevSystemOne(options: JevRequestOptions): Promise<JevResult> {
  const attempted: JevRoute[] = [];

  const routes: { route: JevRoute; endpoint: string; key: string }[] = [];
  const officialKey = (process.env.JEV_OFFICIAL_API_KEY ?? '').trim();
  if (officialKey) {
    routes.push({ route: 'official', endpoint: JEV_OFFICIAL_ENDPOINT, key: officialKey });
  }
  const relayKey = (process.env.JEV_API_KEY ?? '').trim();
  const relayUrl = relayEndpoint();
  if (relayKey && relayUrl) {
    routes.push({ route: 'relay', endpoint: relayUrl, key: relayKey });
  }

  if (routes.length === 0) {
    return {
      ok: false,
      kind: 'not_configured',
      error: '未配置 Jev 凭据（JEV_OFFICIAL_API_KEY 或 JEV_API_KEY+JEV_BASE_URL）',
      attempted: [],
    };
  }

  let firstFailure: { kind: 'rejected' | 'timeout' | 'bad_output'; error: string; route: JevRoute } | null = null;

  for (let i = 0; i < routes.length; i += 1) {
    const target = routes[i]!;
    attempted.push(target.route);
    const outcome = await attempt(target.route, target.endpoint, target.key, options);

    if (outcome.ok) {
      return { ok: true, route: outcome.route, model: outcome.model, answers: outcome.answers, usage: outcome.usage };
    }

    if (!firstFailure) {
      firstFailure = { kind: outcome.kind, error: outcome.error, route: outcome.route };
    }
    // 参数级错误不该换一条路重放：两边契约不同，重复只会浪费额度
    if (!outcome.retryable) {
      return { ok: false, kind: outcome.kind, error: outcome.error, attempted };
    }
  }

  const hasOther = routes.length > 1;
  return {
    ok: false,
    kind: hasOther ? 'both_failed' : (firstFailure?.kind ?? 'rejected'),
    error: firstFailure?.error ?? '上游调用失败',
    attempted,
  };
}

/** 收窄上游响应，禁止把任意结构透传给业务层 */
export function normalizeResponse(payload: unknown): {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { inputTokens: number; outputTokens: number } | null;
} | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const rawAnswers = body.answers;
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) return null;

  const answers: Record<string, JevAnswer> = {};
  for (const [name, value] of Object.entries(rawAnswers as Record<string, unknown>)) {
    const answer = normalizeAnswer(value);
    if (answer) answers[name] = answer;
  }

  const usageRaw = body.usage;
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  if (usageRaw && typeof usageRaw === 'object') {
    const u = usageRaw as Record<string, unknown>;
    if (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number') {
      usage = { inputTokens: Number(u.input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0) };
    }
  }

  return { model: typeof body.model === 'string' ? body.model : 'unknown', answers, usage };
}

function normalizeAnswer(value: unknown): JevAnswer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  const type = a.type;

  if (type === 'choice' && typeof a.choice === 'string') {
    return {
      kind: 'choice',
      choice: a.choice,
      confidence: numberOr(a.confidence, 0),
      probabilities: numberMap(a.probabilities),
    };
  }
  if (type === 'score' && typeof a.score === 'string') {
    return {
      kind: 'score',
      score: a.score,
      confidence: numberOr(a.confidence, 0),
      probabilities: numberMap(a.probabilities),
    };
  }
  if (type === 'noul') {
    // 官方 noul 响应形如 {"type":"noul","noul":0.98}；兼容 probability 命名
    const p = typeof a.noul === 'number' ? a.noul : typeof a.probability === 'number' ? a.probability : null;
    if (p === null) return null;
    return {
      kind: 'noul',
      probability: p,
      confidence: typeof a.confidence === 'number' ? a.confidence : null,
    };
  }
  return null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** 只取 choice 答案，供路由使用 */
export function choiceOf(answers: Record<string, JevAnswer>, name: string): JevChoiceAnswer | null {
  const answer = answers[name];
  return answer && answer.kind === 'choice' ? answer : null;
}

function sanitize(text: string): string {
  return (text || '')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/\b(apikey-)[A-Za-z0-9._\-]{8,}/gi, '$1***')
    .replace(/\b(sk-)[A-Za-z0-9._\-]{8,}/gi, '$1***');
}

export { config };
