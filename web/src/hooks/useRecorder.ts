import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 浏览器端录音并编码为 WAV。
 *
 * 为什么在浏览器端转码：服务器（1GB 内存的 VPS）没有 ffmpeg，也不宜为此安装
 * 一整套多媒体工具链。浏览器用 Web Audio 解码后重采样为 16kHz 单声道 16bit WAV，
 * 正是 MiMo ASR 接受的格式，同时原始录音**从不落盘**（PRD FR-03.8）。
 */
export type RecorderState = 'idle' | 'requesting' | 'recording' | 'processing' | 'done' | 'error';

export const MAX_RECORD_SECONDS = 120;

function writeString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

/** 把任意解码后的音频重采样为 16kHz 单声道 16bit PCM 的 WAV */
export function encodeWav(buffer: AudioBuffer, targetRate = 16000): Blob {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);
  const first = buffer.getChannelData(0);
  const second = channels > 1 ? buffer.getChannelData(1) : null;

  for (let i = 0; i < length; i++) {
    mono[i] = second ? (first[i]! + second[i]!) / 2 : first[i]!;
  }

  const ratio = buffer.sampleRate / targetRate;
  const outLength = Math.max(1, Math.floor(length / ratio));
  const pcm = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const sample = mono[Math.floor(i * ratio)] ?? 0;
    pcm[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
  }

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, pcm.byteLength, true);

  return new Blob([header, pcm.buffer], { type: 'audio/wav' });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('音频编码失败'));
    reader.readAsDataURL(blob);
  });
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [wavBlob, setWavBlob] = useState<Blob | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    timerRef.current = null;
    autoStopRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    setWavBlob(null);
    setSeconds(0);
    setState('requesting');

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持录音，请改用手动录入');
      setState('error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        setState('processing');
        void (async () => {
          try {
            const raw = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
            const arrayBuffer = await raw.arrayBuffer();
            const ctx = new AudioContext();
            const decoded = await ctx.decodeAudioData(arrayBuffer);
            const wav = encodeWav(decoded);
            await ctx.close();
            setWavBlob(wav);
            setState('done');
          } catch {
            setError('音频格式转换失败，请改用手动录入');
            setState('error');
          } finally {
            cleanup();
          }
        })();
      };

      recorder.start();
      setState('recording');

      timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
      // 硬性时长上限，避免无限录音（PRD FR-03.8）
      autoStopRef.current = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, MAX_RECORD_SECONDS * 1000);
    } catch (err) {
      const name = (err as Error).name;
      setError(
        name === 'NotAllowedError'
          ? '麦克风权限被拒绝，请在浏览器设置中允许后重试，或改用手动录入'
          : '无法访问麦克风，请改用手动录入',
      );
      setState('error');
      cleanup();
    }
  }, [cleanup]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') recorder.stop();
  }, []);

  const reset = useCallback(() => {
    cleanup();
    recorderRef.current = null;
    chunksRef.current = [];
    setWavBlob(null);
    setSeconds(0);
    setError(null);
    setState('idle');
  }, [cleanup]);

  return { state, seconds, error, wavBlob, start, stop, reset, maxSeconds: MAX_RECORD_SECONDS };
}
