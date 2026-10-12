import { useEffect, useState } from 'react';
import { ApiError, requestRaw } from '../api';
import { Alert, Card, Spinner } from './ui';

type Channel = { bound: boolean; botId: string | null; ready: boolean; state: string;
  used: number; accepted: number; failed: number; unknown: number; warnAt: number; pauseAt: number;
  estimatedRemaining: number; refreshedAt: string | null; warned: boolean; warningResult: string | null;
  pausedReason: string | null; listenerAt: string | null; listenerError: string | null };
type Login = { id: string; image: string; status: string; expiresAt: string };
const stateText: Record<string, string> = {
  unbound: '未绑定', awaiting_message: '已扫码，请先在微信发送一句话', ready: '可以发送',
  paused: '已暂停，等待你在微信回复', credential_error: '凭据无法读取，请重新扫码',
};
const loginText: Record<string, string> = {
  wait: '等待扫码', scaned: '已扫码，请在手机上确认', need_verifycode: '请填写手机显示的验证码',
  verify_code_blocked: '验证码尝试过多，请重新获取二维码', expired: '二维码已过期，请重新获取',
  binded_redirect: '该机器人已绑定到其他实例，请重新获取二维码', confirmed: '绑定成功',
};
export function WechatBinding({ onChanged }: { onChanged?: () => void }) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [epoch, setEpoch] = useState(0);
  async function refresh() {
    setChannel(await requestRaw<Channel>('/wechat'));
    onChanged?.();
  }
  useEffect(() => {
    void refresh().catch(() => setError('无法读取微信绑定状态'));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 10000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!login?.id) return;
    let stopped = false;
    const controller = new AbortController();
    const id = login.id;
    const initialCode = code;
    void (async () => {
      let verifyCode: string | undefined = initialCode || undefined;
      while (!stopped) {
        try {
          const current = await requestRaw<Login>(`/wechat/login/${id}/poll`, {
            method: 'POST', body: verifyCode ? { verifyCode } : {}, signal: controller.signal,
          });
          verifyCode = undefined;
          if (stopped) return;
          setLogin(current);
          if (current.status === 'confirmed') { setCode(''); await refresh(); return; }
          if (['expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'].includes(current.status)) return;
        } catch (err) {
          if (stopped) return;
          setError(err instanceof ApiError ? err.message : '查询扫码状态失败');
          return;
        }
        await new Promise(r => window.setTimeout(r, 1500));
      }
    })();
    return () => { stopped = true; controller.abort(); };
  }, [login?.id, epoch]);
  async function start() {
    setBusy(true); setError(null); setCode(''); setLogin(null);
    try { setLogin(await requestRaw<Login>('/wechat/login', { method: 'POST' })); }
    catch (err) { setError(err instanceof ApiError ? err.message : '获取二维码失败'); }
    finally { setBusy(false); }
  }
  async function unbind() {
    if (!window.confirm('解绑 LifeOS 微信通道？未发送的提醒将保留并按既有过期策略处理。')) return;
    setBusy(true); setError(null);
    try { await requestRaw('/wechat', { method: 'DELETE' }); setLogin(null); await refresh(); }
    catch (err) { setError(err instanceof ApiError ? err.message : '解绑失败'); }
    finally { setBusy(false); }
  }
  return <Card title="微信提醒" subtitle="LifeOS 独立扫码绑定；发送次数是经验估计">
    {channel ? <div className="space-y-2 text-sm">
      <p>状态：<strong>{stateText[channel.state] ?? channel.state}</strong>{channel.botId ? ` · ${channel.botId}` : ''}</p>
      {channel.bound ? <>
        <p>本轮已占用 <strong>{channel.used}/{channel.pauseAt}</strong> 次请求；第 {channel.warnAt} 次后另发刷新提醒，达到 {channel.pauseAt} 次暂停。</p>
        <p className="text-muted">微信侧接受 {channel.accepted} · 明确失败 {channel.failed} · 结果未知 {channel.unknown}。剩余 {channel.estimatedRemaining} 次仅为估计。</p>
        <p className="text-muted">最近刷新：{channel.refreshedAt ? new Date(channel.refreshedAt).toLocaleString('zh-CN') : '尚未收到消息'}</p>
        {channel.listenerError ? <Alert tone="warn">{channel.listenerError}</Alert> : null}
        {channel.state === 'paused' || channel.state === 'awaiting_message' ? <p className="text-amber-700">请在微信向这个机器人回复任意文字，或发送 /refresh-context。收到有效消息后自动恢复。</p> : null}
      </> : null}
    </div> : <p className="text-sm text-muted">读取中…</p>}
    {error ? <div className="mt-3"><Alert>{error}</Alert></div> : null}
    <div className="mt-4 flex flex-wrap gap-2">
      <button className="btn-primary" disabled={busy} onClick={() => void start()}>{busy ? <Spinner /> : null}{channel?.bound ? '重新扫码绑定' : '扫码绑定微信'}</button>
      {channel?.bound ? <button className="btn-ghost" disabled={busy} onClick={() => void unbind()}>解绑</button> : null}
    </div>
    {login ? <div className="mt-4 rounded-xl border border-line p-4">
      <p className="text-sm font-medium">{loginText[login.status] ?? login.status}</p>
      {login.image ? <img className="mt-3 h-56 w-56" src={login.image} alt="微信扫码绑定二维码" /> : null}
      {login.status === 'need_verifycode' ? <div className="mt-3 flex gap-2">
        <input className="input max-w-36" inputMode="numeric" pattern="[0-9]{4,8}" value={code} onChange={e => setCode(e.target.value)} aria-label="手机验证码" />
        <button className="btn-primary" disabled={!/^\d{4,8}$/.test(code)} onClick={() => setEpoch(v => v + 1)}>提交验证码</button>
      </div> : null}
      {error && ['wait', 'scaned'].includes(login.status) ? <button className="btn-ghost mt-3" onClick={() => { setError(null); setEpoch(v => v + 1); }}>重试查询扫码状态</button> : null}
      {login.status === 'confirmed' ? <p className="mt-2 text-sm">请在微信给机器人发一句话，收到后发送通道才会启用。</p> : null}
    </div> : null}
  </Card>;
}
