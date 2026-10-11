import { Hono } from 'hono';
import { config } from '../config';
import {
  MAX_AUDIO_BYTES,
  asrModel,
  isAsrConfigured,
  isSupportedFormat,
  transcribe,
  type AudioFormat,
} from '../lib/ai/mimo';
import { isLlmConfigured, llmModel, parseToDraft } from '../lib/ai/deepseek';
import { rateLimit } from '../lib/ratelimit';
import { ValidationError, optString, reqString } from '../lib/validate';
import { clientIp, requireAuth, type AppEnv } from '../middleware/auth';
import { guard } from './events';

export const voiceRoutes = new Hono<AppEnv>();

const AI_LIMIT_PER_HOUR = Number(process.env.AI_RATE_LIMIT_PER_HOUR ?? 60);

function checkAiQuota(c: Parameters<typeof clientIp>[0], bucket: string): Response | null {
  const result = rateLimit(`ai:${bucket}:${clientIp(c)}`, AI_LIMIT_PER_HOUR, 60 * 60 * 1000);
  if (result.ok) return null;
  return c.json(
    { error: 'rate_limited', message: `AI 调用过于频繁，请 ${result.retryAfterSeconds} 秒后再试` },
    429,
  );
}

/** AI 能力状态：只报告配置与否，绝不回显密钥 */
voiceRoutes.get('/status', requireAuth, (c) =>
  c.json({
    asr: { configured: isAsrConfigured(), model: asrModel() },
    llm: { configured: isLlmConfigured(), model: llmModel() },
    limits: { maxAudioBytes: MAX_AUDIO_BYTES },
  }),
);

/**
 * 语音转文字。
 *
 * 音频只在本进程内存中处理，**不写入磁盘、不落库**（PRD FR-03.8）。
 * 容器格式由浏览器端统一转成 WAV（服务器无 ffmpeg），故这里只接受 wav/mp3。
 */
voiceRoutes.post('/transcribe', requireAuth, async (c) =>
  guard(c, async () => {
    const limited = checkAiQuota(c, 'asr');
    if (limited) return limited;

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    // 注意顺序：不能先用带长度上限的 reqString 校验音频，
    // 否则超大音频会先抛校验错误、走 400，导致 413 分支永远不可达。
    const audio = typeof body.audio === 'string' ? body.audio : '';
    if (!audio) return c.json({ error: 'invalid_request', message: '缺少音频数据' }, 400);

    const format = optString(body.format, '音频格式', 8) ?? 'wav';
    if (!isSupportedFormat(format)) {
      return c.json({ error: 'invalid_request', message: '音频格式只支持 wav 或 mp3' }, 400);
    }

    // base64 会膨胀约 1/3，按解码后大小判断，避免超限请求打到上游
    const decodedBytes = Math.floor((audio.length * 3) / 4);
    if (decodedBytes > MAX_AUDIO_BYTES) {
      return c.json(
        {
          error: 'audio_too_large',
          message: `录音过长或文件过大（上限 ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)}MB），请缩短后重试`,
        },
        413,
      );
    }
    if (decodedBytes < 1024) {
      return c.json({ error: 'audio_too_short', message: '录音过短，请重新录制' }, 400);
    }

    const result = await transcribe(audio, format as AudioFormat);

    if (!result.ok) {
      // 失败可恢复：明确告知并允许用户直接手动录入（PRD FR-03.7）
      const message =
        result.kind === 'not_configured'
          ? '语音识别未配置，请改用手动录入'
          : result.kind === 'timeout'
            ? '语音识别超时，请重试或改用手动录入'
            : `语音识别失败：${result.error}`;
      const status = result.kind === 'not_configured' ? 503 : 502;
      return c.json({ error: `asr_${result.kind}`, message, recoverable: true }, status);
    }

    if (!result.text) {
      return c.json(
        { error: 'asr_empty', message: '没有识别到语音内容，请重新录制或改用手动录入', recoverable: true, text: '' },
        200,
      );
    }

    return c.json({ text: result.text, seconds: result.seconds ?? null, model: result.model });
  }),
);

/**
 * 文字 → 结构化草稿。
 * 只返回草稿，**不落库**：用户确认之前不得产生正式事项或通知（PRD FR-03.5）。
 */
voiceRoutes.post('/parse', requireAuth, async (c) =>
  guard(c, async () => {
    const limited = checkAiQuota(c, 'llm');
    if (limited) return limited;

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    let text: string;
    try {
      text = reqString(body.text, '文字内容', 2000);
    } catch (err) {
      if (err instanceof ValidationError) {
        return c.json({ error: 'invalid_request', message: err.message }, 400);
      }
      throw err;
    }

    const result = await parseToDraft({ text, now: new Date(), timezone: config.timezone });

    if (!result.ok) {
      const message =
        result.kind === 'not_configured'
          ? '事项解析未配置，请改用手动录入'
          : result.kind === 'timeout'
            ? '事项解析超时，请重试或改用手动录入'
            : `事项解析失败：${result.error}`;
      const status = result.kind === 'not_configured' ? 503 : 502;
      return c.json({ error: `llm_${result.kind}`, message, recoverable: true }, status);
    }

    return c.json({
      draft: result.draft,
      // 明确告知未落库，避免用户误以为已经创建
      persisted: false,
      timezone: config.timezone,
    });
  }),
);
