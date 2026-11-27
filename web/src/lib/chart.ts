export interface Point { x: number; y: number }

const r = (n: number) => Math.round(n * 100) / 100;

/**
 * Tangents for a monotone cubic through the points (Fritsch-Carlson).
 * The curve never overshoots a data point, so a smooth line cannot dip
 * below zero between two days.
 */
export function monotoneTangents(pts: Point[]): number[] {
  const n = pts.length;
  if (n < 2) return pts.map(() => 0);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const dx = b.x - a.x;
    d.push(dx === 0 ? 0 : (b.y - a.y) / dx);
  }
  const m: number[] = [d[0]!];
  for (let i = 1; i < n - 1; i++) {
    const d0 = d[i - 1]!, d1 = d[i]!;
    m.push(d0 * d1 <= 0 ? 0 : (d0 + d1) / 2);
  }
  m.push(d[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    const di = d[i]!;
    if (di === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i]! / di, b = m[i + 1]! / di;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * di;
      m[i + 1] = t * b * di;
    }
  }
  return m;
}

/** SVG path data for a smooth line through the points. */
export function smoothPath(pts: Point[]): string {
  if (pts.length === 0) return '';
  const first = pts[0]!;
  if (pts.length === 1) return `M${r(first.x)} ${r(first.y)}`;
  const m = monotoneTangents(pts);
  let out = `M${r(first.x)} ${r(first.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const h = (b.x - a.x) / 3;
    out += ` C${r(a.x + h)} ${r(a.y + m[i]! * h)} ${r(b.x - h)} ${r(b.y - m[i + 1]! * h)} ${r(b.x)} ${r(b.y)}`;
  }
  return out;
}

/** The same line closed down to a baseline, for the soft fill under it. */
export function areaPath(pts: Point[], baselineY: number): string {
  if (pts.length < 2) return '';
  const first = pts[0]!, last = pts[pts.length - 1]!;
  return `${smoothPath(pts)} L${r(last.x)} ${r(baselineY)} L${r(first.x)} ${r(baselineY)} Z`;
}

/** Top of the minutes axis: whole hours, a multiple of 4 so five grid lines land on round values. */
export function niceMaxMinutes(maxValue: number, minHours = 4): number {
  const hours = Math.max(minHours, Math.ceil(Math.max(0, maxValue) / 60));
  return Math.ceil(hours / 4) * 4 * 60;
}

/** Linear scale; a zero-width domain maps to the start of the range. */
export function scale(v: number, d0: number, d1: number, r0: number, r1: number): number {
  if (d1 === d0) return r0;
  return r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** n evenly spaced x positions between x0 and x1 (a single point sits in the middle). */
export function spread(n: number, x0: number, x1: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [(x0 + x1) / 2];
  return Array.from({ length: n }, (_, i) => x0 + ((x1 - x0) * i) / (n - 1));
}

export interface ArcSegment { length: number; offset: number }

/**
 * Splits an arc of the given length into segments proportional to the
 * counts, with a small gap between neighbours. Zero counts get no segment.
 */
export function arcSegments(counts: number[], arcLength: number, gap = 3): ArcSegment[] {
  const total = counts.reduce((a, b) => a + Math.max(0, b), 0);
  const shown = counts.filter((c) => c > 0).length;
  if (total === 0) return counts.map(() => ({ length: 0, offset: 0 }));
  const usable = arcLength - gap * Math.max(0, shown - 1);
  let pos = 0;
  return counts.map((c) => {
    if (c <= 0) return { length: 0, offset: 0 };
    const length = (usable * c) / total;
    const seg = { length: r(length), offset: r(pos) };
    pos += length + gap;
    return seg;
  });
}
