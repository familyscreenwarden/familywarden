/**
 * Pure helpers for the kid-device API (the /api/warden and /api/android routes the kids' apps speak).
 * No database, no clock: everything here is unit-tested in test/compat.test.ts.
 */
import crypto from 'node:crypto';
import { addDays, isSchoolNight, localTime, parseClock, type RuleKid } from '../rules';

// ---------------------------------------------------------------- the app's identity

/** The kids' Android app and its device-admin receiver (Android's setup needs both in the QR code). */
export const KIDS_PACKAGE = 'com.familyscreenwarden.kids';
export const KIDS_ADMIN = `${KIDS_PACKAGE}/.admin.KidsAdminReceiver`;
/** The link scheme the installed app opens from the quick-install page (screenwarden://setup?server=…&code=…). */
export const KIDS_SCHEME = 'screenwarden';

// ---------------------------------------------------------------- time

/** The instant at which the wall clock in `timeZone` shows `day` + `clock` ('YYYY-MM-DD', 'HH:MM'). */
export function zonedToUtc(day: string, clock: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const minutes = parseClock(clock);
  const guess = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, minutes);
  const offsetAt = (ms: number): number => {
    const lt = localTime(new Date(ms), timeZone);
    const [ly, lm, ld] = lt.day.split('-').map(Number);
    return Date.UTC(ly ?? 1970, (lm ?? 1) - 1, ld ?? 1, 0, lt.minutes) - ms;
  };
  const first = offsetAt(guess);
  let at = guess - first;
  const second = offsetAt(at);
  // Around a clock change the first guess can sit on the other side of it.
  if (second !== first) at = guess - second;
  return new Date(at);
}

/** When the family's day ends: the next midnight in their time zone. */
export function nextLocalMidnight(now: Date, timeZone: string): Date {
  return zonedToUtc(addDays(localTime(now, timeZone).day, 1), '00:00', timeZone);
}

export interface BedtimeInstants {
  at: Date;
  until: Date;
}

/**
 * The bedtime window that matters now, as two instants: the one we are inside, else the next one to start.
 * Follows the same reading of start/end as the rule engine (rules.ts, windowActive). Null when bedtime is off
 * or the window is empty.
 */
export function bedtimeInstants(kid: RuleKid, now: Date, timeZone: string): BedtimeInstants | null {
  if (!kid.bedtimeEnabled) return null;
  const today = localTime(now, timeZone);
  for (let delta = -1; delta <= 1; delta++) {
    const evening = addDays(today.day, delta);
    const weekday = (today.weekday + delta + 7) % 7;
    const school = isSchoolNight(weekday);
    const start = school ? kid.bedSchoolStart : kid.bedOtherStart;
    const end = school ? kid.bedSchoolEnd : kid.bedOtherEnd;
    const s = parseClock(start);
    const e = parseClock(end);
    if (s === e) continue;
    let at: Date;
    let until: Date;
    if (s > e) {
      at = zonedToUtc(evening, start, timeZone);
      until = zonedToUtc(addDays(evening, 1), end, timeZone);
    } else if (s >= 12 * 60) {
      at = zonedToUtc(evening, start, timeZone);
      until = zonedToUtc(evening, end, timeZone);
    } else {
      at = zonedToUtc(addDays(evening, 1), start, timeZone);
      until = zonedToUtc(addDays(evening, 1), end, timeZone);
    }
    if (until.getTime() > now.getTime()) return { at, until };
  }
  return null;
}

/** '20:30' → '8:30 pm'. */
export function clock12(value: string): string {
  const total = parseClock(value);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

// ---------------------------------------------------------------- apps

const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

/** An Android package name such as com.example.app. */
export function isPackageName(value: string): boolean {
  return value.length <= 200 && PACKAGE_RE.test(value);
}

/** "Toca Boca World" → "toca-boca-world". Two names with the same slug are taken to be the same app. */
export function appSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export type AppCategory = 'game' | 'school' | 'browser' | 'video' | 'other';

const CATEGORY_WORDS: Array<[AppCategory, RegExp]> = [
  ['browser', /\b(chrome|firefox|browser|opera|edge|duckduckgo|brave)\b/],
  ['video', /\b(youtube|netflix|disney|hulu|twitch|prime video|pbs kids video|video|tv)\b/],
  ['school', /\b(khan|duolingo|classroom|scratch|school|math|learn|learning|reading|abc|prodigy|quizlet|docs|kindle)\b/],
  ['game', /\b(game|games|minecraft|roblox|lego|pokemon|mario|chess|puzzle|toca|racing|clash|fortnite|among us)\b/],
];

/** A first guess at where an app belongs on the launcher. A parent's eyes are still the real check. */
export function guessCategory(name: string, identifier: string): AppCategory {
  const text = `${name} ${identifier.replace(/[._]/g, ' ')}`.toLowerCase();
  for (const [category, re] of CATEGORY_WORDS) if (re.test(text)) return category;
  return 'other';
}

// ---------------------------------------------------------------- phone numbers

/** The part of a number that identifies it: its digits, the last 10 when there are more ("+1 555…" = "555…"). */
export function numKey(phone: string): string {
  const digits = String(phone ?? '').replace(/[^0-9]/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** "5550102231" → "(555) 010-2231"; anything else is shown as it is. */
export function prettyNumber(num: string): string {
  return num.length === 10 ? `(${num.slice(0, 3)}) ${num.slice(3, 6)}-${num.slice(6)}` : num;
}

// ---------------------------------------------------------------- emergency unlock codes

/** Code n is HMAC-SHA256(secret, "unlock:" + n), first 4 bytes big-endian, mod 1e8, zero-padded. The app checks it offline. */
export function unlockCode(secretBase64: string, counter: number): string {
  const mac = crypto.createHmac('sha256', Buffer.from(secretBase64, 'base64')).update(`unlock:${counter}`, 'utf8').digest();
  return String(mac.readUInt32BE(0) % 100_000_000).padStart(8, '0');
}

// ---------------------------------------------------------------- app versions and the setup QR

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function isVersion(value: string): boolean {
  return value.length <= 32 && VERSION_RE.test(value);
}

/** True when version a is newer than version b (1.10.0 is newer than 1.9.3). */
export function newerVersion(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p > q;
  }
  return false;
}

/** Android's setup wants a SHA-256 as URL-safe base64 without padding. */
export function apkChecksum(sha256Hex: string): string {
  return Buffer.from(sha256Hex, 'hex').toString('base64url');
}

/**
 * The signing certificate's SHA-256 as Android's setup wants it (URL-safe base64, no padding), from what a
 * publisher may send: that form, ordinary base64, or hex with or without colons. Null when it is not 32 bytes.
 */
export function normalizeSignatureChecksum(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const hex = v.replace(/:/g, '');
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) bytes = Buffer.from(hex, 'hex');
  else if (/^[A-Za-z0-9_\-+/]{43}=?$/.test(v)) bytes = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  else return null;
  return bytes.length === 32 ? bytes.toString('base64url') : null;
}

export interface WifiDetails {
  ssid: string;
  password?: string | null;
  security: 'WPA' | 'WEP' | 'NONE';
}

/** The JSON Android's setup screen reads from the QR code (tap the welcome screen 6 times after a factory reset). */
export function provisioningPayload(o: {
  server: string;
  code: string;
  version: string;
  sha256: string;
  /** The signing certificate's checksum (base64url), when the publisher sent one. */
  signatureChecksum?: string | null;
  wifi?: WifiDetails | null;
}): Record<string, unknown> {
  // Android checks the download against ONE checksum. The signing certificate's is used when it is known (it is the
  // same for every version signed with the family of keys); otherwise the checksum of the file itself.
  const check: Record<string, unknown> = o.signatureChecksum
    ? { 'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': o.signatureChecksum }
    : { 'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM': apkChecksum(o.sha256) };
  const p: Record<string, unknown> = {
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': KIDS_ADMIN,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': `${o.server}/api/android/download?v=${encodeURIComponent(o.version)}`,
    ...check,
    'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
    // What the app reads once it is on the phone: where its server is, and the setup code.
    'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { server: o.server, code: o.code },
  };
  if (o.wifi?.ssid) {
    p['android.app.extra.PROVISIONING_WIFI_SSID'] = o.wifi.ssid;
    p['android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE'] = o.wifi.security;
    if (o.wifi.password && o.wifi.security !== 'NONE') p['android.app.extra.PROVISIONING_WIFI_PASSWORD'] = o.wifi.password;
  }
  return p;
}

// ---------------------------------------------------------------- chores

export type ChoreRepeat = 'once' | 'daily' | 'weekly';
export type ChoreShown = 'todo' | 'waiting' | 'done' | 'hidden';

/** The first day of the stretch in which a chore can be done once: today, this week's Monday, or (once) no start. */
export function choreWindowStart(repeat: ChoreRepeat, today: string): string | null {
  if (repeat === 'daily') return today;
  if (repeat === 'weekly') {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    return addDays(today, -((weekday + 6) % 7));
  }
  return null;
}

export interface ChoreMark {
  /** The day the kid marked it done. */
  day: string;
  status: 'pending' | 'approved' | 'declined';
  /** The day a parent answered, when they have. */
  decidedDay: string | null;
}

/**
 * What the kid's launcher shows for a chore today.
 * - waiting: marked done, a parent has not answered yet (whenever it was marked);
 * - done: approved in the current stretch (today / this week). A one-time chore shows "done" on the day it was
 *   approved and is hidden afterwards;
 * - todo: not done in this stretch, or the last try was declined.
 */
export function choreShown(repeat: ChoreRepeat, today: string, marks: ChoreMark[]): ChoreShown {
  if (marks.some((m) => m.status === 'pending')) return 'waiting';
  const approved = marks.filter((m) => m.status === 'approved');
  if (repeat === 'once') {
    if (approved.length === 0) return 'todo';
    return approved.some((m) => m.day === today || m.decidedDay === today) ? 'done' : 'hidden';
  }
  const start = choreWindowStart(repeat, today) ?? today;
  return approved.some((m) => m.day >= start && m.day <= today) ? 'done' : 'todo';
}

// ---------------------------------------------------------------- requests, as the apps read them

export interface WireRequest {
  id: string;
  exe: string;
  name: string;
  status: 'pending' | 'allowed' | 'denied';
}

/** A Warden request in the shape the apps read in their sync answer (`requests[]`). */
export function wireRequest(r: {
  id: string;
  kind: string;
  minutes: number | null;
  detail: string;
  identifier: string | null;
  status: string;
}): WireRequest {
  const status = r.status === 'approved' ? 'allowed' : r.status === 'denied' ? 'denied' : 'pending';
  if (r.kind === 'time') {
    const m = r.minutes ?? 15;
    return { id: r.id, exe: `time:${m}`, name: `${m} more minutes`, status };
  }
  if (r.kind === 'site') {
    const host = r.identifier ?? r.detail;
    return { id: r.id, exe: `site:${host}`, name: `Website: ${host}`, status };
  }
  return { id: r.id, exe: r.identifier ?? `app:${r.detail.toLowerCase()}`, name: r.detail || r.identifier || 'App', status };
}
