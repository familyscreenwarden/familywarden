import { describe, expect, it } from 'vitest';
import { arcSegments, areaPath, monotoneTangents, niceMaxMinutes, scale, smoothPath, spread } from './chart';
import type { Point } from './chart';

/** Samples the cubic segments of a path produced by smoothPath. */
function sample(d: string): Point[] {
  const nums = d.replace(/[MC]/g, ' ').trim().split(/\s+/).map(Number);
  const out: Point[] = [];
  let p0 = { x: nums[0]!, y: nums[1]! };
  for (let i = 2; i + 5 < nums.length + 1; i += 6) {
    const c1 = { x: nums[i]!, y: nums[i + 1]! }, c2 = { x: nums[i + 2]!, y: nums[i + 3]! }, p1 = { x: nums[i + 4]!, y: nums[i + 5]! };
    for (let s = 0; s <= 20; s++) {
      const t = s / 20, u = 1 - t;
      out.push({
        x: u ** 3 * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * p1.x,
        y: u ** 3 * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * p1.y,
      });
    }
    p0 = p1;
  }
  return out;
}

describe('smoothPath', () => {
  it('handles no points and one point', () => {
    expect(smoothPath([])).toBe('');
    expect(smoothPath([{ x: 5, y: 7 }])).toBe('M5 7');
  });

  it('draws a straight line through two points', () => {
    expect(smoothPath([{ x: 0, y: 0 }, { x: 30, y: 60 }])).toBe('M0 0 C10 20 20 40 30 60');
  });

  it('passes through every data point', () => {
    const pts = [{ x: 60, y: 150 }, { x: 152, y: 110 }, { x: 244, y: 180 }, { x: 336, y: 60 }, { x: 428, y: 120 }];
    const d = smoothPath(pts);
    expect(d.startsWith('M60 150')).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(pts.length - 1);
    for (const p of pts.slice(1)) expect(d).toContain(` ${p.x} ${p.y}`);
  });

  it('never overshoots the data range (no dip below zero)', () => {
    const base = 200;
    const pts = [0, 0, 180, 0, 0, 150, 5].map((v, i) => ({ x: 60 + i * 92, y: base - v }));
    for (const s of sample(smoothPath(pts))) {
      expect(s.y).toBeLessThanOrEqual(base + 0.01);
      expect(s.y).toBeGreaterThanOrEqual(base - 180 - 0.01);
    }
  });

  it('keeps flat data flat', () => {
    const pts = [0, 1, 2, 3].map((i) => ({ x: i * 10, y: 42 }));
    expect(monotoneTangents(pts)).toEqual([0, 0, 0, 0]);
    for (const s of sample(smoothPath(pts))) expect(s.y).toBeCloseTo(42, 5);
  });

  it('flattens the tangent at peaks and valleys', () => {
    const m = monotoneTangents([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
    expect(m[1]).toBe(0);
  });

  it('survives repeated x values', () => {
    expect(smoothPath([{ x: 1, y: 1 }, { x: 1, y: 5 }])).not.toContain('NaN');
  });
});

describe('areaPath', () => {
  it('closes the line down to the baseline', () => {
    const d = areaPath([{ x: 10, y: 50 }, { x: 40, y: 20 }], 200);
    expect(d.endsWith('L40 200 L10 200 Z')).toBe(true);
    expect(areaPath([{ x: 1, y: 1 }], 200)).toBe('');
  });
});

describe('axis helpers', () => {
  it('picks a round top for the minutes axis', () => {
    expect(niceMaxMinutes(0)).toBe(240);
    expect(niceMaxMinutes(170)).toBe(240);
    expect(niceMaxMinutes(240)).toBe(240);
    expect(niceMaxMinutes(241)).toBe(480);
    expect(niceMaxMinutes(700)).toBe(720);
  });
  it('scales linearly', () => {
    expect(scale(120, 0, 240, 200, 20)).toBe(110);
    expect(scale(0, 0, 240, 200, 20)).toBe(200);
    expect(scale(3, 5, 5, 10, 20)).toBe(10);
  });
  it('spreads points evenly', () => {
    expect(spread(7, 60, 612)).toEqual([60, 152, 244, 336, 428, 520, 612]);
    expect(spread(1, 0, 100)).toEqual([50]);
    expect(spread(0, 0, 100)).toEqual([]);
  });
});

describe('arcSegments', () => {
  it('splits the arc in proportion with gaps', () => {
    const segs = arcSegments([1, 1, 1], 283, 3);
    expect(segs.map((s) => s.length)).toEqual([92.33, 92.33, 92.33]);
    expect(segs.map((s) => s.offset)).toEqual([0, 95.33, 190.67]);
  });
  it('skips empty groups and fills the arc with one group', () => {
    const segs = arcSegments([0, 2, 0], 283, 3);
    expect(segs[0]!.length).toBe(0);
    expect(segs[1]).toEqual({ length: 283, offset: 0 });
  });
  it('returns nothing to draw when there are no devices', () => {
    expect(arcSegments([0, 0, 0], 283).every((s) => s.length === 0)).toBe(true);
  });
});
