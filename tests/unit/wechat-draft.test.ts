/**
 * 草稿模型与状态机回归（PRD 5、6、16.1）。
 *
 * 这里的断言直接对应你逐条拍板的决定，任何一条被改坏都应该让测试失败：
 *   1. 触发点 `<=` now 的档位丢弃；两档都不可排 → 本次不安排提醒；
 *   2. 缺日期/时刻允许保存但不排提醒，且与"用户主动关闭"可区分；
 *   4. 30 分钟自最后一次有效修改起算并续期；
 *   5. 转待办移除地点并标注；只保留用户提供过的字段。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_OFFSETS,
  applyPatch,
  draftDueInstant,
  effectiveOffsets,
  emptyDraft,
  isExpired,
  missingFields,
  planFingerprint,
  planReminders,
  reminderBlockedByMissingFields,
  reminderSummary,
  renewedExpiry,
  validateBeforeCommit,
  type Draft,
} from '../../src/server/lib/wechat-draft';
import { zonedToInstant } from '../../src/server/lib/time';

const NOW = new Date('2026-10-12T04:00:00Z'); // 北京时间 12:00

function eventDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    ...emptyDraft('event'),
    title: '组会',
    startAt: zonedToInstant(2026, 10, 14, 15, 0).toISOString(),
    location: '科研楼',
    ...overrides,
  };
}

describe('缺字段判定', () => {
  it('事件缺标题或开始时间都算缺字段', () => {
    assert.deepEqual(missingFields(emptyDraft('event')), ['title', 'start_at']);
    assert.deepEqual(missingFields(eventDraft()), []);
  });

  it('待办缺日期/时刻不算缺字段：允许保存（16.1-2）', () => {
    const draft: Draft = { ...emptyDraft('task'), title: '交材料' };
    assert.deepEqual(missingFields(draft), [], '待办只要求标题');
    assert.equal(reminderBlockedByMissingFields(draft), true, '但无法安排提醒');
  });
});

describe('逐档提醒判定（16.1-1）', () => {
  it('距开始 45 分钟：只排提前 10 分钟，60 分钟档被丢弃', () => {
    const start = new Date(NOW.getTime() + 45 * 60_000);
    const draft = eventDraft({ startAt: start.toISOString() });
    const { plan, skippedPast, total } = planReminders(draft, NOW);

    assert.equal(total, 2);
    assert.equal(skippedPast, 1, '提前 60 分钟的触发点已过去');
    assert.deepEqual(
      plan.map((p) => p.offsetMinutes),
      [10],
    );
    assert.equal(plan[0]!.fireAt.getTime(), start.getTime() - 10 * 60_000);
  });

  it('距开始 30 / 20 分钟：同样只排提前 10 分钟（与 PRD 验收第 15 项一致）', () => {
    for (const minutes of [30, 20]) {
      const start = new Date(NOW.getTime() + minutes * 60_000);
      const { plan } = planReminders(eventDraft({ startAt: start.toISOString() }), NOW);
      assert.deepEqual(plan.map((p) => p.offsetMinutes), [10], `${minutes} 分钟时应只排 10 分钟档`);
    }
  });

  it('距开始 5 分钟：两档都不可排，计划为空', () => {
    const start = new Date(NOW.getTime() + 5 * 60_000);
    const { plan, skippedPast, total } = planReminders(eventDraft({ startAt: start.toISOString() }), NOW);
    assert.equal(plan.length, 0);
    assert.equal(skippedPast, 2);
    assert.equal(total, 2);
  });

  it('触发点恰好等于当前时间：同一瞬间不排（按 > 判定）', () => {
    // 开始时间 = now + 10 分钟 → 提前 10 分钟的触发点恰好等于 now
    const exact = new Date(NOW.getTime() + 10 * 60_000);
    const { plan } = planReminders(eventDraft({ startAt: exact.toISOString() }), NOW);
    assert.equal(plan.length, 0, '恰好相等不排');

    // 早 1 毫秒（now 尚未到达触发点）仍排
    const justAfter = new Date(NOW.getTime() + 10 * 60_000 + 1);
    const { plan: plan2 } = planReminders(eventDraft({ startAt: justAfter.toISOString() }), NOW);
    assert.deepEqual(
      plan2.map((p) => p.offsetMinutes),
      [10],
      '早 1 毫秒仍应安排',
    );
  });

  it('距开始 2 小时：两档都排得上', () => {
    const start = new Date(NOW.getTime() + 120 * 60_000);
    const { plan, skippedPast } = planReminders(eventDraft({ startAt: start.toISOString() }), NOW);
    assert.equal(skippedPast, 0);
    assert.deepEqual(plan.map((p) => p.offsetMinutes), [60, 10]);
  });

  it('默认提前量就是 [60,10]', () => {
    assert.deepEqual(DEFAULT_OFFSETS, [60, 10]);
    assert.deepEqual(effectiveOffsets(eventDraft()), [60, 10]);
  });

  it('用户主动关闭提醒时不排任何档位', () => {
    const draft = eventDraft({ reminderDeclined: true });
    assert.deepEqual(effectiveOffsets(draft), []);
    assert.deepEqual(planReminders(draft, NOW).plan, []);
  });

  it('用户指定提前量时按其输入', () => {
    const start = new Date(NOW.getTime() + 180 * 60_000);
    const draft = eventDraft({ startAt: start.toISOString(), reminderOffsets: [120, 30] });
    assert.deepEqual(effectiveOffsets(draft), [120, 30]);
    assert.deepEqual(
      planReminders(draft, NOW).plan.map((p) => p.offsetMinutes),
      [120, 30],
    );
  });

  it('待办没有具体时刻时不排提醒（全天项目）', () => {
    const draft: Draft = { ...emptyDraft('task'), title: '交材料', dueDate: '2026-10-20' };
    assert.equal(draftDueInstant(draft), null);
    assert.deepEqual(planReminders(draft, NOW).plan, []);
  });
});

describe('提醒文案必须可区分三种情形', () => {
  it('有可排提醒时列出实际触发时刻', () => {
    const start = new Date(NOW.getTime() + 120 * 60_000);
    const { lines, blockedReason } = reminderSummary(eventDraft({ startAt: start.toISOString() }), NOW);
    assert.equal(blockedReason, null);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /提前 1 小时（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）/);
  });

  it('时间不足时不安排，并写明原因', () => {
    const start = new Date(NOW.getTime() + 5 * 60_000);
    const { lines, blockedReason } = reminderSummary(eventDraft({ startAt: start.toISOString() }), NOW);
    assert.equal(lines.length, 0);
    assert.match(blockedReason!, /本次不安排提醒/);
  });

  it('缺字段与主动关闭的原因不同（16.1-2 要求区分）', () => {
    const noTime = reminderSummary({ ...emptyDraft('task'), title: 'x' }, NOW);
    assert.match(noTime.blockedReason!, /缺少日期或时刻/);

    const declined = reminderSummary(eventDraft({ reminderDeclined: true }), NOW);
    assert.match(declined.blockedReason!, /已关闭提醒/);
    assert.notEqual(noTime.blockedReason, declined.blockedReason);
  });
});

describe('字段补丁（PRD 3.3）', () => {
  it('只改指定字段，其余保留', () => {
    const before = eventDraft();
    const { draft, changed } = applyPatch(before, { title: '新标题' }, NOW);
    assert.equal(draft.title, '新标题');
    assert.equal(draft.location, before.location, '未提供的字段必须保留');
    assert.equal(draft.startAt, before.startAt);
    assert.equal(changed, true);
  });

  it('记录用户明确提供过的字段', () => {
    const { draft } = applyPatch(emptyDraft('event'), { title: '组会', location: '科研楼' }, NOW);
    assert.ok(draft.providedFields.includes('title'));
    assert.ok(draft.providedFields.includes('location'));
    assert.ok(!draft.providedFields.includes('note'), '未提到的字段不应被标记为已提供');
  });

  it('"不要提醒"记为主动关闭，不被默认提醒覆盖', () => {
    const { draft } = applyPatch(eventDraft(), { reminderDeclined: true }, NOW);
    assert.equal(draft.reminderDeclined, true);
    assert.deepEqual(effectiveOffsets(draft), []);
  });

  it('补丁未提供提醒字段时不覆盖已有规则', () => {
    const withRule = eventDraft({ reminderEnabled: true, reminderOffsets: [30] });
    const { draft } = applyPatch(withRule, { title: '只改标题' }, NOW);
    assert.deepEqual(draft.reminderOffsets, [30]);
    assert.equal(draft.reminderEnabled, true);
  });
});

describe('类型转换（16.1-5）', () => {
  it('事件转待办：移除地点并标注，时间搬运为截止时间', () => {
    const before = eventDraft();
    const { draft, dropped } = applyPatch(before, { convertTo: 'task' }, NOW);

    assert.equal(draft.kind, 'task');
    assert.equal(draft.location, null, '待办不应保留地点');
    assert.ok(dropped.some((d) => /已移除地点/.test(d)));
    assert.equal(draft.dueDate, '2026-10-14');
    assert.equal(draft.dueTime, '15:00');
    assert.equal(draft.startAt, null);
  });

  it('转换不凭空生成用户未提供的字段', () => {
    const bare: Draft = { ...emptyDraft('event'), title: '开会' };
    const { draft } = applyPatch(bare, { convertTo: 'task' }, NOW);
    assert.equal(draft.location, null);
    assert.equal(draft.note, null);
    assert.equal(draft.dueDate, null, '没有时间就不应造出日期');
  });

  it('待办转事件：截止时刻作为开始时间', () => {
    const task: Draft = { ...emptyDraft('task'), title: '交材料', dueDate: '2026-10-20', dueTime: '09:00' };
    const { draft, dropped } = applyPatch(task, { convertTo: 'event' }, NOW);
    assert.equal(draft.kind, 'event');
    assert.equal(draft.dueDate, null);
    assert.ok(draft.startAt);
    assert.ok(dropped.some((d) => /开始时间/.test(d)));
  });

  it('待办收到地点补丁时忽略并说明，而不是写入', () => {
    const task: Draft = { ...emptyDraft('task'), title: '交材料' };
    const { draft, dropped } = applyPatch(task, { location: '科研楼' }, NOW);
    assert.equal(draft.location, null);
    assert.ok(dropped.some((d) => /已忽略地点/.test(d)));
  });
});

describe('期限与提交前校验（16.1-4、PRD 5）', () => {
  it('续期自最后一次修改起算 30 分钟', () => {
    const expires = renewedExpiry(NOW);
    assert.equal(expires.getTime() - NOW.getTime(), 30 * 60_000);
    assert.equal(isExpired(expires, NOW), false);
    assert.equal(isExpired(expires, new Date(expires.getTime() + 1)), true);
  });

  it('计划指纹随实际计划变化（用于判定是否需要重新确认）', () => {
    const later = eventDraft({ startAt: new Date(NOW.getTime() + 120 * 60_000).toISOString() });
    const sooner = eventDraft({ startAt: new Date(NOW.getTime() + 45 * 60_000).toISOString() });
    assert.notEqual(planFingerprint(later, NOW), planFingerprint(sooner, NOW));
  });

  it('缺少必填信息不允许提交', () => {
    const result = validateBeforeCommit(emptyDraft('event'), NOW);
    assert.equal(result.ok, false);
  });

  it('开始时间已过去不允许提交', () => {
    const past = eventDraft({ startAt: new Date(NOW.getTime() - 60_000).toISOString() });
    const result = validateBeforeCommit(past, NOW);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /已经过去/);
  });

  it('结束早于开始不允许提交', () => {
    const start = zonedToInstant(2026, 10, 14, 15, 0);
    const draft = eventDraft({
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() - 3600_000).toISOString(),
    });
    const result = validateBeforeCommit(draft, NOW);
    assert.equal(result.ok, false);
  });

  it('合法草稿允许提交', () => {
    assert.equal(validateBeforeCommit(eventDraft(), NOW).ok, true);
  });

  it('待办只要有标题就允许保存（无日期不排提醒，16.1-2）', () => {
    const draft: Draft = { ...emptyDraft('task'), title: '交材料' };
    assert.equal(validateBeforeCommit(draft, NOW).ok, true);
  });
});
