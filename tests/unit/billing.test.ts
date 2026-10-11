/**
 * 阶段 4 回归：计费规则纯逻辑（PRD FR-05 / FR-06）。
 *
 * 这里算错会直接导致账单日期与金额错误，且不容易在使用中察觉，
 * 因此每条规则都单独守一个测试。全部为纯函数，不需要数据库。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addMoney,
  daysUntilServiceEnd,
  generateExpectedBills,
  monthlyEquivalent,
  periodInMonths,
  projectBillingDate,
  validateBillingConfig,
  type BillingConfig,
} from '../../src/server/lib/billing';

function base(overrides: Partial<BillingConfig> = {}): BillingConfig {
  return {
    price: '30.00',
    currency: 'CNY',
    billingPeriod: 'monthly',
    billingIntervalDays: null,
    anchorDate: '2026-01-31',
    nextBillingDate: null,
    serviceEndDate: null,
    autoRenew: true,
    status: 'active',
    ...overrides,
  };
}

describe('月末夹取规则（PRD FR-05 默认设计）', () => {
  it('1 月 31 日按月推进时落到对应月份最后一天', () => {
    assert.equal(projectBillingDate('2026-01-31', 'monthly', null, 1), '2026-02-28'); // 平年
    assert.equal(projectBillingDate('2026-01-31', 'monthly', null, 2), '2026-03-31');
    assert.equal(projectBillingDate('2026-01-31', 'monthly', null, 3), '2026-04-30');
  });

  it('闰年 2 月落到 29 日', () => {
    assert.equal(projectBillingDate('2028-01-31', 'monthly', null, 1), '2028-02-29');
  });

  it('夹取后不会"记住"被夹的日期，下个月回到原始日', () => {
    // 2 月被夹到 28 后，3 月应回到 31 而不是继续用 28
    assert.equal(projectBillingDate('2026-01-31', 'monthly', null, 2), '2026-03-31');
  });

  it('季度与年付同样遵守月末夹取', () => {
    assert.equal(projectBillingDate('2026-01-31', 'quarterly', null, 1), '2026-04-30');
    assert.equal(projectBillingDate('2024-02-29', 'yearly', null, 1), '2025-02-28');
  });

  it('自定义天数周期走固定天数，不做月末夹取', () => {
    assert.equal(projectBillingDate('2026-01-31', 'custom_days', 30, 1), '2026-03-02');
  });
});

describe('金额运算不使用二进制浮点', () => {
  it('十进制相加不产生浮点误差', () => {
    assert.equal(addMoney('0.1', '0.2'), '0.30');
    assert.equal(addMoney('19.99', '0.01'), '20.00');
  });

  it('月均折算按周期正确分摊', () => {
    assert.equal(periodInMonths('monthly', null), 1);
    assert.equal(periodInMonths('yearly', null), 12);
    assert.equal(monthlyEquivalent(base({ price: '1200.00', billingPeriod: 'yearly' })), '100.00');
    assert.equal(monthlyEquivalent(base({ price: '300.00', billingPeriod: 'quarterly' })), '100.00');
  });

  it('终身订阅不计入月均', () => {
    assert.equal(monthlyEquivalent(base({ billingPeriod: 'lifetime' })), null);
  });
});

describe('预计账单生成（PRD FR-06）', () => {
  it('月付订阅生成滚动 12 个月的预计账单', () => {
    const bills = generateExpectedBills(
      base({ anchorDate: '2026-01-15', nextBillingDate: '2026-01-15' }),
      { from: '2026-01-01', horizonMonths: 12 },
    );
    assert.equal(bills.length, 12);
    assert.equal(bills[0]!.plannedDate, '2026-01-15');
    assert.equal(bills[11]!.plannedDate, '2026-12-15');
    assert.ok(bills.every((b) => b.amount === '30.00' && b.currency === 'CNY'));
  });

  it('不生成今天之前的账单（过去的由实付记录负责）', () => {
    const bills = generateExpectedBills(base({ anchorDate: '2026-01-15', nextBillingDate: '2026-01-15' }), {
      from: '2026-06-20',
      horizonMonths: 12,
    });
    assert.ok(bills.every((b) => b.plannedDate >= '2026-06-20'));
    assert.equal(bills[0]!.plannedDate, '2026-07-15');
  });

  it('自动续费关闭时只生成到服务到期日，不无限外推（PRD FR-04）', () => {
    const bills = generateExpectedBills(
      base({
        anchorDate: '2026-01-15',
        nextBillingDate: '2026-01-15',
        autoRenew: false,
        serviceEndDate: '2026-03-31',
        status: 'auto_renew_off',
      }),
      { from: '2026-01-01', horizonMonths: 24 },
    );
    assert.deepEqual(
      bills.map((b) => b.plannedDate),
      ['2026-01-15', '2026-02-15', '2026-03-15'],
      '到期日之后不得再生成扣费',
    );
  });

  it('自动续费关闭但没有到期日时不生成任何账单（避免凭空造扣费）', () => {
    const bills = generateExpectedBills(
      base({ autoRenew: false, serviceEndDate: null, status: 'auto_renew_off' }),
      { from: '2026-01-01' },
    );
    assert.equal(bills.length, 0);
  });

  it('终身订阅、已暂停、已结束都不生成账单', () => {
    assert.equal(generateExpectedBills(base({ billingPeriod: 'lifetime' }), { from: '2026-01-01' }).length, 0);
    assert.equal(generateExpectedBills(base({ status: 'paused' }), { from: '2026-01-01' }).length, 0);
    assert.equal(generateExpectedBills(base({ status: 'ended' }), { from: '2026-01-01' }).length, 0);
  });

  it('缺金额或锚点时安全返回空数组，不抛错也不造账单', () => {
    assert.equal(generateExpectedBills(base({ price: null }), { from: '2026-01-01' }).length, 0);
    assert.equal(generateExpectedBills(base({ price: '0.00' }), { from: '2026-01-01' }).length, 0);
    assert.equal(
      generateExpectedBills(base({ anchorDate: null, nextBillingDate: null }), { from: '2026-01-01' }).length,
      0,
    );
  });

  it('同一天不会重复生成（锚点与下次扣费日重合）', () => {
    const bills = generateExpectedBills(base({ anchorDate: '2026-01-15', nextBillingDate: '2026-01-15' }), {
      from: '2026-01-01',
      horizonMonths: 3,
    });
    const dates = bills.map((b) => b.plannedDate);
    assert.equal(new Set(dates).size, dates.length, '日期必须唯一');
  });

  it('自定义周期天数很小时仍能在有限步数内结束（不会死循环）', () => {
    const bills = generateExpectedBills(
      base({ billingPeriod: 'custom_days', billingIntervalDays: 1, anchorDate: '2026-01-01', nextBillingDate: '2026-01-01' }),
      { from: '2026-01-01', horizonMonths: 12 },
    );
    assert.ok(bills.length > 0 && bills.length <= 400, `应有界，实际 ${bills.length}`);
  });
});

describe('档案校验', () => {
  it('自定义周期缺少天数时报错', () => {
    const issues = validateBillingConfig({
      price: '10',
      billingPeriod: 'custom_days',
      billingIntervalDays: null,
      anchorDate: '2026-01-01',
      serviceEndDate: null,
      autoRenew: true,
    });
    assert.ok(issues.some((i) => i.field === 'billingIntervalDays'));
  });

  it('非终身订阅必须有计费锚点', () => {
    const issues = validateBillingConfig({
      price: '10',
      billingPeriod: 'monthly',
      billingIntervalDays: null,
      anchorDate: null,
      serviceEndDate: null,
      autoRenew: true,
    });
    assert.ok(issues.some((i) => i.field === 'anchorDate'));
  });

  it('服务到期日早于计费锚点时报错', () => {
    const issues = validateBillingConfig({
      price: '10',
      billingPeriod: 'monthly',
      billingIntervalDays: null,
      anchorDate: '2026-05-01',
      serviceEndDate: '2026-01-01',
      autoRenew: false,
    });
    assert.ok(issues.some((i) => i.field === 'serviceEndDate'));
  });

  it('价格超过两位小数被拒绝（金额精度约束）', () => {
    const issues = validateBillingConfig({
      price: '10.999',
      billingPeriod: 'monthly',
      billingIntervalDays: null,
      anchorDate: '2026-01-01',
      serviceEndDate: null,
      autoRenew: true,
    });
    assert.ok(issues.some((i) => i.field === 'price'));
  });

  it('合法档案无任何问题', () => {
    assert.deepEqual(
      validateBillingConfig({
        price: '30.00',
        billingPeriod: 'monthly',
        billingIntervalDays: null,
        anchorDate: '2026-01-31',
        serviceEndDate: '2026-12-31',
        autoRenew: true,
      }),
      [],
    );
  });
});

describe('到期天数', () => {
  it('无到期日返回 null，已过期返回负数', () => {
    assert.equal(daysUntilServiceEnd(base({ serviceEndDate: null }), '2026-06-01'), null);
    assert.equal(daysUntilServiceEnd(base({ serviceEndDate: '2026-05-30' }), '2026-06-01'), -2);
    assert.equal(daysUntilServiceEnd(base({ serviceEndDate: '2026-06-11' }), '2026-06-01'), 10);
  });
});
