import { arcSegments, areaPath, niceMaxMinutes, scale, smoothPath, spread } from '../lib/chart';
import type { Point } from '../lib/chart';
import { lineColor } from '../lib/color';
import { dayLong, dayShort, formatMinutes, joinList, plural, weekdayLabel } from '../lib/format';
import type { DeviceStatus, ReportDay, WeekDay } from '../api/types';

const GRID = '#1a2247';
const AXIS_TEXT = '#8e9ac0';

interface ChartKid { id: string; name: string; color: string }

function axisLabel(minutes: number): string {
  if (minutes === 0) return '0';
  return minutes % 60 === 0 ? `${minutes / 60} h` : formatMinutes(minutes);
}

function dayLabels(days: string[]): string[] {
  return days.map((d, i) => (i === days.length - 1 ? 'Today' : weekdayLabel(d)));
}

/** Smooth multi-line chart of minutes per day, one line per kid. */
export function WeekChart({ week, kids, compact }: { week: WeekDay[]; kids: ChartKid[]; compact?: boolean }) {
  const W = compact ? 340 : 640;
  const top = 20, bottom = 200;
  let max = 0;
  for (const w of week) for (const k of kids) max = Math.max(max, w.minutes[k.id] ?? 0);
  const yMax = niceMaxMinutes(max);
  const xs = spread(week.length, compact ? 50 : 60, W - (compact ? 18 : 28));
  const labels = dayLabels(week.map((w) => w.day));
  const ticks = [0, 1, 2, 3, 4].map((i) => ({ y: top + ((bottom - top) * i) / 4, v: yMax - (yMax * i) / 4 }));
  const series = kids.map((k) => ({
    kid: k,
    color: lineColor(k.color),
    pts: week.map<Point>((w, i) => ({ x: xs[i] ?? 0, y: scale(w.minutes[k.id] ?? 0, 0, yMax, bottom, top) })),
  }));
  const names = joinList(kids.map((k) => k.name));

  return (
    <>
      <svg viewBox={`0 0 ${W} 232`} role="img" aria-label={`Line chart of daily screen time this week for ${names}`} style={{ width: '100%', height: 'auto' }}>
        {ticks.map((t) => (
          <g key={t.y}>
            <line x1="34" y1={t.y} x2={W} y2={t.y} stroke={GRID} strokeDasharray="3 4" />
            <text x="0" y={t.y + 4} fill={AXIS_TEXT} fontSize="11">{axisLabel(t.v)}</text>
          </g>
        ))}
        {series[0] && series[0].pts.length > 1 && (
          <path d={areaPath(series[0].pts, bottom)} fill={series[0].color} fillOpacity="0.14" />
        )}
        {series.map((s) => (
          s.pts.length === 1
            ? <circle key={s.kid.id} cx={s.pts[0]!.x} cy={s.pts[0]!.y} r="4" fill={s.color} />
            : <path key={s.kid.id} d={smoothPath(s.pts)} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinecap="round" />
        ))}
        {labels.map((l, i) => (
          <text key={i} x={xs[i]} y="226" fill={AXIS_TEXT} fontSize="11" textAnchor="middle">{compact && l === 'Today' ? 'Now' : l}</text>
        ))}
      </svg>
      <table className="sr-only">
        <caption>Minutes of screen time per day this week</caption>
        <thead><tr><th scope="col">Day</th>{kids.map((k) => <th key={k.id} scope="col">{k.name}</th>)}</tr></thead>
        <tbody>
          {week.map((w) => (
            <tr key={w.day}><th scope="row">{dayLong(w.day)}</th>{kids.map((k) => <td key={k.id}>{formatMinutes(w.minutes[k.id] ?? 0)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** The small straight-line sparkline under "Time left today". */
export function MiniLines({ week, kids }: { week: WeekDay[]; kids: ChartKid[] }) {
  let max = 1;
  for (const w of week) for (const k of kids) max = Math.max(max, w.minutes[k.id] ?? 0);
  const xs = spread(week.length, 2, 258);
  return (
    <svg viewBox="0 0 260 70" role="img" preserveAspectRatio="none"
      aria-label={`Screen time over the last ${plural(week.length, 'day', 'days')} for ${joinList(kids.map((k) => k.name))}`}
      style={{ width: '100%', height: 70 }}>
      {kids.map((k) => (
        <polyline key={k.id} fill="none" stroke={lineColor(k.color)} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          points={week.map((w, i) => `${xs[i]},${scale(w.minutes[k.id] ?? 0, 0, max, 64, 8).toFixed(1)}`).join(' ')} />
      ))}
    </svg>
  );
}

export const STATUS_COLOR: Record<DeviceStatus, { arc: string; dot: string; label: string }> = {
  in_use: { arc: '#1f6f56', dot: '#1f9f78', label: 'In use' },
  locked: { arc: '#4f61b8', dot: '#6f82de', label: 'Locked' },
  off: { arc: '#2a3350', dot: '#4a557c', label: 'Off' },
};

const ARC = 'M20 112 A90 90 0 0 1 200 112';
const ARC_LEN = Math.PI * 90;

export function HalfDonut({ inUse, locked, off }: { inUse: number; locked: number; off: number }) {
  const segs = arcSegments([inUse, locked, off], ARC_LEN);
  const colors = [STATUS_COLOR.in_use.arc, STATUS_COLOR.locked.arc, STATUS_COLOR.off.arc];
  const total = inUse + locked + off;
  const label = total === 0
    ? 'No devices yet'
    : `${plural(inUse, 'device', 'devices')} in use, ${locked} locked, ${off} off`;
  return (
    <svg viewBox="0 0 220 120" role="img" aria-label={label} style={{ width: '100%', maxWidth: 240, alignSelf: 'center' }}>
      {total === 0 && <path d={ARC} fill="none" stroke="#121938" strokeWidth="34" />}
      {segs.map((s, i) => s.length > 0 && (
        <path key={i} d={ARC} fill="none" stroke={colors[i]} strokeWidth="34"
          strokeDasharray={`${s.length} ${Math.ceil(ARC_LEN) + 40}`} strokeDashoffset={-s.offset} />
      ))}
      <text x="110" y="100" textAnchor="middle" fill="#eef1fb" fontSize="26" fontWeight="600" fontFamily="'Space Grotesk', sans-serif">{total}</text>
      <text x="110" y="116" textAnchor="middle" fill={AXIS_TEXT} fontSize="11">{total === 1 ? 'device' : 'devices'}</text>
    </svg>
  );
}

export function Lollipop({ days }: { days: { day: string; count: number }[] }) {
  const base = 150, top = 60;
  const max = Math.max(1, ...days.map((d) => d.count));
  const xs = spread(days.length, 24, 252);
  const labels = dayLabels(days.map((d) => d.day));
  const total = days.reduce((a, d) => a + d.count, 0);
  return (
    <svg viewBox="0 0 276 176" role="img" style={{ width: '100%', height: 'auto' }}
      aria-label={`Blocked website tries per day this week, ${total} in total. ${days.map((d, i) => `${labels[i]} ${d.count}`).join(', ')}`}>
      <line x1="0" y1={base} x2="276" y2={base} stroke={GRID} />
      <line x1="0" y1={top} x2="276" y2={top} stroke={GRID} strokeDasharray="3 4" />
      <line x1="0" y1={(top + base) / 2} x2="276" y2={(top + base) / 2} stroke={GRID} strokeDasharray="3 4" />
      {days.map((d, i) => {
        const x = xs[i] ?? 0;
        const y = scale(d.count, 0, max, base, top);
        return (
          <g key={d.day}>
            {d.count > 0 && <line x1={x} y1={y} x2={x} y2={base} stroke="#8fa0ee" strokeWidth="3" />}
            <circle cx={x} cy={y} r="5" fill="#04060f" stroke={d.count > 0 ? '#c9d1f2' : '#4a557c'} strokeWidth="2" />
            {d.count > 0 && <text x={x} y={y - 11} fill="#c9d1f2" fontSize="11" textAnchor="middle">{d.count}</text>}
            <text x={x} y="170" fill={AXIS_TEXT} fontSize="11" textAnchor="middle">{labels[i]}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Per-day bars for the reports page (7 or 30 days). */
export function DayBars({ days, color, selected }: { days: ReportDay[]; color: string; selected?: string | null }) {
  const top = 20, bottom = 180, left = 40, right = 636;
  const yMax = niceMaxMinutes(Math.max(0, ...days.map((d) => d.minutes)));
  const n = Math.max(1, days.length);
  const slot = (right - left) / n;
  const w = Math.min(46, slot * 0.66);
  const every = n > 10 ? Math.ceil(n / 6) : 1;
  const ticks = [0, 1, 2, 3, 4].map((i) => ({ y: top + ((bottom - top) * i) / 4, v: yMax - (yMax * i) / 4 }));
  const fill = lineColor(color);
  return (
    <svg viewBox="0 0 640 206" role="img" style={{ width: '100%', height: 'auto', minWidth: 300 }}
      aria-label={`Bar chart of screen time per day for the last ${plural(days.length, 'day', 'days')}`}>
      {ticks.map((t) => (
        <g key={t.y}>
          <line x1="34" y1={t.y} x2="640" y2={t.y} stroke={GRID} strokeDasharray={t.v === 0 ? undefined : '3 4'} />
          <text x="0" y={t.y + 4} fill={AXIS_TEXT} fontSize="11">{axisLabel(t.v)}</text>
        </g>
      ))}
      {days.map((d, i) => {
        const cx = left + slot * (i + 0.5);
        const y = scale(d.minutes, 0, yMax, bottom, top);
        const dim = selected != null && selected !== d.day;
        return (
          <g key={d.day}>
            <rect x={cx - w / 2} y={y} width={w} height={Math.max(0, bottom - y)} rx={Math.min(3, w / 2)} fill={fill} opacity={dim ? 0.35 : 1}>
              <title>{`${dayLong(d.day)}: ${formatMinutes(d.minutes)}`}</title>
            </rect>
            {(n <= 10 || i % every === (n - 1) % every) && (
              <text x={cx} y="200" fill={AXIS_TEXT} fontSize="11" textAnchor="middle">
                {n <= 10 ? (i === n - 1 ? 'Today' : weekdayLabel(d.day)) : dayShort(d.day)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
