import { describe, expect, it } from 'vitest';
import {
  dayLong, formatClock, formatClockShort, formatLeft, formatLimitOption, formatMinutes, joinList,
  percent, plural, possessive, timeAgo, weekdayLabel,
} from './format';
import { requestCopy } from './requests';
import { contrast, lineColor, safeColor, textOn } from './color';

describe('formatMinutes', () => {
  it('formats hours and minutes', () => {
    expect(formatMinutes(78)).toBe('1 h 18 min');
    expect(formatMinutes(90)).toBe('1 h 30 min');
    expect(formatMinutes(120)).toBe('2 h');
    expect(formatMinutes(48)).toBe('48 min');
    expect(formatMinutes(0)).toBe('0 min');
  });
  it('never shows negative or broken values', () => {
    expect(formatMinutes(-5)).toBe('0 min');
    expect(formatMinutes(Number.NaN)).toBe('0 min');
    expect(formatMinutes(59.6)).toBe('1 h');
  });
});

describe('formatLeft', () => {
  it('formats time left as h:mm', () => {
    expect(formatLeft(42)).toBe('0:42');
    expect(formatLeft(0)).toBe('0:00');
    expect(formatLeft(135)).toBe('2:15');
    expect(formatLeft(60)).toBe('1:00');
    expect(formatLeft(-3)).toBe('0:00');
  });
});

describe('clock times', () => {
  it('turns 24 h into 12 h', () => {
    expect(formatClock('20:30')).toBe('8:30 pm');
    expect(formatClock('06:00')).toBe('6:00 am');
    expect(formatClock('00:15')).toBe('12:15 am');
    expect(formatClock('12:00')).toBe('12:00 pm');
    expect(formatClockShort('21:30')).toBe('9:30');
  });
  it('leaves other text alone', () => {
    expect(formatClock('soon')).toBe('soon');
    expect(formatClock('27:00')).toBe('27:00');
  });
});

describe('other formatting', () => {
  it('limit options', () => {
    expect(formatLimitOption(120)).toBe('2 hours');
    expect(formatLimitOption(60)).toBe('1 hour');
    expect(formatLimitOption(30)).toBe('30 minutes');
    expect(formatLimitOption(90)).toBe('1 h 30 min');
  });
  it('time ago', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    expect(timeAgo('2026-03-10T11:58:00Z', now)).toBe('2 minutes ago');
    expect(timeAgo('2026-03-10T11:59:40Z', now)).toBe('just now');
    expect(timeAgo('2026-03-10T11:20:00Z', now)).toBe('40 minutes ago');
    expect(timeAgo('2026-03-10T10:59:00Z', now)).toBe('1 hour ago');
    expect(timeAgo('2026-03-07T12:00:00Z', now)).toBe('3 days ago');
    expect(timeAgo(null, now)).toBe('never');
    expect(timeAgo('2026-03-10T12:05:00Z', now)).toBe('just now');
  });
  it('day labels do not shift with the time zone', () => {
    expect(weekdayLabel('2026-03-10')).toBe('Tue');
    expect(weekdayLabel('2026-03-08')).toBe('Sun');
    expect(dayLong('2026-03-10')).toBe('Tue, Mar 10');
    expect(weekdayLabel('nope')).toBe('nope');
  });
  it('percent is clamped', () => {
    expect(percent(78, 120)).toBe(65);
    expect(percent(200, 120)).toBe(100);
    expect(percent(0, 0)).toBe(0);
    expect(percent(5, 0)).toBe(100);
  });
  it('words', () => {
    expect(plural(1, 'try', 'tries')).toBe('1 try');
    expect(plural(4, 'try', 'tries')).toBe('4 tries');
    expect(possessive('Max')).toBe("Max's");
    expect(possessive('Jess')).toBe("Jess'");
    expect(joinList(['a'])).toBe('a');
    expect(joinList(['a', 'b'])).toBe('a and b');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('requestCopy', () => {
  it('matches the approved wording', () => {
    expect(requestCopy({ kind: 'time', kidName: 'Max', minutes: 15, detail: null }).text).toBe('Max asks for 15 more minutes');
    expect(requestCopy({ kind: 'time', kidName: 'Max', minutes: 1, detail: null }).text).toBe('Max asks for 1 more minute');
    const app = requestCopy({ kind: 'app', kidName: 'Ava', minutes: null, detail: 'Duolingo' });
    expect(app.text).toBe('Ava wants a new app: Duolingo');
    expect(app.yes).toBe('Allow');
    expect(requestCopy({ kind: 'site', kidName: 'Ava', minutes: null, detail: 'example.org' }).tag).toBe('New site');
  });
});

describe('colours', () => {
  it('picks readable text for a fill', () => {
    expect(textOn('#4f61b8')).toBe('#ffffff');
    expect(textOn('#34d399')).toBe('#06281c');
    expect(textOn('#fbbf24')).toBe('#06281c');
  });
  it('falls back for bad input', () => {
    expect(safeColor('javascript:alert(1)')).toBe('#4f61b8');
    expect(safeColor(null)).toBe('#4f61b8');
    expect(safeColor('34d399')).toBe('#34d399');
  });
  it('makes chart lines readable on the card', () => {
    for (const c of ['#4f61b8', '#34d399', '#1f6f56', '#000000', '#141b3f']) {
      expect(contrast(lineColor(c), '#080c22')).toBeGreaterThanOrEqual(4.5);
    }
    expect(lineColor('#34d399')).toBe('#34d399');
  });
});
