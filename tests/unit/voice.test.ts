/**
 * 阶段 3 回归：语音链路（PRD FR-03）。
 *
 * 下游（MiMo ASR、DeepSeek）用桩化 fetch 提供**明确的模拟回执**，
 * 不冒充真实调用；重点是验证本方的契约与防护：
 *   - 未配置/失败时可恢复，且不产生半成品；
 *   - 含糊时间必须回问，绝不擅自补全；
 *   - 提醒只在原文明确要求时才开启；
 *   - 确认之前不落库。
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();

process.env.MIMO_API_KEY = 'test-mimo-key';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
process.env.MIMO_BASE_URL = 'https://mimo.test.invalid/v1';
process.env.DEEPSEEK_BASE_URL = 'https://deepseek.test.invalid/anthropic';

const { db, pool } = await import('../../src/server/db/client');
const { createApp } = await import('../../src/server/app');
const { users } = await import('../../src/server/db/schema');
const { hashPassword } = await import('../../src/server/lib/password');
const { extractJson, normalizeDraft, formatWithOffset } = await import('../../src/server/lib/ai/deepseek');

const app = createApp();
const realFetch = globalThis.fetch;
const TEST_PASSWORD = 'Voice-Test-Pass-1!';
let cookie = '';
let responder: () => Response | Promise<Response> = () => new Response('{}', { status: 200 });
let calls: string[] = [];

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function openAiStyleAsr(text: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text } }], usage: { seconds: 3 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function anthropicStyle(body: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: JSON.stringify(body) }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

before(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await db.insert(users).values({ username: 'voice-test', passwordHash: await hashPassword(TEST_PASSWORD) });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'voice-test', password: TEST_PASSWORD }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(cookie.startsWith('lifeos_session='), '测试管理员应能登录');
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE notification_attempts, notification_jobs, notification_rules, events, tasks RESTART IDENTITY CASCADE`,
  );
  calls = [];
  responder = () => new Response('{}', { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return responder();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await pool.end();
});

describe('草稿解析的纯逻辑', () => {
  it('能从 markdown 代码块与解释文字中提取 JSON', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('好的，结果如下：{"a":{"b":2}} 以上。'), { a: { b: 2 } });
    assert.equal(extractJson('完全不是 JSON'), null);
  });

  it('嵌套对象与字符串中的花括号不会截断解析', () => {
    const raw = '{"title":"含 } 的标题","nested":{"x":{"y":1}}}';
    assert.deepEqual(extractJson(raw), { title: '含 } 的标题', nested: { x: { y: 1 } } });
  });

  it('非法的提前量被丢弃，不会写入任意数值', () => {
    const draft = normalizeDraft({
      kind: 'event',
      title: 'x',
      start_at: '2030-01-01T10:00:00+08:00',
      reminder_enabled: true,
      reminder_offsets: [60, 999, -5, 'abc'],
    });
    assert.deepEqual(draft.reminder_offsets, [60]);
  });

  it('事件缺少开始时间时自动追加含糊提示（绝不擅自补全时间）', () => {
    const draft = normalizeDraft({ kind: 'event', title: '下周三开会', start_at: null });
    assert.ok(draft.ambiguities.some((a) => a.includes('开始时间')), '应提示补充时间');
  });

  it('提醒开关在没有任何合法提前量时强制关闭', () => {
    const draft = normalizeDraft({ kind: 'event', title: 'x', start_at: '2030-01-01T10:00:00+08:00', reminder_enabled: true, reminder_offsets: [] });
    assert.equal(draft.reminder_enabled, false);
  });

  it('本地时间字符串带正确时区偏移', () => {
    const formatted = formatWithOffset(new Date('2030-01-01T02:00:00Z'), 'Asia/Shanghai');
    assert.equal(formatted, '2030-01-01T10:00:00+08:00');
  });
});

describe('语音转写接口', () => {
  it('成功时返回转写文本', async () => {
    responder = () => openAiStyleAsr('下周三下午三点开会');
    const res = await request('/api/voice/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audio: 'A'.repeat(4000), format: 'wav' }),
    });
    assert.equal(res.status, 200);
    const body = await json<{ text: string }>(res);
    assert.equal(body.text, '下周三下午三点开会');
    assert.match(calls[0]!, /mimo\.test\.invalid\/v1\/chat\/completions$/);
  });

  it('未配置密钥时返回可恢复的 503，而不是假装成功', async () => {
    const saved = process.env.MIMO_API_KEY;
    delete process.env.MIMO_API_KEY;
    try {
      const res = await request('/api/voice/transcribe', {
        method: 'POST',
        body: JSON.stringify({ audio: 'A'.repeat(4000), format: 'wav' }),
      });
      assert.equal(res.status, 503);
      const body = await json<{ recoverable: boolean; message: string }>(res);
      assert.equal(body.recoverable, true);
      assert.match(body.message, /手动录入/);
      assert.equal(calls.length, 0, '未配置时不应发起上游请求');
    } finally {
      process.env.MIMO_API_KEY = saved;
    }
  });

  it('上游失败时返回可恢复提示，且不落库任何内容', async () => {
    responder = () => new Response('boom', { status: 500 });
    const res = await request('/api/voice/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audio: 'A'.repeat(4000), format: 'wav' }),
    });
    assert.equal(res.status, 502);
    assert.equal((await json<{ recoverable: boolean }>(res)).recoverable, true);

    const events = await db.execute(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal((events as unknown as { rows: { n: number }[] }).rows[0]!.n, 0, '失败不得产生半成品');
  });

  it('仅支持 wav/mp3，其他格式被拒绝', async () => {
    const res = await request('/api/voice/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audio: 'A'.repeat(4000), format: 'webm' }),
    });
    assert.equal(res.status, 400);
  });

  it('音频过短被拒绝', async () => {
    const res = await request('/api/voice/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audio: 'AAAA', format: 'wav' }),
    });
    assert.equal(res.status, 400);
  });

  it('音频过大被拒绝（413）', async () => {
    const res = await request('/api/voice/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audio: 'A'.repeat(24 * 1024 * 1024), format: 'wav' }),
    });
    assert.equal(res.status, 413);
  });
});

describe('事项解析接口', () => {
  it('成功时返回草稿且明确标注未落库', async () => {
    responder = () =>
      anthropicStyle({
        kind: 'event',
        title: '课题组会议',
        start_at: '2026-10-14T15:00:00+08:00',
        location: '科研楼',
        reminder_enabled: true,
        reminder_offsets: [60, 10],
        ambiguities: [],
      });

    const res = await request('/api/voice/parse', {
      method: 'POST',
      body: JSON.stringify({ text: '下周三下午三点在科研楼参加课题组会议，提前一个小时和十分钟微信提醒' }),
    });
    assert.equal(res.status, 200);

    const body = await json<{ draft: { title: string; reminder_offsets: number[]; kind: string }; persisted: boolean }>(res);
    assert.equal(body.draft.title, '课题组会议');
    assert.deepEqual(body.draft.reminder_offsets, [60, 10]);
    assert.equal(body.persisted, false, '确认之前绝不落库');

    const events = await db.execute(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal((events as unknown as { rows: { n: number }[] }).rows[0]!.n, 0, '解析不得写入正式事项');
    const jobs = await db.execute(sql`SELECT count(*)::int AS n FROM notification_jobs`);
    assert.equal((jobs as unknown as { rows: { n: number }[] }).rows[0]!.n, 0, '解析不得生成通知任务');
  });

  it('含糊时间不擅自补全：start_at 为空且给出含糊提示', async () => {
    responder = () =>
      anthropicStyle({
        kind: 'event',
        title: '找时间碰一下',
        start_at: null,
        reminder_enabled: false,
        reminder_offsets: [],
        ambiguities: ['未说明具体日期与时刻，请补充'],
      });

    const res = await request('/api/voice/parse', {
      method: 'POST',
      body: JSON.stringify({ text: '下周找时间碰一下' }),
    });
    const body = await json<{ draft: { start_at: string | null; ambiguities: string[] } }>(res);
    assert.equal(body.draft.start_at, null, '含糊时间必须留空而不是编造');
    assert.ok(body.draft.ambiguities.length > 0);
  });

  it('上游返回非 JSON 时给出可恢复错误', async () => {
    responder = () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: '抱歉，我不太确定' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const res = await request('/api/voice/parse', {
      method: 'POST',
      body: JSON.stringify({ text: '随便说点什么' }),
    });
    assert.equal(res.status, 502);
    assert.equal((await json<{ recoverable: boolean }>(res)).recoverable, true);
  });

  it('空文字被拒绝', async () => {
    const res = await request('/api/voice/parse', {
      method: 'POST',
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(res.status, 400);
  });

  it('状态接口只报告配置与否，不回显密钥', async () => {
    const res = await request('/api/voice/status');
    assert.equal(res.status, 200);
    const body = await json<{ asr: { configured: boolean; model: string } }>(res);
    assert.equal(body.asr.configured, true);
    assert.doesNotMatch(JSON.stringify(body), /test-mimo-key/, '密钥绝不能出现在响应里');
  });

  it('未登录不得访问语音接口', async () => {
    const saved = cookie;
    cookie = '';
    try {
      // 方法与路由必须匹配：GET /status，POST 其余
      const unauthStatus = await request('/api/voice/status');
      assert.equal(unauthStatus.status, 401, '/api/voice/status 应要求登录');

      for (const path of ['/api/voice/parse', '/api/voice/transcribe']) {
        const res = await request(path, { method: 'POST', body: '{}' });
        assert.equal(res.status, 401, `${path} 应要求登录`);
      }
    } finally {
      cookie = saved;
    }
  });
});
