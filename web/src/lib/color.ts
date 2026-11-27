const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
export const FALLBACK_COLOR = '#4f61b8';

/** Colours offered for new kids; the first two are the mockup's periwinkle and green. */
export const KID_COLORS = ['#4f61b8', '#34d399', '#fbbf24', '#f472b6', '#38bdf8', '#fb923c'] as const;

export function parseHex(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m || !m[1]) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function safeColor(hex: string | null | undefined): string {
  return hex && parseHex(hex) ? (hex.startsWith('#') ? hex : `#${hex}`) : FALLBACK_COLOR;
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: string, b: string): number {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return 1;
  const la = luminance(pa);
  const lb = luminance(pb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** White or the dark green ink, whichever reads better on the given fill. */
export function textOn(bg: string): string {
  const c = safeColor(bg);
  return contrast(c, '#ffffff') >= contrast(c, '#06281c') ? '#ffffff' : '#06281c';
}

/** A kid colour made light enough to read as a chart line on the dark card. */
export function lineColor(hex: string): string {
  let c = safeColor(hex);
  for (let i = 0; i < 6 && contrast(c, '#080c22') < 4.5; i++) {
    const p = parseHex(c);
    if (!p) break;
    const mix = p.map((v) => Math.round(v + (255 - v) * 0.18));
    c = `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  return c;
}
