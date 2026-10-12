/**
 * Jev 客户端回归测试（PRD 4.3、AGENTS.md 的官方优先 / 中转回退规则）。
 *
 * 这里全部用注入的 fetch 模拟上游，**不发起真实网络请求、不使用真实密钥**：
 * 真实可用性由部署前实测确认（见 PROGRESS 记录），单测负责锁定契约与回退语义。
 *
 * 覆盖的失败模式都是真实发生过的：
 *   - 官方端点对中国大陆出口返回 451（"Typesafe is not available in your region."）；
 *   - `criteria` 结构写错会得到 422（Choice 的 criteria 是映射且与 type 并列）。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  JEV_DOCUMENTED_MODEL,
  JEV_OFFICIAL_ENDPOINT,
  choiceOf,
  isJevConfigured,
  jevSystemOne,
  normalizeResponse,
  relayEndpoint,
} from '../../src/server/lib/ai/jev';

const SAVED = { ...process.env };

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const OFFICIAL = 'apikey-official-test-value';
const RELAY = 'relay-test-value';

function okBody(model = 'jev-1.13.0'): string {
  return JSON.stringify({
    model,
    answers: {
      intent: {
        type: 'choice',
        choice: 'create',
        confidence: 0.92,
        probabilities: { create: 0.93, query: 0.02, other: 0.05 },
      },
    },
    usage: { input_tokens: 419, output_tokens: 62 },
  });
}

/** 记录每个端点的调用次数与收到的请求体 */
function recorder(handlers: Array<(url: string, init: RequestInit) => Response | Promise<Response>>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let index = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    const handler = handlers[Math.min(index, handlers.length - 1)]!;
    index += 1;
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const QUESTION = {
  intent: {
    type: 'choice' as const,
    instructions: '这条消息的意图是什么？',
    criteria: { create: '新建事项', query: '查询已有安排' },
  },
};

beforeEach(() => {
  setEnv({
    JEV_OFFICIAL_API_KEY: undefined,
    JEV_API_KEY: undefined,
    JEV_BASE_URL: undefined,
    JEV_MODEL: undefined,
    JEV_TIMEOUT_MS: undefined,
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
});

describe('Jev 配置与端点归一化', () => {
  it('未配置任何凭据时 isJevConfigured 为 false，且调用返回 not_configured', async () => {
    assert.equal(isJevConfigured(), false);
    const result = await jevSystemOne({ state: 'x', questions: QUESTION });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'not_configured');
      assert.deepEqual(result.attempted, []);
    }
  });

  it('仅有中转凭据时也算已配置', () => {
    setEnv({ JEV_API_KEY: RELAY, JEV_BASE_URL: 'https://relay.example.com' });
    assert.equal(isJevConfigured(), true);
  });

  it('中转 baseurl 已含 /v1/systemone 时不重复拼接', () => {
    setEnv({ JEV_BASE_URL: 'https://www.rsiai.net/v1/systemone' });
    assert.equal(relayEndpoint(), 'https://www.rsiai.net/v1/systemone');
    setEnv({ JEV_BASE_URL: 'https://www.rsiai.net/' });
    assert.equal(relayEndpoint(), 'https://www.rsiai.net/v1/systemone');
  });
});

describe('Jev 官方优先与回退', () => {
  it('官方可用时只用官方，不触碰中转', async () => {
    setEnv({ JEV_OFFICIAL_API_KEY: OFFICIAL, JEV_API_KEY: RELAY, JEV_BASE_URL: 'https://relay.example.com' });
    const { fetchImpl, calls } = recorder([() => new Response(okBody(), { status: 200 })]);

    const result = await jevSystemOne({ state: '明天开会', questions: QUESTION, fetchImpl });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route, 'official');
      assert.equal(result.model, 'jev-1.13.0');
      assert.equal(result.usage?.inputTokens, 419);
      assert.equal(choiceOf(result.answers, 'intent')?.choice, 'create');
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, JEV_OFFICIAL_ENDPOINT);
  });

  it('官方返回 451（区域封锁）时回退到中转', async () => {
    setEnv({ JEV_OFFICIAL_API_KEY: OFFICIAL, JEV_API_KEY: RELAY, JEV_BASE_URL: 'https://relay.example.com' });
    const { fetchImpl, calls } = recorder([
      () =>
        new Response(JSON.stringify({ title: 'Typesafe is not available in your region.', status: 451 }), {
          status: 451,
        }),
      () => new Response(okBody(), { status: 200 }),
    ]);

    const result = await jevSystemOne({ state: '明天开会', questions: QUESTION, fetchImpl });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.route, 'relay');
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url, 'https://relay.example.com/v1/systemone');
  });

  it('官方 5xx 时回退到中转', async () => {
    setEnv({ JEV_OFFICIAL_API_KEY: OFFICIAL, JEV_API_KEY: RELAY, JEV_BASE_URL: 'https://relay.example.com' });
    const { fetchImpl } = recorder([
      () => new Response('upstream blew up', { status: 503 }),
      () => new Response(okBody(), { status: 200 }),
    ]);
    const result = await jevSystemOne({ state: 'x', questions: QUESTION, fetchImpl });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.route, 'relay');
  });

  it('参数级错误（422）不回退：契约不同，重放只会浪费额度', async () => {
    setEnv({ JEV_OFFICIAL_API_KEY: OFFICIAL, JEV_API_KEY: RELAY, JEV_BASE_URL: 'https://relay.example.com' });
    const { fetchImpl, calls } = recorder([
      () => new Response(JSON.stringify({ detail: [{ msg: 'Field required' }] }), { status: 422 }),
      () => new Response(okBody(), { status: 200 }),
    ]);

    const result = await jevSystemOne({ state: 'x', questions: QUESTION, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'rejected');
      assert.deepEqual(result.attempted, ['official']);
      assert.match(result.error, /422/);
    }
    assert.equal(calls.length, 1, '422 不应触发第二次请求');
  });

  it('两条路都失败时返回 both_failed 并记录已尝试路径', async () => {
    setEnv({ JEV_OFFICIAL_API_KEY: OFFICIAL, JEV_API_KEY: RELAY, JEV_BASE_URL: 'https://relay.example.com' });
    const { fetchImpl, calls } = recorder([() => new Response('nope', { status: 451 })]);
    const result = await jevSystemOne({ state: 'x', questions: QUESTION, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'both_failed');
      assert.deepEqual(result.attempted, ['official', 'relay']);
    }
    assert.equal(calls.length, 2);
  });

  it('仅配置中转时直接走中转', async () => {
    setEnv({ JEV_API_KEY: RELAY, JEV_BASE_URL: 'https://relay.example.com' });
    const { fetchImpl, calls } = recorder([() => new Response(okBody(), { status: 200 })]);
    const result = await jevSystemOne({ state: 'x', questions: QUESTION, fetchImpl });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.route, 'relay');
    assert.equal(calls.length, 1);
  });

  it('超时归类为 timeout，且视为可回退', async () => {
    setEnv({ JEV_OFFICIAL_API_KEY: OFFICIAL, JEV_API_KEY: RELAY, JEV_BASE_URL: 'https://relay.example.com' });
    let index = 0;
    const fetchImpl = (async () => {
      index += 1;
      if (index === 1) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return new Response(okBody(), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await jevSystemOne({ state: 'x', questions: QUESTION, fetchImpl });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.route, 'relay');
  });
});

describe('Jev 请求体与响应收窄', () => {
  it('按文档契约发送 criteria（映射且与 type 并列）', async () => {
    setEnv({ JEV_OFFICIAL_API_KEY: OFFICIAL });
    const { fetchImpl, calls } = recorder([() => new Response(okBody(), { status: 200 })]);
    await jevSystemOne({ state: '明天开会', questions: QUESTION, fetchImpl });

    const body = calls[0]!.body as {
      state: string;
      model: string;
      questions: Record<string, { type: string; criteria: Record<string, string> }>;
    };
    assert.equal(body.state, '明天开会');
    // 默认使用 PRD 指定模型，而不是会隐藏版本漂移的 latest 别名
    assert.equal(body.model, JEV_DOCUMENTED_MODEL);
    const q = body.questions.intent!;
    assert.equal(q.type, 'choice');
    assert.equal(q.criteria.create, '新建事项');
    // 关键回归：criteria 不能嵌套在 choice 对象里（写错会得到 422）
    assert.equal((q as Record<string, unknown>).choice, undefined);
  });

  it('显式 model 覆盖默认值', async () => {
    setEnv({ JEV_OFFICIAL_API_KEY: OFFICIAL, JEV_MODEL: 'jev-preview' });
    const { fetchImpl, calls } = recorder([() => new Response(okBody('jev-preview'), { status: 200 })]);
    await jevSystemOne({ state: 'x', questions: QUESTION, fetchImpl });
    assert.equal((calls[0]!.body as { model: string }).model, 'jev-preview');
  });

  it('缺少 answers 视为 bad_output', async () => {
    setEnv({ JEV_OFFICIAL_API_KEY: OFFICIAL });
    const { fetchImpl } = recorder([() => new Response(JSON.stringify({ model: 'x' }), { status: 200 })]);
    const result = await jevSystemOne({ state: 'x', questions: QUESTION, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'bad_output');
  });

  it('noul 响应兼容 noul 与 probability 两种命名', () => {
    const normalized = normalizeResponse({
      model: 'jev-1.13.0',
      answers: { a: { type: 'noul', noul: 0.98 }, b: { type: 'noul', probability: 0.4, confidence: 0.8 } },
    });
    assert.ok(normalized);
    assert.deepEqual(normalized!.answers.a, { kind: 'noul', probability: 0.98, confidence: null });
    assert.deepEqual(normalized!.answers.b, { kind: 'noul', probability: 0.4, confidence: 0.8 });
  });

  it('非 choice 的答案不会被 choiceOf 取到', () => {
    const answers = normalizeResponse({
      model: 'm',
      answers: { intent: { type: 'noul', noul: 0.5 }, other: { type: 'choice', choice: 'create', confidence: 1, probabilities: {} } },
    })!.answers;
    assert.equal(choiceOf(answers, 'intent'), null);
    assert.equal(choiceOf(answers, 'other')?.choice, 'create');
  });

  it('错误信息脱敏，不泄漏密钥', async () => {
    setEnv({ JEV_OFFICIAL_API_KEY: OFFICIAL });
    const { fetchImpl } = recorder([
      () => new Response(`bad key Bearer ${OFFICIAL} rejected`, { status: 500 }),
      () => new Response(`apikey-${'x'.repeat(20)} invalid`, { status: 500 }),
    ]);
    const result = await jevSystemOne({ state: 'x', questions: QUESTION, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.doesNotMatch(result.error, new RegExp(OFFICIAL));
      assert.doesNotMatch(result.error, /apikey-x{8}/);
    }
  });
});
