/**
 * 阶段 4 回归：CSV 导入解析（PRD FR-06）。
 *
 * 导入错的代价是把错误数据写进账本且不易发现，因此解析、类型检查与
 * 「疑似重复只提示不处理」这三件事都必须逐条测试。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  autoMapColumns,
  detectDuplicateSuspects,
  hashCsv,
  normalizeRows,
  parseAmountCell,
  parseCsv,
  parseDateCell,
} from '../../src/server/lib/csv';

describe('CSV 解析', () => {
  it('处理引号、字段内逗号与换行', () => {
    const csv = 'date,amount,note\n2026-01-01,10.00,"含,逗号"\n2026-01-02,20.00,"含\n换行"';
    const { header, rows } = parseCsv(csv);
    assert.deepEqual(header, ['date', 'amount', 'note']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.values[2], '含,逗号');
    assert.equal(rows[1]!.values[2], '含\n换行');
  });

  it('处理转义的双引号', () => {
    const { rows } = parseCsv('a\n"他说""你好"""');
    assert.equal(rows[0]!.values[0], '他说"你好"');
  });

  it('兼容 CRLF 与带 BOM 的文件（否则第一个表头会带不可见字符）', () => {
    const { header, rows } = parseCsv('﻿date,amount\r\n2026-01-01,10\r\n');
    assert.deepEqual(header, ['date', 'amount']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.values[0], '2026-01-01');
  });

  it('忽略空行，并报告未闭合引号', () => {
    const { rows } = parseCsv('a\n1\n\n2\n');
    assert.equal(rows.length, 2);

    const bad = parseCsv('a\n"未闭合');
    assert.ok(bad.errors.some((e) => e.includes('未闭合')));
  });

  it('空文件给出明确错误而不是静默成功', () => {
    const { rows, errors } = parseCsv('');
    assert.equal(rows.length, 0);
    assert.ok(errors.length > 0);
  });
});

describe('列映射', () => {
  it('识别中文表头', () => {
    const { mapping } = autoMapColumns(['付款日期', '金额', '币种', '备注']);
    assert.equal(mapping.paidAt, 0);
    assert.equal(mapping.amount, 1);
    assert.equal(mapping.currency, 2);
    assert.equal(mapping.note, 3);
  });

  it('识别英文表头并忽略大小写与空格', () => {
    const { mapping } = autoMapColumns(['Payment Date', 'Amount', 'Currency']);
    assert.equal(mapping.paidAt, 0);
    assert.equal(mapping.amount, 1);
    assert.equal(mapping.currency, 2);
  });

  it('未识别的列会被列出，供人工指定', () => {
    const { unmatched } = autoMapColumns(['日期', '金额', '奇怪的列']);
    assert.deepEqual(unmatched, ['奇怪的列']);
  });

  it('同一列不会被两个字段重复占用', () => {
    const { mapping } = autoMapColumns(['date', 'date']);
    const used = Object.values(mapping).filter((v) => v !== undefined);
    assert.equal(new Set(used).size, used.length);
  });
});

describe('单元格类型解析', () => {
  it('接受多种日期写法', () => {
    assert.equal(parseDateCell('2026-01-05'), '2026-01-05');
    assert.equal(parseDateCell('2026/1/5'), '2026-01-05');
    assert.equal(parseDateCell('2026年1月5日'), '2026-01-05');
    assert.equal(parseDateCell('2026-01-05 12:30:00'), '2026-01-05');
  });

  it('拒绝不存在的日期', () => {
    assert.equal(parseDateCell('2026-02-30'), null);
    assert.equal(parseDateCell('2026-13-01'), null);
    assert.equal(parseDateCell('随便写的'), null);
    assert.equal(parseDateCell(''), null);
  });

  it('金额去掉货币符号与千分位', () => {
    assert.equal(parseAmountCell('¥1,234.56'), '1234.56');
    assert.equal(parseAmountCell('$20'), '20.00');
    assert.equal(parseAmountCell('19.9'), '19.90');
    assert.equal(parseAmountCell('(30.00)'), '30.00');
  });

  it('拒绝非数字金额', () => {
    assert.equal(parseAmountCell('abc'), null);
    assert.equal(parseAmountCell(''), null);
    assert.equal(parseAmountCell('1.2.3'), null);
  });
});

describe('行归一化与类型检查', () => {
  const mapping = { paidAt: 0, amount: 1, currency: 2, note: 3 };

  it('合法行被转换，币种缺省用默认值', () => {
    const { valid, issues } = normalizeRows(
      [{ line: 2, values: ['2026-01-01', '10.00', '', '备注'] }],
      mapping,
      { defaultCurrency: 'CNY' },
    );
    assert.equal(issues.length, 0);
    assert.equal(valid.length, 1);
    assert.equal(valid[0]!.currency, 'CNY');
    assert.equal(valid[0]!.note, '备注');
  });

  it('错误行被逐条报告且不进入导入，合法行不受影响', () => {
    const { valid, issues } = normalizeRows(
      [
        { line: 2, values: ['2026-01-01', '10.00', 'CNY', ''] },
        { line: 3, values: ['不是日期', '20.00', 'CNY', ''] },
        { line: 4, values: ['2026-01-03', 'abc', 'CNY', ''] },
        { line: 5, values: ['2026-01-04', '30.00', 'RMB', ''] },
      ],
      mapping,
    );
    assert.equal(valid.length, 1);
    assert.equal(valid[0]!.line, 2);
    assert.equal(issues.length, 3);
    assert.deepEqual(issues.map((i) => i.line), [3, 4, 5]);
    assert.equal(issues[0]!.field, 'paidAt');
    assert.equal(issues[1]!.field, 'amount');
    assert.equal(issues[2]!.field, 'currency');
  });

  it('完全空行被跳过而不是报错', () => {
    const { valid, issues } = normalizeRows([{ line: 2, values: ['', '', '', ''] }], mapping);
    assert.equal(valid.length, 0);
    assert.equal(issues.length, 0);
  });

  it('识别退款标记', () => {
    const { valid } = normalizeRows([{ line: 2, values: ['2026-01-01', '10.00', 'CNY', ''] }], {
      ...mapping,
      isRefund: 4,
    });
    assert.equal(valid[0]!.isRefund, false);
  });
});

describe('疑似重复只提示、不处理', () => {
  const row = (line: number, paidAt: string, amount: string, currency = 'CNY') => ({
    line,
    paidAt,
    amount,
    currency,
    note: null,
    subscriptionName: null,
    paymentChannel: null,
    isRefund: false,
  });

  it('与已有记录同日期同金额时给出提示', () => {
    const suspicions = detectDuplicateSuspects(
      [row(2, '2026-01-01', '20.00')],
      [{ paidAt: '2026-01-01', amount: '20.00', currency: 'CNY' }],
    );
    assert.equal(suspicions.length, 1);
    assert.equal(suspicions[0]!.reason, 'matches_existing');
    assert.equal(suspicions[0]!.line, 2);
  });

  it('文件内部同日期同金额也会提示', () => {
    const suspicions = detectDuplicateSuspects([row(2, '2026-01-01', '20.00'), row(3, '2026-01-01', '20.00')], []);
    assert.equal(suspicions.length, 1);
    assert.equal(suspicions[0]!.reason, 'duplicate_in_file');
  });

  it('金额尾零不同仍视为疑似重复（20.0 与 20.00）', () => {
    const suspicions = detectDuplicateSuspects([row(2, '2026-01-01', '20.0')], [
      { paidAt: '2026-01-01', amount: '20.00', currency: 'CNY' },
    ]);
    assert.equal(suspicions.length, 1);
  });

  it('日期或币种不同则不算疑似重复', () => {
    assert.equal(
      detectDuplicateSuspects([row(2, '2026-01-02', '20.00')], [{ paidAt: '2026-01-01', amount: '20.00', currency: 'CNY' }]).length,
      0,
    );
    assert.equal(
      detectDuplicateSuspects([row(2, '2026-01-01', '20.00', 'USD')], [{ paidAt: '2026-01-01', amount: '20.00', currency: 'CNY' }]).length,
      0,
    );
  });

  it('检测函数不修改输入，也不返回任何"已合并/已跳过"的指令', () => {
    const candidates = [row(2, '2026-01-01', '20.00')];
    const snapshot = JSON.stringify(candidates);
    const result = detectDuplicateSuspects(candidates, [{ paidAt: '2026-01-01', amount: '20.00', currency: 'CNY' }]);
    assert.equal(JSON.stringify(candidates), snapshot, '不得修改调用方数据');
    // 结果只含提示信息，没有任何指示如何处理重复的字段
    for (const s of result) {
      assert.deepEqual(Object.keys(s).sort(), ['detail', 'line', 'reason']);
    }
  });
});

describe('文件摘要', () => {
  it('同一内容摘要稳定，不同内容摘要不同', () => {
    assert.equal(hashCsv('a,b\n1,2'), hashCsv('a,b\n1,2'));
    assert.notEqual(hashCsv('a,b\n1,2'), hashCsv('a,b\n1,3'));
  });
});
