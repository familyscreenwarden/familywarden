// Words and small sums for the Map page. Pure functions, tested in map.test.ts.
import type { CheckInKind, MapCheckIn, MapKid } from '../api/types';
import { timeAgo } from './format';

export const CHECKIN_TEXT: Record<CheckInKind, string> = {
  ok: 'I’m here and I’m OK',
  pickup: 'Please come get me',
  help: 'I need help now',
};

/** Where a kid is, in a few words: the place, or that there is nothing to show and why. */
export function whereText(k: Pick<MapKid, 'sharing' | 'last'>): string {
  if (!k.last) return k.sharing ? 'No position yet' : 'Sharing is off';
  const where = k.last.place ? `At ${k.last.place.name}` : 'On the map';
  return k.sharing ? where : `${where} (sharing is off now)`;
}

/** When the position is from: "just now", "5 minutes ago". */
export function whenText(k: Pick<MapKid, 'last'>, now: Date = new Date()): string {
  return k.last ? timeAgo(k.last.at, now) : '';
}

/** How exact a position is: "within about 20 m", rounded so it does not look more exact than it is. */
export function accuracyText(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters) || meters < 0) return 'accuracy unknown';
  if (meters < 10) return 'within about 10 m';
  if (meters < 1000) return `within about ${Math.round(meters / 10) * 10} m`;
  return `within about ${(meters / 1000).toFixed(1)} km`;
}

export function batteryText(battery: number | null, charging: boolean | null): string {
  if (battery === null) return '';
  return `Battery ${battery}%${charging ? ', charging' : ''}`;
}

/** "Please come get me" and "I need help now" that no parent has answered yet, newest first. */
export function openCheckIns(checkins: MapCheckIn[]): MapCheckIn[] {
  return checkins.filter((c) => c.kind !== 'ok' && !c.answeredAt);
}

/** A kid's newest "I'm OK" of the last three hours, if there is one. */
export function recentOk(checkins: MapCheckIn[], kidId: string, now: Date = new Date()): MapCheckIn | null {
  return checkins.find((c) => c.kidId === kidId && c.kind === 'ok' && now.getTime() - Date.parse(c.at) < 3 * 3600_000) ?? null;
}

/** "3:05 pm" in the browser's own time zone. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** The address to ask a failed tile from again (the same tile, with a counter so the browser really asks). */
export function tileRetryUrl(src: string, tries: number): string {
  return `${src.replace(/[?&]r=\d+$/, '')}?r=${tries}`;
}

/** The corners of the box that holds every point: [[south, west], [north, east]], or null without points. */
export function boundsOf(points: Array<[number, number]>): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  let s = 90, w = 180, n = -90, e = -180;
  for (const [lat, lng] of points) {
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
  }
  return [[s, w], [n, e]];
}

/** Text that is safe to put into the map's own markup. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The credit line of the map: the tile source's words, as a link when it has an http(s) address. */
export function attributionHtml(text: string, url: string): string {
  if (!text) return '';
  return /^https?:\/\//i.test(url) ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(text)}</a>` : escapeHtml(text);
}

export const KEEP_LABEL: Record<number, string> = { 1: '1 day', 30: '30 days', 90: '90 days' };
