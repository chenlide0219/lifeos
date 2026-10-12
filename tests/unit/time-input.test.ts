import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTimeInput } from '../../web/src/components/TimeInput';

describe('24 小时制时间粘贴解析', () => {
  it('接受精确分钟与边界值，拒绝越界和混入文字', () => {
    assert.equal(parseTimeInput('13:27'), '13:27');
    assert.equal(parseTimeInput('905'), '09:05');
    assert.equal(parseTimeInput('00：00'), '00:00');
    assert.equal(parseTimeInput('23:59'), '23:59');
    assert.equal(parseTimeInput('24:00'), null);
    assert.equal(parseTimeInput('12:60'), null);
    assert.equal(parseTimeInput('xx1327'), null);
  });
});
