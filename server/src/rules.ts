/**
 * Rule evaluation. Pure: the same input always gives the same output, no database, no clock.
 * Everything is worked out in the family's time zone.
 */

export type LockReason = 'paused' | 'parent' | 'bedtime' | 'time' | null;

export interface LocalTime {
  /** Calendar day in the family's time zone, 'YYYY-MM-DD'. */
  day: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes since local midnight (0–1439). */
  minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock day, weekday and minute of `now` in `timeZone`. */
export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = formatterFor(timeZone).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = WEEKDAYS[get('weekday')];
  if (weekday === undefined) throw new Error(`Could not read the weekday for time zone ${timeZone}`);
  const hour = Number(get('hour')) % 24;
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    weekday,
    minutes: hour * 60 + Number(get('minute')),
  };
}

/** Adds (or subtracts) whole days to a 'YYYY-MM-DD' day. */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + delta));
  return date.toISOString().slice(0, 10);
}

/** The last `count` days ending with `today`, oldest first. */
export function lastDays(today: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

export function isClock(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** 'HH:MM' → minutes since midnight. */
export function parseClock(value: string): number {
  if (!isClock(value)) throw new Error(`Not a clock time: ${value}`);
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

/** Monday to Friday. */
export function isSchoolDay(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

/** The night that starts on `weekday` is a school night when the next day is a school day (Sunday to Thursday). */
export function isSchoolNight(weekday: number): boolean {
  return weekday >= 0 && weekday <= 4;
}

export interface RuleKid {
  limitSchoolMinutes: number;
  limitWeekendMinutes: number;
  bedSchoolStart: string;
  bedSchoolEnd: string;
  bedOtherStart: string;
  bedOtherEnd: string;
  bedtimeEnabled: boolean;
  locked: boolean;
}

export interface RuleApp {
  id: string;
  free: boolean;
  limitMinutes: number | null;
}

export interface RuleUsage {
  /** null = usage that is not tied to a known app; it always counts. */
  appId: string | null;
  minutes: number;
}

export interface RuleInput {
  now: Date;
  timezone: string;
  pausedAll: boolean;
  kid: RuleKid;
  /** Sum of today's time grants. */
  grantMinutes: number;
  apps: RuleApp[];
  /** Today's usage rows over all devices. */
  usage: RuleUsage[];
}

export interface BedtimeWindow {
  enabled: boolean;
  start: string;
  end: string;
}

export interface RuleResult {
  day: string;
  schoolDay: boolean;
  limitMinutes: number;
  usedMinutes: number;
  leftMinutes: number;
  locked: boolean;
  lockReason: LockReason;
  /** The window in force right now, or else the one that starts this evening. */
  bedtime: BedtimeWindow;
  inBedtime: boolean;
  /** Per app id: minutes used today over all devices, and whether its own limit is used up. */
  apps: Record<string, { usedMinutes: number; usedUp: boolean }>;
}

type Role = 'tonight' | 'lastNight';

/**
 * Is the clock (`t`, minutes since midnight) inside a bedtime window?
 * - start later than end (20:30 → 06:00): crosses midnight. This evening's window covers t >= start;
 *   last night's window covers t < end.
 * - start earlier than end, start in the afternoon/evening (19:00 → 23:00): all inside this evening.
 * - start earlier than end, start before noon (00:30 → 06:00): starts after midnight, so it belongs to last night.
 * - start equal to end: empty, never active.
 */
function windowActive(start: string, end: string, role: Role, t: number): boolean {
  const s = parseClock(start);
  const e = parseClock(end);
  if (s === e) return false;
  if (s > e) return role === 'tonight' ? t >= s : t < e;
  if (s >= 12 * 60) return role === 'tonight' && t >= s && t < e;
  return role === 'lastNight' && t >= s && t < e;
}

function windowFor(kid: RuleKid, school: boolean): { start: string; end: string } {
  return school
    ? { start: kid.bedSchoolStart, end: kid.bedSchoolEnd }
    : { start: kid.bedOtherStart, end: kid.bedOtherEnd };
}

/** Which bedtime window matters at local time `local`, and whether the clock is inside it. Ignores `bedtimeEnabled`. */
export function bedtimeAt(kid: RuleKid, local: LocalTime): { start: string; end: string; active: boolean } {
  const yesterday = (local.weekday + 6) % 7;
  const lastNight = windowFor(kid, isSchoolNight(yesterday));
  if (windowActive(lastNight.start, lastNight.end, 'lastNight', local.minutes)) return { ...lastNight, active: true };
  const tonight = windowFor(kid, isSchoolNight(local.weekday));
  return { ...tonight, active: windowActive(tonight.start, tonight.end, 'tonight', local.minutes) };
}

export function evaluateRules(input: RuleInput): RuleResult {
  const local = localTime(input.now, input.timezone);
  const schoolDay = isSchoolDay(local.weekday);
  const kid = input.kid;

  const freeApps = new Set<string>();
  const apps: Record<string, { usedMinutes: number; usedUp: boolean }> = {};
  for (const app of input.apps) {
    if (app.free) freeApps.add(app.id);
    apps[app.id] = { usedMinutes: 0, usedUp: false };
  }

  let used = 0;
  for (const row of input.usage) {
    const minutes = Math.max(0, Math.floor(row.minutes));
    if (row.appId !== null) {
      const entry = apps[row.appId];
      if (entry) entry.usedMinutes += minutes;
      if (freeApps.has(row.appId)) continue;
    }
    used += minutes;
  }
  for (const app of input.apps) {
    const entry = apps[app.id];
    if (entry && app.limitMinutes !== null) entry.usedUp = entry.usedMinutes >= app.limitMinutes;
  }

  const base = schoolDay ? kid.limitSchoolMinutes : kid.limitWeekendMinutes;
  const limit = Math.max(0, base + Math.max(0, input.grantMinutes));
  const left = Math.max(0, limit - used);

  const bed = bedtimeAt(kid, local);
  const inBedtime = kid.bedtimeEnabled && bed.active;

  let lockReason: LockReason = null;
  if (input.pausedAll) lockReason = 'paused';
  else if (kid.locked) lockReason = 'parent';
  else if (inBedtime) lockReason = 'bedtime';
  else if (left === 0) lockReason = 'time';

  return {
    day: local.day,
    schoolDay,
    limitMinutes: limit,
    usedMinutes: used,
    leftMinutes: left,
    locked: lockReason !== null,
    lockReason,
    bedtime: { enabled: kid.bedtimeEnabled, start: bed.start, end: bed.end },
    inBedtime,
    apps,
  };
}

/** "45 min", "1 h", "2 h 5 min". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/** One short line a parent can read on the dashboard. `frontApp` is what a device in use is showing right now, if known. */
export function statusText(result: RuleResult, frontApp: string | null = null): string {
  switch (result.lockReason) {
    case 'paused':
      return 'Paused';
    case 'parent':
      return 'Locked by a parent';
    case 'bedtime':
      return `Bedtime until ${result.bedtime.end}`;
    case 'time':
      return 'Time is up. Family calls still work';
    default:
      return frontApp ? `Using ${frontApp}` : `${formatMinutes(result.leftMinutes)} left`;
  }
}
