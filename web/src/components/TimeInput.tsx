import { useEffect, useRef, useState } from 'react';

/**
 * 可键入的 24 小时制时间输入（HH:mm，精确到分钟）。
 *
 * 为什么不用 <input type="time">：手机上它会弹原生钟面，拖动选不准，
 * 微信内置浏览器尤其难用。这里用两个数字字段（inputMode=numeric 弹数字键盘），
 * 小时和分钟分别输入，并支持把 "13:27" 整体粘贴进任一字段。
 *
 * 值约定：value/onChange 始终是 "HH:mm" 或 ''（空）。
 * 00:00 与 23:59 是合法边界；超出范围或只填一半视为无效，由组件内提示。
 */

/** 解析灵活输入：13:27 / 13：27 / 1327 / 905 → "HH:mm"；非法返回 null */
export function parseTimeInput(raw: string): string | null {
  const text = raw.trim().replace(/：/g, ':');
  if (!text) return null;
  let h: string;
  let m: string;
  const withColon = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (withColon) {
    h = withColon[1]!;
    m = withColon[2]!;
  } else {
    if (!/^\d{3,4}$/.test(text)) return null;
    const digits = text;
    // 3~4 位连续数字按"时+分"理解（905 → 9:05，1327 → 13:27）；
    // 1~2 位只是半截输入，不算错也不算成
    if (digits.length < 3 || digits.length > 4) return null;
    h = digits.slice(0, digits.length - 2);
    m = digits.slice(-2);
  }
  const hh = Number(h);
  const mm = Number(m);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 由两个原始字段合成 "HH:mm"；任一为空或越界返回 null */
function combine(hour: string, minute: string): string | null {
  if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute)) return null;
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

type Props = {
  /** "HH:mm" 或 '' */
  value: string;
  onChange: (value: string) => void;
  /** 小时字段的 id，外部 <label htmlFor> 指向它 */
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  /** 非空但不完整或越界时为 true，供表单阻止误按空值保存 */
  onInvalidChange?: (invalid: boolean) => void;
};

export function TimeInput({ value, onChange, id, ariaLabel, placeholder = 'HH mm', onInvalidChange }: Props) {
  const [hour, setHour] = useState(value ? value.slice(0, 2) : '');
  const [minute, setMinute] = useState(value ? value.slice(3, 5) : '');
  const [touched, setTouched] = useState(false);
  const minuteRef = useRef<HTMLInputElement>(null);
  // 记录已知的外部值，避免"用户清空一个字段"被外部同步效应放大成清空两个字段
  const lastKnown = useRef(value);

  useEffect(() => {
    if (value !== lastKnown.current) {
      lastKnown.current = value;
      setHour(value ? value.slice(0, 2) : '');
      setMinute(value ? value.slice(3, 5) : '');
    }
  }, [value]);

  useEffect(() => {
    onInvalidChange?.((hour !== '' || minute !== '') && combine(hour, minute) === null);
  }, [hour, minute, onInvalidChange]);

  function emit(nextHour: string, nextMinute: string) {
    const parsed = combine(nextHour, nextMinute);
    if (parsed !== value) {
      lastKnown.current = parsed ?? '';
      onChange(parsed ?? '');
    }
  }

  function handlePaste(text: string, field: 'hour' | 'minute') {
    const parsed = parseTimeInput(text);
    if (!parsed) return false;
    setHour(parsed.slice(0, 2));
    setMinute(parsed.slice(3, 5));
    setTouched(true);
    emit(parsed.slice(0, 2), parsed.slice(3, 5));
    if (field === 'hour') minuteRef.current?.focus();
    return true;
  }

  const parsed = combine(hour, minute);
  const halfFilled = touched && parsed === null && (hour === '') !== (minute === '');
  const outOfRange =
    touched &&
    parsed === null &&
    hour !== '' &&
    minute !== '' &&
    (Number(hour) > 23 || Number(minute) > 59);

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          className="input w-[4.5rem] px-2 text-center"
          aria-label={ariaLabel ? `${ariaLabel}（小时）` : '小时'}
          placeholder={placeholder.slice(0, 2)}
          maxLength={2}
          value={hour}
          onPaste={(e) => {
            if (handlePaste(e.clipboardData.getData('text'), 'hour')) e.preventDefault();
          }}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, '').slice(0, 2);
            setHour(next);
            // 单数字仍在输入中，不把 "1" 提前写成 "01" 传给父表单。
            if (next.length !== 1) emit(next, minute);
            if (next.length === 2 && Number(next) <= 23) minuteRef.current?.focus();
          }}
          onBlur={(e) => {
            setTouched(true);
            // 单数字补零：9 → 09
            // 自动聚焦分钟会同步触发失焦；此处必须读输入框当前值，
            // 不能读上一次渲染的 hour（可能仍为 "1"，从而把 "12" 覆盖成 "01"）。
            const current = e.currentTarget.value;
            const padded = current === '' ? '' : current.padStart(2, '0');
            if (padded !== current) {
              setHour(padded);
              emit(padded, minute);
            }
          }}
        />
        <span className="text-sm font-medium text-muted">:</span>
        <input
          ref={minuteRef}
          id={id ? `${id}-minute` : undefined}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          className="input w-[4.5rem] px-2 text-center"
          aria-label={ariaLabel ? `${ariaLabel}（分钟）` : '分钟'}
          placeholder={placeholder.slice(3, 5)}
          maxLength={2}
          value={minute}
          onPaste={(e) => {
            if (handlePaste(e.clipboardData.getData('text'), 'minute')) e.preventDefault();
          }}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, '').slice(0, 2);
            setMinute(next);
            if (next.length !== 1) emit(hour, next);
          }}
          onBlur={(e) => {
            setTouched(true);
            const current = e.currentTarget.value;
            const padded = current === '' ? '' : current.padStart(2, '0');
            if (padded !== current) {
              setMinute(padded);
              emit(hour, padded);
            }
          }}
        />
      </div>
      {halfFilled ? (
        <p className="mt-1 text-xs text-red-500">小时和分钟都要填写，例如 13 和 27</p>
      ) : null}
      {outOfRange ? (
        <p className="mt-1 text-xs text-red-500">小时 0–23，分钟 0–59，请检查</p>
      ) : null}
    </div>
  );
}
