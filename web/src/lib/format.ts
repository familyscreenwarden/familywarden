/** 78 -> "1 h 18 min", 120 -> "2 h", 48 -> "48 min". */
export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(Number.isFinite(total) ? total : 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  if (r === 0) return `${h} h`;
  return `${h} h ${r} min`;
}

/** Minutes left as a clock: 42 -> "0:42", 135 -> "2:15". */
export function formatLeft(total: number): string {
  const m = Math.max(0, Math.round(Number.isFinite(total) ? total : 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** For limit pickers: 120 -> "2 hours", 90 -> "1 h 30 min", 30 -> "30 minutes". */
export function formatLimitOption(m: number): string {
  if (m % 60 === 0) return m === 60 ? '1 hour' : `${m / 60} hours`;
  if (m < 60) return `${m} minutes`;
  return formatMinutes(m);
}

/** 'HH:MM' (24 h) -> "8:30 pm". Returns the input when it is not a clock time. */
export function formatClock(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!match) return hhmm;
  const h = Number(match[1]);
  const min = match[2];
  if (h > 23) return hhmm;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${min} ${h < 12 ? 'am' : 'pm'}`;
}

/** 'HH:MM' -> "8:30" (12-hour, no am/pm), as on the bedtime card. */
export function formatClockShort(hhmm: string): string {
  return formatClock(hhmm).replace(/ (am|pm)$/, '');
}

export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const mins = Math.floor((now.getTime() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** 'YYYY-MM-DD' -> "Tue". Calendar days are handled in UTC so no zone can shift them. */
export function weekdayLabel(day: string): string {
  const d = parseDay(day);
  return d ? WEEKDAYS[d.getUTCDay()] ?? day : day;
}

/** 'YYYY-MM-DD' -> "Tue, Nov 3". */
export function dayLong(day: string): string {
  const d = parseDay(day);
  if (!d) return day;
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** 'YYYY-MM-DD' -> "Nov 3". */
export function dayShort(day: string): string {
  const d = parseDay(day);
  return d ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : day;
}

export function percent(used: number, limit: number): number {
  if (!(limit > 0)) return used > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
