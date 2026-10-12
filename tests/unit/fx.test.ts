/**
 * 阶段 4 回归：汇率快照（PRD FR-06）。
 *
 * 核心要求：人民币汇总必须带**日期与来源**；来源不可用时允许手动汇率并标注「估算」，
 * 但绝不能伪装为精确金额，也绝不能编造汇率。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  clearFxCache,
  extractRateValue,
  fetchRate,
  isFxConfigured,
  pickByPath,
  resolveCnyAmount,
} from '../../src/server/lib/fx';

const realFetch = globalThis.fetch;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  clearFxCache();
  process.env.FX_PROVIDER_URL = 'https://fx.test.invalid/rate?from={from}&to={to}&date={date}';
  process.env.FX_PROVIDER_NAME = 'test-provider';
  delete process.env.FX_JSON_PATH;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ rate: 7.1234 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.FX_PROVIDER_URL;
  delete process.env.FX_PROVIDER_NAME;
  delete process.env.FX_JSON_PATH;
});

describe('配置与取值', () => {
  it('未配置时不认为可用', () => {
    delete process.env.FX_PROVIDER_URL;
    assert.equal(isFxConfigured(), false);
  });

  it('按点路径取值；未配置路径时返回原始载荷', () => {
    assert.equal(pickByPath({ data: { rates: { CNY: 7.1 } } }, 'data.rates.CNY'), 7.1);
    assert.deepEqual(pickByPath({ rate: 7.1 }, undefined), { rate: 7.1 });
    assert.equal(pickByPath({ a: 1 }, 'a.b.c'), undefined);
  });
});

describe('拉取汇率', () => {
  it('成功时返回带来源与日期的汇率，并替换 URL 模板占位符', async () => {
    const rate = await fetchRate('USD', 'CNY', '2026-10-12');
    assert.ok(rate);
    assert.equal(rate!.source, 'test-provider');
    assert.equal(rate!.date, '2026-10-12');
    assert.match(rate!.rate, /^7\.1234/);
    assert.equal(calls[0], 'https://fx.test.invalid/rate?from=USD&to=CNY&date=2026-10-12');
  });

  it('同一 from/to/date 在缓存有效期内不重复请求上游', async () => {
    await fetchRate('USD', 'CNY', '2026-10-12');
    await fetchRate('USD', 'CNY', '2026-10-12');
    assert.equal(calls.length, 1, '第二次应命中缓存');
  });

  it('上游报错时返回 null，而不是抛错或返回假汇率', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    assert.equal(await fetchRate('USD', 'CNY', '2026-10-12'), null);
  });

  it('网络异常与超时同样返回 null', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    assert.equal(await fetchRate('USD', 'CNY', '2026-10-12'), null);
  });

  it('上游返回非法汇率（0、负数、超大、非数字）一律视为取不到', async () => {
    for (const bad of [0, -1, 1e12, 'abc', null]) {
      clearFxCache();
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ rate: bad }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      assert.equal(await fetchRate('USD', 'CNY', '2026-10-12'), null, `${String(bad)} 应被拒绝`);
    }
  });
});

describe('人民币折算口径', () => {
  it('人民币付款不需要汇率，且不算估算', async () => {
    const result = await resolveCnyAmount({ amount: '100.00', currency: 'CNY', paidAt: '2026-10-12' });
    assert.equal(result.fxRate, null);
    assert.equal(result.cnyAmount, '100.00');
    assert.equal(result.isEstimatedFx, false);
  });

  it('手动汇率折算结果标记为「估算」，不得伪装为精确金额', async () => {
    const result = await resolveCnyAmount({
      amount: '20.00',
      currency: 'USD',
      paidAt: '2026-10-12',
      manualRate: '7.5',
      manualSource: '我在银行 App 查的',
    });
    assert.equal(result.fxRate, '7.5');
    assert.equal(result.fxRateSource, '我在银行 App 查的');
    assert.equal(result.cnyAmount, '150.00');
    assert.equal(result.isEstimatedFx, true, '手动汇率必须标注为估算');
    assert.equal(calls.length, 0, '有手动汇率时不应再请求上游');
  });

  it('自动汇率取得时不算估算，并记录来源', async () => {
    const result = await resolveCnyAmount({ amount: '20.00', currency: 'USD', paidAt: '2026-10-12' });
    assert.equal(result.fxRateSource, 'test-provider');
    assert.equal(result.isEstimatedFx, false);
    assert.ok(result.cnyAmount);
  });

  it('未配置汇率源且无手动汇率时**不编造汇率**，折算金额留空', async () => {
    delete process.env.FX_PROVIDER_URL;
    const result = await resolveCnyAmount({ amount: '20.00', currency: 'USD', paidAt: '2026-10-12' });
    assert.equal(result.fxRate, null);
    assert.equal(result.cnyAmount, null);
    assert.equal(result.isEstimatedFx, false);
  });

  it('手动汇率非法时回退到自动汇率源', async () => {
    const result = await resolveCnyAmount({
      amount: '10.00',
      currency: 'USD',
      paidAt: '2026-10-12',
      manualRate: '0',
    });
    assert.equal(result.fxRateSource, 'test-provider');
    assert.equal(calls.length, 1);
  });
});

describe('未配置 FX_JSON_PATH 时的汇率识别（原缺陷回归）', () => {
  // 原缺陷：未配置路径时 pickByPath 返回整个响应对象，调用方只认数值 →
  // 取到 NaN → fetchRate 静默返回 null。数据源结构完全正确却永远取不到汇率。

  it('响应本身就是数字或数字字符串时可直接使用', () => {
    assert.equal(extractRateValue(7.1234, undefined), 7.1234);
    assert.equal(extractRateValue('7.1234', undefined), 7.1234);
  });

  it('自动识别常见字段名', () => {
    assert.equal(extractRateValue({ rate: 7.1 }, undefined), 7.1);
    assert.equal(extractRateValue({ result: 7.2 }, undefined), 7.2);
    assert.equal(extractRateValue({ data: { rate: 7.3 } }, undefined), 7.3);
    assert.equal(extractRateValue({ rates: { CNY: 7.4 } }, undefined), 7.4);
  });

  it('配置了路径时严格按路径取，不做猜测', () => {
    assert.equal(extractRateValue({ rate: 7.1, data: { rate: 9.9 } }, 'data.rate'), 9.9);
    // 路径存在但取不到 → NaN，不能悄悄回退到别的字段
    assert.ok(Number.isNaN(extractRateValue({ rate: 7.1 }, 'data.rate')));
  });

  it('结构里确实没有汇率时返回 NaN', () => {
    assert.ok(Number.isNaN(extractRateValue({ foo: 'bar' }, undefined)));
    assert.ok(Number.isNaN(extractRateValue({ rate: { nested: 1 } }, undefined)));
    assert.ok(Number.isNaN(extractRateValue(null, undefined)));
  });

  it('端到端：未配置路径时 fetchRate 仍能取到汇率（原缺陷的直接复现）', async () => {
    delete process.env.FX_JSON_PATH;
    clearFxCache();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ rate: 7.1234 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const rate = await fetchRate('USD', 'CNY', '2026-10-12');
    assert.ok(rate, '未配置 FX_JSON_PATH 时也必须能取到汇率');
    assert.match(rate!.rate, /^7\.1234/);
    assert.equal(rate!.source, 'test-provider');
  });

  it('嵌套结构的常见形态也能取到', async () => {
    for (const body of [
      { data: { rate: 6.9 } },
      { result: '6.8' },
      { rates: { CNY: 6.7 } },
    ]) {
      clearFxCache();
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      const rate = await fetchRate('USD', 'CNY', '2026-10-12');
      assert.ok(rate, `应能从 ${JSON.stringify(body)} 取到汇率`);
    }
  });
});
