/**
 * A2 回归：iLink 适配器的三态判定。
 *
 * 覆盖验收报告指出的真实缺陷——原适配器把 HTTP 200 直接记为成功。
 * 这里的断言全部针对"下游业务回执"，HTTP 成功绝不等于业务接受。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

process.env.ILINK_TOKEN = 'test-token-value';
process.env.ILINK_TO_USER_ID = 'test-recipient-id';
process.env.ILINK_BASE_URL = 'https://ilink.test.invalid';
process.env.ILINK_CONTEXT_TOKEN = 'test-context-token';

const { IlinkWechatProvider } = await import('../../src/worker/providers/ilink');

const realFetch = globalThis.fetch;
let lastRequest: { url: string; init: RequestInit | undefined } | null = null;

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    lastRequest = { url: String(input), init };
    return handler(String(input));
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const payload = {
  jobId: 'job-1',
  title: '测试提醒',
  body: '正文',
  subjectType: 'event',
  subjectId: 'subject-1',
  idempotencyKey: 'lifeos:test-key-1',
};

describe('A2 iLink 适配器三态判定', () => {
  beforeEach(() => {
    lastRequest = null;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('HTTP 200 + 业务码 ret=-2/errcode=-14 必须判为需人工处理，而不是成功（原缺陷）', async () => {
    stubFetch(() => jsonResponse({ ret: -2, errcode: -14 }));
    const result = await new IlinkWechatProvider().send(payload);

    assert.equal(result.ok, false, 'HTTP 200 绝不能被当作业务成功');
    assert.equal(result.ok === false && result.kind, 'needs_human');
    assert.match(result.ok === false ? result.error : '', /auth_or_context|ret=-2|errcode=-14/);
  });

  it('HTTP 200 但业务体为空对象（无任何成功码）必须判为 unknown，且不可自动重试', async () => {
    stubFetch(() => jsonResponse({}));
    const result = await new IlinkWechatProvider().send(payload);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'unknown', 'unknown 是"不重试"的类别');
    assert.match(result.ok === false ? result.error : '', /unconfirmed|business_unconfirmed/);
  });

  it('业务码 ret=0 判为接受', async () => {
    stubFetch(() => jsonResponse({ ret: 0 }));
    const result = await new IlinkWechatProvider().send(payload);
    assert.equal(result.ok, true);
  });

  it('仅返回服务端 message_id 也判为接受（与既有实现一致）', async () => {
    stubFetch(() => jsonResponse({ message_id: 'srv-msg-123' }));
    const result = await new IlinkWechatProvider().send(payload);
    assert.equal(result.ok, true);
  });

  it('业务码为 0 但 errmsg 明确报错 → unknown，不算接受', async () => {
    stubFetch(() => jsonResponse({ ret: 0, errmsg: 'invalid recipient' }));
    const result = await new IlinkWechatProvider().send(payload);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'unknown');
  });

  it('明确业务错误（非鉴权类）判为可重试', async () => {
    stubFetch(() => jsonResponse({ ret: 100, errcode: 0 }));
    const result = await new IlinkWechatProvider().send(payload);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'retryable');
  });

  it('HTTP 5xx 判为可重试', async () => {
    stubFetch(() => new Response('boom', { status: 502 }));
    const result = await new IlinkWechatProvider().send(payload);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'retryable');
  });

  it('HTTP 200 但响应不是 JSON → unknown，不能当成功也不能当明确拒绝', async () => {
    stubFetch(() => new Response('<html>ok</html>', { status: 200 }));
    const result = await new IlinkWechatProvider().send(payload);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'unknown');
  });

  it('超时判为 unknown（远端可能已接受，绝不自动重试）', async () => {
    stubFetch(() => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });
    const result = await new IlinkWechatProvider().send(payload);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'unknown');
    assert.match(result.ok === false ? result.error : '', /timeout_remote_may_have_accepted/);
  });

  it('多段消息部分接受 → unknown（不能整体算成功）', async () => {
    let call = 0;
    stubFetch(() => {
      call += 1;
      return jsonResponse(call === 1 ? { ret: 0 } : { errcode: -1, errmsg: 'business fail' });
    });
    // 超过单条上限，强制分片
    const long = { ...payload, body: 'x'.repeat(4000) };
    const result = await new IlinkWechatProvider().send(long);
    assert.equal(call, 2, '应产生 2 次分片调用');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'unknown');
    assert.match(result.ok === false ? result.error : '', /partial_acceptance/);
  });

  it('未配置凭据时不发请求，直接判为需人工处理', async () => {
    stubFetch(() => {
      throw new Error('未配置时不应发起任何请求');
    });

    // 字段初始化在构造时读取 env，因此临时清空后新建实例即可复现"未配置"
    const savedToken = process.env.ILINK_TOKEN;
    delete process.env.ILINK_TOKEN;
    try {
      const provider = new IlinkWechatProvider();
      assert.equal(provider.isConfigured(), false);
      assert.equal(provider.describe().configured, false);

      const result = await provider.send(payload);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.kind, 'needs_human');
    } finally {
      process.env.ILINK_TOKEN = savedToken;
    }

    assert.equal(lastRequest, null, '未配置时绝不能发出请求');
  });

  it('缺少收件人时同样视为未配置', () => {
    const saved = process.env.ILINK_TO_USER_ID;
    delete process.env.ILINK_TO_USER_ID;
    try {
      const provider = new IlinkWechatProvider();
      assert.equal(provider.isConfigured(), false);
      assert.match(provider.describe().detail, /ILINK_TO_USER_ID/);
    } finally {
      process.env.ILINK_TO_USER_ID = saved;
    }
  });

  it('请求形状与既有协议一致：端点、鉴权头、消息体字段', async () => {
    stubFetch(() => jsonResponse({ ret: 0 }));
    await new IlinkWechatProvider().send(payload);

    assert.ok(lastRequest, '应发出请求');
    assert.equal(lastRequest!.url, 'https://ilink.test.invalid/ilink/bot/sendmessage');
    assert.equal(lastRequest!.init?.method, 'POST');

    const headers = lastRequest!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-token-value');
    assert.equal(headers.AuthorizationType, 'ilink_bot_token');
    assert.ok(headers['X-WECHAT-UIN'], '必须带 X-WECHAT-UIN');

    const body = JSON.parse(String(lastRequest!.init?.body)) as {
      msg: Record<string, unknown>;
      base_info: Record<string, unknown>;
    };
    assert.equal(body.msg.to_user_id, 'test-recipient-id');
    assert.equal(body.msg.message_type, 2);
    assert.equal(body.msg.message_state, 2);
    assert.equal(body.msg.context_token, 'test-context-token');
    assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: '测试提醒\n正文' } }]);
    assert.ok(body.base_info.channel_version, '必须带 channel_version');
    // client_id 由幂等键派生，保证重试携带同一标识
    assert.match(String(body.msg.client_id), /^lifeos:lifeos:test-key-1/);
  });
});
