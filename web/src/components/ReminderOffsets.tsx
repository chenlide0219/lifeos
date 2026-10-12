/**
 * 微信提醒提前量：与手动表单一致的六档多选。
 * 手动新增、语音确认共用同一份选项与交互，避免两处入口行为不一致。
 */

export const KNOWN_OFFSETS: { minutes: number; label: string }[] = [
  { minutes: 1440, label: '提前 1 天' },
  { minutes: 120, label: '提前 2 小时' },
  { minutes: 60, label: '提前 1 小时' },
  { minutes: 30, label: '提前 30 分钟' },
  { minutes: 10, label: '提前 10 分钟' },
  { minutes: 5, label: '提前 5 分钟' },
];

/** 模型可能识别出六档之外的提前量（如 90 分钟），同样要能显示和保留 */
export function formatOffset(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `提前 ${minutes / 1440} 天`;
  if (minutes >= 60 && minutes % 60 === 0) return `提前 ${minutes / 60} 小时`;
  return `提前 ${minutes} 分钟`;
}

export function OffsetChips({
  selected,
  onToggle,
}: {
  selected: number[];
  onToggle: (minutes: number) => void;
}) {
  const extra = selected
    .filter((m) => !KNOWN_OFFSETS.some((k) => k.minutes === m))
    .sort((a, b) => b - a)
    .map((m) => ({ minutes: m, label: formatOffset(m) }));
  const chips = [...KNOWN_OFFSETS, ...extra];

  return (
    <div className="flex flex-wrap gap-2">
      {chips.map(({ minutes, label }) => (
        <button
          key={minutes}
          type="button"
          onClick={() => onToggle(minutes)}
          aria-pressed={selected.includes(minutes)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            selected.includes(minutes)
              ? 'border-brand/30 bg-brand/10 text-brand'
              : 'border-line text-muted hover:text-ink'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
