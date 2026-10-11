/**
 * MiMo 语音识别客户端（PRD FR-03.1–03.2）。
 *
 * 端点与格式来自实测（2026-10-11 预研）：走 **Chat Completions**，
 * 音频以 input_audio 内容块传入，而不是常规的 /audio/transcriptions。
 *   POST {MIMO_BASE_URL}/chat/completions
 *   headers: api-key: <MIMO_API_KEY>
 *   body: { model, messages:[{role:'user',content:[{type:'input_audio',
 *           input_audio:{data:'data:audio/wav;base64,...'}}]}], asr_options:{language} }
 */
import { config } from '../../config';

export type AsrResult =
  | { ok: true; text: string; seconds?: number; model: string }
  | { ok: false; error: string; kind: 'not_configured' | 'rejected' | 'timeout' | 'upstream' };

/** 上游限制：音频过大直接拒绝，避免把请求打到超时（PRD FR-03.8 对录音长度做限制） */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 120;

const SUPPORTED_FORMATS = ['wav', 'mp3'] as const;
export type AudioFormat = (typeof SUPPORTED_FORMATS)[number];

export function isSupportedFormat(format: string): format is AudioFormat {
  return (SUPPORTED_FORMATS as readonly string[]).includes(format);
}

export function isAsrConfigured(): boolean {
  return Boolean(process.env.MIMO_API_KEY);
}

export function asrModel(): string {
  return process.env.MIMO_ASR_MODEL ?? 'mimo-v2.5-asr';
}

export async function transcribe(
  audioBase64: string,
  format: AudioFormat,
  language: 'auto' | 'zh' | 'en' = 'zh',
  timeoutMs = Number(process.env.MIMO_TIMEOUT_MS ?? 60_000),
): Promise<AsrResult> {
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) {
    return { ok: false, kind: 'not_configured', error: '未配置 MIMO_API_KEY' };
  }

  const base = (process.env.MIMO_BASE_URL ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
  const model = asrModel();

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: `data:audio/${format};base64,${audioBase64}` },
          },
        ],
      },
    ],
    asr_options: { language },
  };

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        kind: 'rejected',
        error: `HTTP ${response.status}: ${sanitize(text).slice(0, 200)}`,
      };
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { seconds?: number };
    };

    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      return { ok: false, kind: 'upstream', error: '上游未返回转写文本' };
    }

    return { ok: true, text: text.trim(), seconds: payload.usage?.seconds, model };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const isTimeout = /abort|timeout|timed out/i.test(message);
    return {
      ok: false,
      kind: isTimeout ? 'timeout' : 'upstream',
      error: sanitize(message).slice(0, 200),
    };
  }
}

/** 脱敏：日志与响应中不得出现密钥（PRD FR-08） */
function sanitize(text: string): string {
  return (text || '')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/\b(sk-)[A-Za-z0-9._\-]{8,}/gi, '$1***');
}

export { config };
