/**
 * 回复长度控制与查询格式化回归（PRD 3.5、12.1 第 18 项、16.2）。
 *
 * 这些断言对应的是用户实际会碰到的问题：
 *   - "说好 8 条却只给了 5 条"必须被如实标注，不能谎报条数；
 *   - 600 是**全角字符**口径，中英混排不能算错；
 *   - 截断标注本身不能把内容顶掉。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QUERY_MAX_CHARS,
  QUERY_MAX_ITEMS,
  clampReply,
  formatPreview,
  formatQueryReply,
  fullWidthLength,
  truncateToWidth,
} from '../../src/server/lib/wechat-reply';

function items(n: number, titleLen = 4) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'event' as const,
    title: `${'会'.repeat(titleLen)}${i + 1}`,
    when: '10-14 15:00',
    detail: null,
  }));
}

describe('全角字符宽度', () => {
  it('CJK 记 1、ASCII 记 0.5', () => {
    assert.equal(fullWidthLength('中文'), 2);
    assert.equal(fullWidthLength('abcd'), 2);
    assert.equal(fullWidthLength('中a'), 1.5);
    assert.equal(fullWidthLength(''), 0);
  });

  it('全角标点按全角计', () => {
    assert.equal(fullWidthLength('，。'), 2);
  });
});

describe('truncateToWidth', () => {
  it('未超限时原样返回', () => {
    assert.equal(truncateToWidth('abcd', 10), 'abcd');
  });

  it('按全角宽度截断且不切坏字符', () => {
    // '中文中文中文' 宽 6，限 4 → 只能放下两个汉字
    const out = truncateToWidth('中文中文中文', 4);
    assert.equal(out, '中文中文');
    assert.ok(fullWidthLength(out) <= 4);
  });
});

describe('查询回复格式化', () => {
  const groups = (n: number, titleLen = 4) => ({
    groups: [{ label: '今天', items: items(n, titleLen) }],
  });

  it('无结果时给出空文案，不算截断', () => {
    const r = formatQueryReply({ title: '今天', groups: { groups: [] }, emptyText: '今天没有安排' });
    assert.equal(r.total, 0);
    assert.equal(r.shown, 0);
    assert.equal(r.truncatedByLength, false);
    assert.match(r.body, /今天没有安排/);
  });

  it('正好 8 条：全部显示且不加剩余提示', () => {
    const r = formatQueryReply({ title: '今天', groups: groups(8), emptyText: '无' });
    assert.equal(r.total, 8);
    assert.equal(r.shown, 8);
    assert.equal(r.cappedByCount, false);
    assert.doesNotMatch(r.body, /另有/);
  });

  it('9 条：只显示 8 条并标注剩余 1 条', () => {
    const r = formatQueryReply({ title: '今天', groups: groups(9), emptyText: '无' });
    assert.equal(r.total, 9);
    assert.equal(r.shown, 8);
    assert.equal(r.cappedByCount, true);
    assert.match(r.body, /另有 1 条未显示/);
    assert.doesNotMatch(r.body, /会9/, '第 9 条不应出现');
  });

  it('23 条：标注剩余 15 条', () => {
    const r = formatQueryReply({ title: '未来七天', groups: groups(23), emptyText: '无' });
    assert.equal(r.shown, 8);
    assert.match(r.body, /另有 15 条未显示/);
  });

  it('8 条但整体过长：按长度截断，并如实标注实际显示条数（不得声称 8 条）', () => {
    // 每条标题 100 个全角字符 → 8 条约 850 字，必然超过 600
    const r = formatQueryReply({ title: '未来七天', groups: groups(8, 100), emptyText: '无' });
    assert.equal(r.total, 8);
    assert.equal(r.truncatedByLength, true);
    assert.ok(r.shown < 8, `应少于 8 条，实际 ${r.shown}`);
    assert.match(r.body, new RegExp(`共 8 条，已显示 ${r.shown} 条`));
    assert.ok(fullWidthLength(r.body) <= QUERY_MAX_CHARS + 130, '标注预留后不应显著超限');
  });

  it('截断标注不会把已显示条目全部顶掉', () => {
    const r = formatQueryReply({ title: '未来七天', groups: groups(8, 100), emptyText: '无' });
    assert.ok(r.shown >= 1, '至少应显示 1 条');
  });

  it('多分组时同样遵守总条数上限', () => {
    const r = formatQueryReply({
      title: '今天',
      groups: {
        groups: [
          { label: '逾期', items: items(3) },
          { label: '今天到期', items: items(5) },
          { label: '无日期', items: items(4) },
        ],
      },
      emptyText: '无',
    });
    assert.equal(r.total, 12);
    assert.equal(r.shown, 8);
    assert.match(r.body, /另有 4 条未显示/);
  });

  it('默认上限就是已确认的 8 条 / 600 字', () => {
    assert.equal(QUERY_MAX_ITEMS, 8);
    assert.equal(QUERY_MAX_CHARS, 600);
  });
});

describe('草稿预览', () => {
  const base = {
    shortCode: 'A7K2',
    draftKind: 'event' as const,
    title: '组会',
    timeText: '2026-10-14 15:00（北京时间）',
    location: '科研楼',
    note: null,
    reminderLines: ['提前60分钟（2026-10-14 14:00）', '提前10分钟（2026-10-14 14:50）'],
    reminderBlockedReason: null,
  };

  it('包含绝对时间、时区、实际提醒与短码', () => {
    const body = formatPreview(base);
    assert.match(body, /待确认 A7K2/);
    assert.match(body, /2026-10-14 15:00（北京时间）/);
    assert.match(body, /提前60分钟/);
    assert.match(body, /确认 A7K2/);
    assert.match(body, /尚未保存/);
  });

  it('不安排提醒时必须写明原因，不得出现"已安排提醒"', () => {
    const body = formatPreview({
      ...base,
      reminderLines: [],
      reminderBlockedReason: '本次不安排提醒（距开始不足 10 分钟）',
    });
    assert.match(body, /本次不安排提醒/);
    assert.doesNotMatch(body, /提前10分钟/);
  });

  it('待办不显示地点行', () => {
    const body = formatPreview({ ...base, draftKind: 'task' });
    assert.doesNotMatch(body, /地点：/);
  });

  it('类型转换丢弃地点时明确标注', () => {
    const body = formatPreview({ ...base, draftKind: 'task', droppedFields: ['已移除地点（待办无地点）'] });
    assert.match(body, /已移除地点/);
  });
});

describe('clampReply 兜底', () => {
  it('短回复原样返回', () => {
    assert.equal(clampReply('短消息'), '短消息');
  });

  it('超长回复被收窄到上限内', () => {
    const long = '测'.repeat(1000);
    const out = clampReply(long);
    assert.ok(fullWidthLength(out) <= QUERY_MAX_CHARS);
  });
});
