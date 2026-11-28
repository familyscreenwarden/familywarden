/**
 * The live map's logic with no database (tested on its own, test/location.test.ts): distances, arriving at and
 * leaving places, which map tile a point is on.
 */

export interface PlaceLike {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Meters. */
  radius: number;
}

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number | null;
  at: Date;
}

export type CheckInKind = 'ok' | 'pickup' | 'help';
export const CHECKIN_KINDS: readonly CheckInKind[] = ['ok', 'pickup', 'help'];
export const CHECKIN_TEXT: Record<CheckInKind, string> = { ok: 'I’m here and I’m OK', pickup: 'Please come get me', help: 'I need help now' };

/** How long a kid's trail may be kept, in days. A parent picks one per kid. */
export const KEEP_DAYS = [1, 30, 90] as const;
export type KeepDays = (typeof KEEP_DAYS)[number];
export const DEFAULT_KEEP_DAYS: KeepDays = 30;

export function round(x: number, digits: number): number {
  return Math.round(x * 10 ** digits) / 10 ** digits;
}

/** Meters between two points (haversine). */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371_000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface PlaceEvent<P extends PlaceLike> {
  kind: 'arrive' | 'leave';
  place: P;
}

/**
 * Which places a fix is in, and the arrive / leave events since the last one.
 * Arriving needs the point inside the circle (and a fix good to 250 m). Leaving needs it clearly outside: past the
 * circle by 50 m or the fix's accuracy, whichever is more, so a wobbly GPS at the edge does not say "left, arrived, left".
 */
export function placeChanges<P extends PlaceLike>(fix: Fix, places: P[], insideBefore: Set<string>): { inside: string[]; events: Array<PlaceEvent<P>> } {
  const acc = fix.accuracy ?? 30;
  const inside: string[] = [];
  const events: Array<PlaceEvent<P>> = [];
  const edge = (p: P): number => distanceM(fix.lat, fix.lng, p.lat, p.lng) - p.radius;
  const sorted = [...places].sort((a, b) => edge(a) - edge(b));
  for (const p of sorted) {
    const d = distanceM(fix.lat, fix.lng, p.lat, p.lng);
    if (insideBefore.has(p.id)) {
      if (d > p.radius + Math.max(50, Math.min(acc, 500))) events.push({ kind: 'leave', place: p });
      else inside.push(p.id);
    } else if (d <= p.radius && acc <= 250) {
      events.push({ kind: 'arrive', place: p });
      inside.push(p.id);
    }
  }
  return { inside, events };
}

/** True when z/x/y name a tile that exists (zoom 0 to 19). */
export function validTile(z: number, x: number, y: number): boolean {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19) return false;
  const n = 2 ** z;
  return x >= 0 && y >= 0 && x < n && y < n;
}

/** The address of one tile from a template with {z}, {x} and {y} (and, for sources that have them, {s}: a, b or c). */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace(/\{s\}/g, ['a', 'b', 'c'][(x + y) % 3] ?? 'a')
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y));
}

/** A tile template must be an http(s) address with {z}, {x} and {y} in it. */
export function isTileTemplate(template: string): boolean {
  if (!/\{z\}/.test(template) || !/\{x\}/.test(template) || !/\{y\}/.test(template)) return false;
  try {
    const u = new URL(tileUrl(template, 1, 0, 0));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** What kind of picture a tile is, by its first bytes (null: not a picture we pass on). */
export function tileType(head: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** A fix's time as the phone gave it, when that is within an hour of now; otherwise now. */
export function fixTime(at: unknown, now: Date): Date {
  if (typeof at === 'string' && at.length <= 40) {
    const t = Date.parse(at);
    if (!Number.isNaN(t) && Math.abs(t - now.getTime()) < 3600_000) return new Date(t);
  }
  return new Date(now.getTime());
}
