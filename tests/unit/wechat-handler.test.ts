/**
 * 业务路由回归（PRD 3、4.1、6、10）。
 *
 * 全部用注入的桩替换模型调用，因此**完全离线、确定性**运行。
 * 覆盖的是路由的关键安全属性，而不是走一遍分支：
 *   - 确定性命令不调用模型；
 *   - 只有完整短码能提交，裸确认与错误短码都不提交；
 *   - 有草稿时新创建请求不覆盖草稿，但查询照常可用；
 *   - 已保存事项操作用户请求被拒绝，且**不顺带取消草稿**；
 *   - 模型失败一律不产生写入动作。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { routeMessage, toDraftPatch, newShortCode, type HandlerDeps, type HandlerInput } from '../../src/server/lib/wechat-handler';
import { parseCommand } from '../../src/server/lib/wechat-command';
import { emptyDraft, type Draft } from '../../src/server/lib/wechat-draft';
import { zonedToInstant } from '../../src/server/lib/time';

const NOW = new Date('2026-10-12T04:00:00Z'); // 北京时间 12:00

type CallLog = { classify: number; extractNew: number; extractPatch: number; extractQuery: number };

function stubDeps(overrides: Partial<HandlerDeps> = {}): { deps: HandlerDeps; calls: CallLog } {
  const calls: CallLog = { classify: 0, extractNew: 0, extractPatch: 0, extractQuery: 0 };
  const deps: HandlerDeps = {
    classifyIntent: async () => {
      calls.classify += 1;
      return { ok: true, intent: 'create', confidence: 0.9 };
    },
    extractNewDraft: async () => {
      calls.extractNew += 1;
      return { ok: true, draft: futureEvent(), ambiguities: [] };
    },
    extractDraftPatch: async () => {
      calls.extractPatch += 1;
      return { ok: true, patch: { location: '新地点' }, ambiguous: null };
    },
    extractQuery: async () => {
      calls.extractQuery += 1;
      return { ok: true, spec: { preset: 'today', date: null, filter: 'all' } };
    },
    ...overrides,
  };
  return { deps, calls };
}

function futureEvent(overrides: Partial<Draft> = {}): Draft {
  return {
    ...emptyDraft('event'),
    title: '组会',
    startAt: zonedToInstant(2026, 10, 14, 15, 0).toISOString(),
    location: '科研楼',
    providedFields: ['title', 'startAt', 'location'],
    ...overrides,
  };
}

function activeView(draft: Draft = futureEvent(), overrides: Partial<{ shortCode: string; version: number; previewUnknown: boolean }> = {}) {
  return {
    id: 'op-1',
    version: overrides.version ?? 1,
    shortCode: overrides.shortCode ?? 'A7K2',
    draft,
    status: 'pending_confirm',
    previewUnknown: overrides.previewUnknown ?? false,
  };
}

function makeInput(text: string, active: HandlerInput['active'], deps: HandlerDeps): HandlerInput {
  return {
    command: parseCommand(text),
    rawText: text,
    parseBasisAt: NOW,
    now: NOW,
    active,
    deps,
  };
}

describe('确定性命令不调用模型（PRD 4.1 第 2、3 条）', () => {
  const cases = ['/help', '/pending', '/recent', '取消', '/cancel'];

  for (const text of cases) {
    it(`「${text}」不触碰任何模型`, async () => {
      const { deps, calls } = stubDeps();
      await routeMessage(makeInput(text, activeView(), deps));
      assert.deepEqual(calls, { classify: 0, extractNew: 0, extractPatch: 0, extractQuery: 0 });
    });
  }

  it('/help 返回用法说明', async () => {
    const { deps } = stubDeps();
    const action = await routeMessage(makeInput('/help', null, deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /\/add/);
  });

  it('/pending 无草稿时明确说明', async () => {
    const { deps } = stubDeps();
    const action = await routeMessage(makeInput('/pending', null, deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /没有未保存的草稿/);
  });

  it('/pending 有草稿时返回预览且不改动草稿', async () => {
    const { deps, calls } = stubDeps();
    const action = await routeMessage(makeInput('/pending', activeView(), deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') {
      assert.match(action.body, /待确认 A7K2/);
      assert.match(action.body, /组会/);
    }
    assert.deepEqual(calls, { classify: 0, extractNew: 0, extractPatch: 0, extractQuery: 0 });
  });

  it('不支持的命令给出边界提示', async () => {
    const { deps, calls } = stubDeps();
    const action = await routeMessage(makeInput('/delete 明天会议', null, deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /不支持的命令/);
    assert.equal(calls.classify, 0);
  });

  it('裸 /add 提示补充内容，不交给模型猜', async () => {
    const { deps, calls } = stubDeps();
    const action = await routeMessage(makeInput('/add', null, deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /请在 \/add 后面写上内容/);
    assert.equal(calls.extractNew, 0);
  });
});

describe('确认必须使用完整且匹配的短码（PRD 3.3、12.1 第 3 项）', () => {
  it('短码匹配时进入提交', async () => {
    const { deps } = stubDeps();
    const action = await routeMessage(makeInput('确认 A7K2', activeView(), deps));
    assert.equal(action.kind, 'commit');
    if (action.kind === 'commit') {
      assert.equal(action.operationId, 'op-1');
      assert.equal(action.expectedVersion, 1);
    }
  });

  it('短码不匹配时不提交，并告知当前有效短码', async () => {
    const { deps } = stubDeps();
    const action = await routeMessage(makeInput('确认 XXXX', activeView(futureEvent(), { shortCode: 'B3C4' }), deps));
    assert.notEqual(action.kind, 'commit');
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') {
      assert.match(action.body, /B3C4/, '必须报出当前有效短码');
      assert.doesNotMatch(action.body, /XXXX/, '不得把用户输入的无效短码当作有效值回显');
    }
  });

  it('裸「确认」不提交（不进入 commit）', async () => {
    const { deps } = stubDeps();
    const action = await routeMessage(makeInput('确认', activeView(), deps));
    assert.notEqual(action.kind, 'commit');
  });

  it('裸数字不提交', async () => {
    for (const text of ['1', '2', '3']) {
      const { deps } = stubDeps();
      const action = await routeMessage(makeInput(text, activeView(), deps));
      assert.notEqual(action.kind, 'commit', `「${text}」不得被当作确认`);
    }
  });

  it('无草稿时确认给出明确提示', async () => {
    const { deps } = stubDeps();
    const action = await routeMessage(makeInput('确认 A7K2', null, deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /没有待确认的草稿/);
  });

  it('预览结果未知时不允许用短码确认（PRD 3.3）', async () => {
    const { deps } = stubDeps();
    const action = await routeMessage(makeInput('确认 A7K2', activeView(futureEvent(), { previewUnknown: true }), deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /\/pending/);
  });

  it('草稿校验不通过时不提交（开始时间已过去）', async () => {
    const { deps } = stubDeps();
    const past = futureEvent({ startAt: new Date(NOW.getTime() - 3600_000).toISOString() });
    const action = await routeMessage(makeInput('确认 A7K2', activeView(past), deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /已经过去/);
  });
});

describe('取消只作用于未保存草稿（PRD 3.6）', () => {
  it('「取消」取消当前草稿', async () => {
    const { deps } = stubDeps();
    const action = await routeMessage(makeInput('取消', activeView(), deps));
    assert.equal(action.kind, 'cancel');
  });

  it('「取消明天会议」不是取消草稿，而是不支持的操作', async () => {
    const { deps, calls } = stubDeps({
      classifyIntent: async () => {
        calls.classify += 1;
        return { ok: true, intent: 'unsupported_operation', confidence: 0.9 };
      },
    });
    const action = await routeMessage(makeInput('取消明天会议', activeView(), deps));
    assert.notEqual(action.kind, 'cancel', '不得顺带取消当前草稿');
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /工作站/);
  });
});

describe('草稿与查询共存（PRD 3.5）', () => {
  it('有草稿时查询照常可用，并附草稿提示', async () => {
    const { deps } = stubDeps();
    const action = await routeMessage(makeInput('/today', activeView(), deps));
    assert.equal(action.kind, 'query');
    if (action.kind === 'query') assert.match(action.draftNotice ?? '', /组会/);
  });

  it('有草稿时新创建请求不覆盖草稿', async () => {
    const { deps } = stubDeps();
    const action = await routeMessage(makeInput('/add 明天买牛奶', activeView(), deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /请先确认或取消/);
  });

  it('自然语言新创建请求在有草稿时同样被拒绝', async () => {
    const { deps } = stubDeps({
      classifyIntent: async () => ({ ok: true, intent: 'create', confidence: 0.9 }),
    });
    const action = await routeMessage(makeInput('明天买牛奶', activeView(), deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /请先确认或取消/);
  });
});

describe('自然语言路由（PRD 4.1 第 4、5 条）', () => {
  it('意图为 create 且无草稿时建立草稿并给出预览', async () => {
    const { deps, calls } = stubDeps();
    const action = await routeMessage(makeInput('明天下午三点科研楼开组会', null, deps));
    assert.equal(action.kind, 'create_draft');
    if (action.kind === 'create_draft') {
      assert.equal(action.missing.length, 0);
      assert.match(action.preview ?? '', /待确认/);
      assert.match(action.preview ?? '', /科研楼/);
    }
    assert.equal(calls.classify, 1);
    assert.equal(calls.extractNew, 1);
  });

  it('缺字段时保存草稿并追问，而不是丢弃输入', async () => {
    const incomplete: Draft = { ...emptyDraft('event'), title: '开会' };
    const { deps } = stubDeps({
      classifyIntent: async () => ({ ok: true, intent: 'create', confidence: 0.9 }),
      extractNewDraft: async () => ({ ok: true, draft: incomplete, ambiguities: ['没有识别到明确的开始时间'] }),
    });
    const action = await routeMessage(makeInput('明天开会', null, deps));
    assert.equal(action.kind, 'create_draft');
    if (action.kind === 'create_draft') {
      assert.deepEqual(action.missing, ['start_at']);
      assert.match(action.question ?? '', /请补充开始时间/);
      assert.equal(action.preview, null, '缺字段时不得给出可保存的短码预览');
    }
  });

  it('意图为 query 时走查询，不建立草稿', async () => {
    const { deps, calls } = stubDeps({
      classifyIntent: async () => ({ ok: true, intent: 'query', confidence: 0.9 }),
    });
    const action = await routeMessage(makeInput('今天有什么安排', null, deps));
    assert.equal(action.kind, 'query');
    assert.equal(calls.extractNew, 0);
    assert.equal(calls.extractQuery, 1);
  });

  it('意图为 patch_draft 且无草稿时按新建处理，不让用户白说一句', async () => {
    const { deps, calls } = stubDeps({
      classifyIntent: async () => ({ ok: true, intent: 'patch_draft', confidence: 0.9 }),
    });
    const action = await routeMessage(makeInput('下午三点', null, deps));
    assert.equal(action.kind, 'create_draft');
    assert.equal(calls.extractNew, 1);
  });

  it('意图为 patch_draft 且有草稿时更新草稿并给出新预览', async () => {
    const { deps, calls } = stubDeps({
      classifyIntent: async () => ({ ok: true, intent: 'patch_draft', confidence: 0.9 }),
    });
    const action = await routeMessage(makeInput('地点改到新楼', activeView(), deps));
    assert.equal(action.kind, 'update_draft');
    if (action.kind === 'update_draft') {
      assert.match(action.preview, /待确认/);
      assert.match(action.preview, /新地点/);
    }
    assert.equal(calls.extractPatch, 1);
  });

  it('补丁含糊时只追问，不改动草稿', async () => {
    const { deps } = stubDeps({
      classifyIntent: async () => ({ ok: true, intent: 'patch_draft', confidence: 0.9 }),
      extractDraftPatch: async () => ({ ok: true, patch: {}, ambiguous: '不知道要改哪一天' }),
    });
    const action = await routeMessage(makeInput('改一下', activeView(), deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /不知道要改哪一天/);
  });

  it('已保存事项操作被拒绝并引导到工作站', async () => {
    const { deps } = stubDeps({
      classifyIntent: async () => ({ ok: true, intent: 'unsupported_operation', confidence: 0.9 }),
    });
    const action = await routeMessage(makeInput('把明天的会删掉', null, deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /工作站/);
  });

  it('闲聊给出范围说明，不进入开放式生成', async () => {
    const { deps } = stubDeps({
      classifyIntent: async () => ({ ok: true, intent: 'out_of_scope', confidence: 0.9 }),
    });
    const action = await routeMessage(makeInput('帮我写首诗', null, deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /只负责日程与待办/);
  });
});

describe('模型故障绝不产生写入（PRD 4.3、10）', () => {
  it('意图分类失败时只回复错误，不建草稿', async () => {
    const { deps, calls } = stubDeps({
      classifyIntent: async () => ({ ok: false, error: 'HTTP 500', kind: 'rejected' }),
    });
    const action = await routeMessage(makeInput('明天开会', null, deps));
    assert.equal(action.kind, 'reply');
    assert.equal(calls.extractNew, 0, '分类失败不得继续抽取');
  });

  it('字段抽取失败时不建草稿', async () => {
    const { deps } = stubDeps({
      extractNewDraft: async () => ({ ok: false, error: 'timeout', kind: 'timeout' }),
    });
    const action = await routeMessage(makeInput('/add 明天开会', null, deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /没能理解/);
  });

  it('查询条件抽取失败时提示可用命令，不猜测范围', async () => {
    const { deps } = stubDeps({
      classifyIntent: async () => ({ ok: true, intent: 'query', confidence: 0.9 }),
      extractQuery: async () => ({ ok: false, error: 'bad', kind: 'bad_output' }),
    });
    const action = await routeMessage(makeInput('看看安排', null, deps));
    assert.equal(action.kind, 'reply');
    if (action.kind === 'reply') assert.match(action.body, /\/today/);
  });
});

describe('补丁收窄与短码', () => {
  it('toDraftPatch 丢弃未知字段与非法值', () => {
    const patch = toDraftPatch({
      title: '新标题',
      start_at: 'not-a-date',
      location: '新楼',
      convert_to: 'task',
      reminder_offsets: [60, 'x', 10],
      evil: 'should be dropped',
    });
    assert.equal(patch.title, '新标题');
    assert.equal(patch.startAt, undefined, '非法日期必须被丢弃');
    assert.equal(patch.location, '新楼');
    assert.equal(patch.convertTo, 'task');
    assert.deepEqual(patch.reminderOffsets, [60, 10]);
    assert.equal((patch as Record<string, unknown>).evil, undefined);
  });

  it('toDraftPatch 承认"不要提醒"', () => {
    const patch = toDraftPatch({ reminder_declined: true });
    assert.equal(patch.reminderDeclined, true);
  });

  it('短码只使用不易混淆的字符', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = newShortCode();
      assert.equal(code.length, 4);
      assert.doesNotMatch(code, /[01OIL]/, `短码 ${code} 含易混字符`);
    }
  });
});
