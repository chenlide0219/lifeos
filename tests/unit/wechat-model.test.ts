/**
 * 模型集成层回归（PRD 4.3、5、16.1）。
 *
 * 全部离线：Jev 用注入的 fetch 桩，DeepSeek 用环境变量关闭或桩化。
 * 覆盖的是**契约与安全属性**，不是走一遍代码：
 *   - 发给 Jev 的 criteria 形状正确（写错会 422）；
 *   - 相对日期用冻结的解析基准，不由"当前时间"重新解释；
 *   - providedFields 只记录用户真正提供过的字段（16.1-5 的前提）；
 *   - 模型任何失败都返回失败，不猜草稿。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  INTENT_CRITERIA,
  classifyIntent,
  draftSummary,
  intentQuestion,
  modelCallsEnabled,
  toDraft,
} from '../../src/server/lib/wechat-model';
import { emptyDraft, type Draft } from '../../src/server/lib/wechat-draft';
import type { AiDraft } from '../../src/shared/types';

const SAVED = { ...process.env };

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const NOW = new Date('2026-10-12T04:00:00Z');

function jevChoice(choice: string, confidence = 0.9): Response {
  return new Response(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: { intent: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } },
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  setEnv({
    WECHAT_MODEL_CALLS: '1',
    JEV_OFFICIAL_API_KEY: 'test-official-key',
    JEV_API_KEY: undefined,
    JEV_BASE_URL: undefined,
    JEV_MODEL: undefined,
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
});

describe('意图问题定义（PRD 4.2、4.3）', () => {
  it('六个语义类别都在 criteria 里', () => {
    const question = intentQuestion();
    assert.equal(question.type, 'choice');
    if (question.type !== 'choice') return;
    const keys = Object.keys(question.criteria).sort();
    assert.deepEqual(keys, ['create', 'out_of_scope', 'patch_draft', 'query', 'unclear', 'unsupported_operation']);
    assert.deepEqual(keys, Object.keys(INTENT_CRITERIA).sort());
  });

  it('criteria 是映射且与 type 并列（写错结构会 422）', () => {
    const question = intentQuestion() as unknown as Record<string, unknown>;
    assert.equal(question.type, 'choice');
    assert.equal(typeof question.criteria, 'object');
    assert.equal(Array.isArray(question.criteria), false, 'Choice 的 criteria 必须是映射而不是数组');
    assert.equal(question.choice, undefined, 'criteria 不能嵌套在 choice 对象里');
  });
});

describe('classifyIntent', () => {
  it('返回受控意图并带上实际使用的路径', async () => {
    const fetchImpl = (async () => jevChoice('create', 0.93)) as unknown as typeof fetch;
    const result = await classifyIntent('明天开会', {
      hasActiveDraft: false,
      now: NOW,
      fetchImpl,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.intent, 'create');
      assert.equal(result.route, 'official');
    }
  });

  it('返回未定义的类别视为 bad_output，不当作有效意图', async () => {
    const fetchImpl = (async () => jevChoice('do_something_else')) as unknown as typeof fetch;
    const result = await classifyIntent('嗯', { hasActiveDraft: false, now: NOW, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'bad_output');
  });

  it('上游失败时返回失败，不猜测意图', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const result = await classifyIntent('明天开会', { hasActiveDraft: false, now: NOW, fetchImpl });
    assert.equal(result.ok, false);
  });

  it('关闭模型调用时直接返回 disabled', async () => {
    setEnv({ WECHAT_MODEL_CALLS: '0' });
    assert.equal(modelCallsEnabled(), false);
    const result = await classifyIntent('明天开会', { hasActiveDraft: false, now: NOW });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'disabled');
  });

  it('有草稿时把草稿摘要发给模型（不含完整历史）', async () => {
    let sentBody = '';
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sentBody = String(init?.body ?? '');
      return jevChoice('patch_draft');
    }) as unknown as typeof fetch;

    const draft: Draft = { ...emptyDraft('event'), title: '组会', startAt: NOW.toISOString() };
    await classifyIntent('地点改到新楼', { hasActiveDraft: true, draftSummary: draftSummary(draft), now: NOW, fetchImpl });

    assert.match(sentBody, /组会/, '应包含草稿摘要');
    assert.match(sentBody, /当前有一条尚未保存的草稿/);
    assert.doesNotMatch(sentBody, /Bearar|apiKey|apikey-test/, '请求体不得包含密钥');
  });
});

describe('toDraft 字段映射（PRD 5、16.1-5）', () => {
  function aiDraft(overrides: Partial<AiDraft> = {}): AiDraft {
    return {
      kind: 'event',
      title: '组会',
      start_at: '2026-10-14T15:00:00+08:00',
      end_at: null,
      due_date: null,
      due_time: null,
      location: '科研楼',
      note: null,
      reminder_enabled: false,
      reminder_offsets: [],
      ambiguities: [],
      ...overrides,
    };
  }

  it('事件字段映射为绝对时刻（UTC 存储）', () => {
    const { draft } = toDraft(aiDraft());
    assert.equal(draft.kind, 'event');
    assert.equal(draft.title, '组会');
    // 北京时间 15:00 = UTC 07:00
    assert.equal(draft.startAt, '2026-10-14T07:00:00.000Z');
    assert.equal(draft.location, '科研楼');
  });

  it('providedFields 只记录真正出现过的字段', () => {
    const { draft } = toDraft(aiDraft({ location: null, note: null, end_at: null }));
    assert.ok(draft.providedFields.includes('title'));
    assert.ok(draft.providedFields.includes('startAt'));
    assert.ok(!draft.providedFields.includes('location'));
    assert.ok(!draft.providedFields.includes('note'));
    assert.ok(!draft.providedFields.includes('endAt'));
  });

  it('待办映射日期与时刻，不写入事件字段', () => {
    const { draft } = toDraft(
      aiDraft({ kind: 'task', start_at: null, due_date: '2026-10-20', due_time: '09:00' }),
    );
    assert.equal(draft.kind, 'task');
    assert.equal(draft.dueDate, '2026-10-20');
    assert.equal(draft.dueTime, '09:00');
    assert.equal(draft.startAt, null);
  });

  it('未提提醒时保持关闭，不套默认值', () => {
    const { draft } = toDraft(aiDraft());
    assert.equal(draft.reminderEnabled, false);
    assert.deepEqual(draft.reminderOffsets, []);
    assert.ok(!draft.providedFields.includes('reminder'));
  });

  it('明确提到提醒时记录提前量', () => {
    const { draft } = toDraft(aiDraft({ reminder_enabled: true, reminder_offsets: [60, 10] }));
    assert.equal(draft.reminderEnabled, true);
    assert.deepEqual(draft.reminderOffsets, [60, 10]);
    assert.ok(draft.providedFields.includes('reminder'));
  });

  it('非法 ISO 时间被丢弃而不是写入', () => {
    const { draft } = toDraft(aiDraft({ start_at: '不是时间' }));
    assert.equal(draft.startAt, null);
    assert.ok(!draft.providedFields.includes('startAt'));
  });

  it('含糊说明被保留，供追问使用', () => {
    const { ambiguities } = toDraft(aiDraft({ ambiguities: ['缺少开始时间'] }));
    assert.deepEqual(ambiguities, ['缺少开始时间']);
  });
});

describe('draftSummary 只暴露必要信息（PRD 4.3）', () => {
  it('包含类型、标题、时间与提醒状态', () => {
    const draft: Draft = {
      ...emptyDraft('event'),
      title: '组会',
      startAt: '2026-10-14T07:00:00.000Z',
      location: '科研楼',
    };
    const summary = draftSummary(draft);
    assert.match(summary, /类型=日程/);
    assert.match(summary, /标题=组会/);
    assert.match(summary, /地点=科研楼/);
  });

  it('用户已关闭提醒时明确标注，便于模型区分', () => {
    const draft: Draft = { ...emptyDraft('event'), title: 'x', reminderDeclined: true };
    assert.match(draftSummary(draft), /提醒=用户已关闭/);
  });

  it('待办显示日期与时刻字段', () => {
    const draft: Draft = { ...emptyDraft('task'), title: '交材料', dueDate: '2026-10-20' };
    const summary = draftSummary(draft);
    assert.match(summary, /截止日=2026-10-20/);
    assert.match(summary, /截止时刻=（未填）/);
  });
});
