import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays,
  bedtimeAt,
  evaluateRules,
  formatMinutes,
  isClock,
  isSchoolDay,
  isSchoolNight,
  isValidTimeZone,
  lastDays,
  localTime,
  parseClock,
  statusText,
  type RuleApp,
  type RuleInput,
  type RuleKid,
  type RuleUsage,
} from '../src/rules';

const TZ = 'America/Denver';

// The week of 9 March 2026 (after the US clock change on 8 March, so Denver is UTC-6).
const MON = '2026-03-09';
const TUE = '2026-03-10';
const WED = '2026-03-11';
const THU = '2026-03-12';
const FRI = '2026-03-13';
const SAT = '2026-03-14';
const SUN = '2026-03-15';

/** A moment given as Denver wall-clock time. */
function denver(day: string, clock: string): Date {
  return new Date(`${day}T${clock}:00-06:00`);
}

const KID: RuleKid = {
  limitSchoolMinutes: 120,
  limitWeekendMinutes: 180,
  bedSchoolStart: '20:30',
  bedSchoolEnd: '06:00',
  bedOtherStart: '21:30',
  bedOtherEnd: '07:00',
  bedtimeEnabled: true,
  locked: false,
};

function input(over: Partial<RuleInput> & { kid?: RuleKid } = {}): RuleInput {
  return {
    now: denver(WED, '15:00'),
    timezone: TZ,
    pausedAll: false,
    kid: KID,
    grantMinutes: 0,
    apps: [],
    usage: [],
    ...over,
  };
}

function app(id: string, over: Partial<RuleApp> = {}): RuleApp {
  return { id, free: false, limitMinutes: null, ...over };
}

function use(appId: string | null, minutes: number): RuleUsage {
  return { appId, minutes };
}

describe('local time helpers', () => {
  it('reads day, weekday and minutes in the family time zone', () => {
    assert.deepEqual(localTime(denver(WED, '15:07'), TZ), { day: WED, weekday: 3, minutes: 15 * 60 + 7 });
    assert.deepEqual(localTime(denver(SUN, '00:00'), TZ), { day: SUN, weekday: 0, minutes: 0 });
    assert.deepEqual(localTime(denver(SAT, '23:59'), TZ), { day: SAT, weekday: 6, minutes: 23 * 60 + 59 });
  });

  it('gives a different day for the same moment in another time zone', () => {
    const moment = new Date('2026-03-14T02:00:00Z'); // Friday 20:00 in Denver, Saturday 11:00 in Tokyo
    assert.deepEqual(localTime(moment, TZ), { day: FRI, weekday: 5, minutes: 20 * 60 });
    assert.deepEqual(localTime(moment, 'Asia/Tokyo'), { day: SAT, weekday: 6, minutes: 11 * 60 });
    assert.deepEqual(localTime(moment, 'UTC'), { day: SAT, weekday: 6, minutes: 120 });
  });

  it('follows daylight saving time', () => {
    // 8 March 2026: Denver jumps from 02:00 MST to 03:00 MDT.
    assert.equal(localTime(new Date('2026-03-08T08:59:00Z'), TZ).minutes, 60 + 59); // 01:59 MST
    assert.equal(localTime(new Date('2026-03-08T09:00:00Z'), TZ).minutes, 3 * 60); // 03:00 MDT
    // 1 November 2026: back to MST. 07:30 UTC is 01:30 MDT, 08:30 UTC is 01:30 MST.
    assert.equal(localTime(new Date('2026-11-01T07:30:00Z'), TZ).minutes, 90);
    assert.equal(localTime(new Date('2026-11-01T08:30:00Z'), TZ).minutes, 90);
    assert.equal(localTime(new Date('2026-11-01T08:30:00Z'), TZ).day, '2026-11-01');
  });

  it('midnight is 00:00, never 24:00', () => {
    assert.equal(localTime(new Date('2026-03-11T06:00:00Z'), TZ).minutes, 0);
    assert.equal(localTime(new Date('2026-03-11T06:00:00Z'), TZ).day, WED);
  });

  it('adds days across months and years', () => {
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addDays('2025-12-31', 1), '2026-01-01');
    assert.deepEqual(lastDays(WED, 3), [MON, TUE, WED]);
    assert.equal(lastDays(WED, 7).length, 7);
    assert.equal(lastDays(WED, 7)[0], '2026-03-05');
  });

  it('checks clock strings and time zones', () => {
    assert.equal(isClock('20:30'), true);
    assert.equal(isClock('00:00'), true);
    assert.equal(isClock('24:00'), false);
    assert.equal(isClock('7:00'), false);
    assert.equal(isClock('07:60'), false);
    assert.equal(parseClock('06:05'), 365);
    assert.throws(() => parseClock('nope'));
    assert.equal(isValidTimeZone('America/Denver'), true);
    assert.equal(isValidTimeZone('Europe/Berlin'), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
    assert.equal(isValidTimeZone(''), false);
  });

  it('knows school days and school nights', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(isSchoolDay), [false, true, true, true, true, true, false]);
    // Night before a school day: Sunday to Thursday nights.
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(isSchoolNight), [true, true, true, true, true, false, false]);
  });
});

describe('daily limit', () => {
  it('uses the school limit Monday to Friday', () => {
    for (const day of [MON, TUE, WED, THU, FRI]) {
      const r = evaluateRules(input({ now: denver(day, '15:00') }));
      assert.equal(r.limitMinutes, 120, day);
      assert.equal(r.schoolDay, true, day);
      assert.equal(r.day, day);
    }
  });

  it('uses the weekend limit on Saturday and Sunday', () => {
    for (const day of [SAT, SUN]) {
      const r = evaluateRules(input({ now: denver(day, '15:00') }));
      assert.equal(r.limitMinutes, 180, day);
      assert.equal(r.schoolDay, false, day);
    }
  });

  it('switches limit at local midnight, not UTC midnight', () => {
    // Friday 23:59 Denver is already Saturday in UTC.
    assert.equal(evaluateRules(input({ now: denver(FRI, '19:00') })).limitMinutes, 120);
    assert.equal(evaluateRules(input({ now: denver(SAT, '08:00') })).limitMinutes, 180);
    // Sunday evening is still weekend; Monday morning is school.
    assert.equal(evaluateRules(input({ now: denver(SUN, '19:00') })).limitMinutes, 180);
    assert.equal(evaluateRules(input({ now: denver(MON, '08:00') })).limitMinutes, 120);
  });

  it('depends on the family time zone', () => {
    const moment = new Date('2026-03-14T02:00:00Z');
    assert.equal(evaluateRules(input({ now: moment, timezone: TZ })).limitMinutes, 120); // Friday in Denver
    assert.equal(evaluateRules(input({ now: moment, timezone: 'Asia/Tokyo' })).limitMinutes, 180); // Saturday in Tokyo
  });

  it('adds up usage and works out what is left', () => {
    const r = evaluateRules(input({ apps: [app('a'), app('b')], usage: [use('a', 30), use('b', 45), use('a', 10)] }));
    assert.equal(r.usedMinutes, 85);
    assert.equal(r.leftMinutes, 35);
    assert.equal(r.locked, false);
    assert.equal(r.lockReason, null);
  });

  it('never goes below zero left', () => {
    const r = evaluateRules(input({ apps: [app('a')], usage: [use('a', 500)] }));
    assert.equal(r.usedMinutes, 500);
    assert.equal(r.leftMinutes, 0);
    assert.equal(r.lockReason, 'time');
  });

  it('locks for time exactly when the limit is reached', () => {
    const almost = evaluateRules(input({ apps: [app('a')], usage: [use('a', 119)] }));
    assert.equal(almost.leftMinutes, 1);
    assert.equal(almost.locked, false);
    const reached = evaluateRules(input({ apps: [app('a')], usage: [use('a', 120)] }));
    assert.equal(reached.leftMinutes, 0);
    assert.equal(reached.locked, true);
    assert.equal(reached.lockReason, 'time');
  });

  it('a limit of zero means no screen time at all', () => {
    const r = evaluateRules(input({ kid: { ...KID, limitSchoolMinutes: 0 } }));
    assert.equal(r.limitMinutes, 0);
    assert.equal(r.lockReason, 'time');
  });

  it('counts usage that is not tied to a known app', () => {
    const r = evaluateRules(input({ usage: [use(null, 20), use('gone', 15)] }));
    assert.equal(r.usedMinutes, 35);
  });

  it('ignores negative and fractional noise', () => {
    const r = evaluateRules(input({ apps: [app('a')], usage: [use('a', -5), use('a', 10.9)] }));
    assert.equal(r.usedMinutes, 10);
  });
});

describe('grants', () => {
  it('adds today\'s grants to the limit', () => {
    const r = evaluateRules(input({ grantMinutes: 30, apps: [app('a')], usage: [use('a', 120)] }));
    assert.equal(r.limitMinutes, 150);
    assert.equal(r.leftMinutes, 30);
    assert.equal(r.locked, false);
  });

  it('adds grants on weekends too', () => {
    const r = evaluateRules(input({ now: denver(SAT, '12:00'), grantMinutes: 15 }));
    assert.equal(r.limitMinutes, 195);
  });

  it('a grant unlocks a kid who was out of time', () => {
    const base = { apps: [app('a')], usage: [use('a', 130)] };
    assert.equal(evaluateRules(input(base)).lockReason, 'time');
    const after = evaluateRules(input({ ...base, grantMinutes: 15 }));
    assert.equal(after.lockReason, null);
    assert.equal(after.leftMinutes, 5);
  });

  it('a negative grant total is treated as zero', () => {
    assert.equal(evaluateRules(input({ grantMinutes: -50 })).limitMinutes, 120);
  });
});

describe('free apps', () => {
  it('do not count against the daily time', () => {
    const r = evaluateRules(
      input({ apps: [app('game'), app('learn', { free: true })], usage: [use('game', 40), use('learn', 300)] }),
    );
    assert.equal(r.usedMinutes, 40);
    assert.equal(r.leftMinutes, 80);
    assert.equal(r.locked, false);
  });

  it('still show their own minutes', () => {
    const r = evaluateRules(input({ apps: [app('learn', { free: true })], usage: [use('learn', 25), use('learn', 5)] }));
    assert.equal(r.apps['learn']?.usedMinutes, 30);
    assert.equal(r.usedMinutes, 0);
  });

  it('a kid who only used free apps is never out of time', () => {
    const r = evaluateRules(input({ apps: [app('learn', { free: true })], usage: [use('learn', 1000)] }));
    assert.equal(r.lockReason, null);
    assert.equal(r.leftMinutes, 120);
  });
});

describe('per-app limits', () => {
  it('sums one app over several devices', () => {
    const r = evaluateRules(input({ apps: [app('mc', { limitMinutes: 60 })], usage: [use('mc', 25), use('mc', 20)] }));
    assert.equal(r.apps['mc']?.usedMinutes, 45);
    assert.equal(r.apps['mc']?.usedUp, false);
  });

  it('is used up when its own minutes reach its limit', () => {
    const at = evaluateRules(input({ apps: [app('mc', { limitMinutes: 60 })], usage: [use('mc', 60)] }));
    assert.equal(at.apps['mc']?.usedUp, true);
    const over = evaluateRules(input({ apps: [app('mc', { limitMinutes: 60 })], usage: [use('mc', 75)] }));
    assert.equal(over.apps['mc']?.usedUp, true);
    const under = evaluateRules(input({ apps: [app('mc', { limitMinutes: 60 })], usage: [use('mc', 59)] }));
    assert.equal(under.apps['mc']?.usedUp, false);
  });

  it('an app without its own limit is never used up', () => {
    const r = evaluateRules(input({ apps: [app('mc')], usage: [use('mc', 110)] }));
    assert.equal(r.apps['mc']?.usedUp, false);
  });

  it('a used-up app does not lock the whole device', () => {
    const r = evaluateRules(input({ apps: [app('mc', { limitMinutes: 30 }), app('other')], usage: [use('mc', 30), use('other', 10)] }));
    assert.equal(r.apps['mc']?.usedUp, true);
    assert.equal(r.locked, false);
    assert.equal(r.leftMinutes, 80);
  });

  it('a free app can still have its own limit', () => {
    const r = evaluateRules(input({ apps: [app('learn', { free: true, limitMinutes: 20 })], usage: [use('learn', 20)] }));
    assert.equal(r.apps['learn']?.usedUp, true);
    assert.equal(r.usedMinutes, 0);
  });

  it('a limit of zero is used up from the start', () => {
    const r = evaluateRules(input({ apps: [app('mc', { limitMinutes: 0 })] }));
    assert.equal(r.apps['mc']?.usedUp, true);
  });

  it('lists every app, also unused ones', () => {
    const r = evaluateRules(input({ apps: [app('a'), app('b')] }));
    assert.deepEqual(r.apps, { a: { usedMinutes: 0, usedUp: false }, b: { usedMinutes: 0, usedUp: false } });
  });
});

describe('bedtime', () => {
  const at = (day: string, clock: string, kid: RuleKid = KID) => evaluateRules(input({ now: denver(day, clock), kid }));

  it('school night: starts at 20:30 and runs past midnight until 06:00', () => {
    assert.equal(at(WED, '20:29').lockReason, null);
    assert.equal(at(WED, '20:30').lockReason, 'bedtime');
    assert.equal(at(WED, '23:59').lockReason, 'bedtime');
    assert.equal(at(THU, '00:00').lockReason, 'bedtime');
    assert.equal(at(THU, '05:59').lockReason, 'bedtime');
    assert.equal(at(THU, '06:00').lockReason, null);
  });

  it('every night from Sunday to Thursday is a school night', () => {
    for (const day of [SUN, MON, TUE, WED, THU]) {
      assert.equal(at(day, '20:45').lockReason, 'bedtime', `${day} 20:45`);
      assert.equal(at(day, '20:45').bedtime.start, '20:30');
    }
    for (const day of [MON, TUE, WED, THU, FRI]) {
      assert.equal(at(day, '05:30').lockReason, 'bedtime', `${day} 05:30`);
      assert.equal(at(day, '06:30').lockReason, null, `${day} 06:30`);
    }
  });

  it('Friday night is an "other" night: later start', () => {
    assert.equal(at(FRI, '20:45').lockReason, null); // a school night would already be locked
    assert.equal(at(FRI, '21:29').lockReason, null);
    assert.equal(at(FRI, '21:30').lockReason, 'bedtime');
    assert.equal(at(FRI, '23:59').lockReason, 'bedtime');
  });

  it('Friday night runs until 07:00 on Saturday morning', () => {
    assert.equal(at(SAT, '00:00').lockReason, 'bedtime');
    assert.equal(at(SAT, '06:30').lockReason, 'bedtime'); // a school night would have ended at 06:00
    assert.equal(at(SAT, '06:59').lockReason, 'bedtime');
    assert.equal(at(SAT, '07:00').lockReason, null);
  });

  it('Friday morning still belongs to Thursday\'s school night', () => {
    assert.equal(at(FRI, '05:59').lockReason, 'bedtime');
    assert.equal(at(FRI, '06:00').lockReason, null);
    assert.equal(at(FRI, '06:30').lockReason, null);
  });

  it('Saturday night is an "other" night and runs into Sunday morning', () => {
    assert.equal(at(SAT, '20:45').lockReason, null);
    assert.equal(at(SAT, '21:30').lockReason, 'bedtime');
    assert.equal(at(SUN, '06:30').lockReason, 'bedtime');
    assert.equal(at(SUN, '07:00').lockReason, null);
  });

  it('Sunday night is a school night again, ending 06:00 on Monday', () => {
    assert.equal(at(SUN, '20:29').lockReason, null);
    assert.equal(at(SUN, '20:30').lockReason, 'bedtime');
    assert.equal(at(MON, '05:59').lockReason, 'bedtime');
    assert.equal(at(MON, '06:00').lockReason, null);
    assert.equal(at(MON, '06:30').lockReason, null); // Saturday rules would still lock at 06:30
  });

  it('is not active in the middle of the day', () => {
    for (const day of [MON, WED, FRI, SAT, SUN]) assert.equal(at(day, '12:00').lockReason, null, day);
  });

  it('reports tonight\'s window during the day', () => {
    assert.deepEqual(at(WED, '15:00').bedtime, { enabled: true, start: '20:30', end: '06:00' });
    assert.deepEqual(at(FRI, '15:00').bedtime, { enabled: true, start: '21:30', end: '07:00' });
    assert.deepEqual(at(SAT, '15:00').bedtime, { enabled: true, start: '21:30', end: '07:00' });
    assert.deepEqual(at(SUN, '15:00').bedtime, { enabled: true, start: '20:30', end: '06:00' });
  });

  it('reports the window that is running in the early morning', () => {
    // Saturday 06:30: Friday's window (until 07:00) is in force.
    assert.deepEqual(at(SAT, '06:30').bedtime, { enabled: true, start: '21:30', end: '07:00' });
    // Friday 05:00: Thursday's school window is in force, not Friday evening's "other" window.
    assert.deepEqual(at(FRI, '05:00').bedtime, { enabled: true, start: '20:30', end: '06:00' });
    // Sunday 06:30: Saturday's window is in force; by 08:00 it shows Sunday evening's school window.
    assert.deepEqual(at(SUN, '06:30').bedtime, { enabled: true, start: '21:30', end: '07:00' });
    assert.deepEqual(at(SUN, '08:00').bedtime, { enabled: true, start: '20:30', end: '06:00' });
  });

  it('does nothing when bedtime is switched off', () => {
    const off = { ...KID, bedtimeEnabled: false };
    assert.equal(at(WED, '23:00', off).lockReason, null);
    assert.equal(at(THU, '03:00', off).lockReason, null);
    assert.equal(at(WED, '23:00', off).inBedtime, false);
    assert.deepEqual(at(WED, '23:00', off).bedtime, { enabled: false, start: '20:30', end: '06:00' });
  });

  it('handles a window that starts after midnight (00:30 to 06:00)', () => {
    const late = { ...KID, bedOtherStart: '00:30', bedOtherEnd: '08:00' };
    assert.equal(at(FRI, '23:30', late).lockReason, null);
    assert.equal(at(SAT, '00:29', late).lockReason, null);
    assert.equal(at(SAT, '00:30', late).lockReason, 'bedtime'); // Friday night's window
    assert.equal(at(SAT, '07:59', late).lockReason, 'bedtime');
    assert.equal(at(SAT, '08:00', late).lockReason, null);
    assert.equal(at(SUN, '01:00', late).lockReason, 'bedtime'); // Saturday night's window
    assert.equal(at(MON, '01:00', late).lockReason, 'bedtime'); // Sunday night is a school night: 20:30 to 06:00
    assert.equal(at(FRI, '07:00', late).lockReason, null); // Thursday was a school night, ended 06:00
  });

  it('handles a window that ends before midnight (19:00 to 23:00)', () => {
    const early = { ...KID, bedSchoolStart: '19:00', bedSchoolEnd: '23:00' };
    assert.equal(at(WED, '18:59', early).lockReason, null);
    assert.equal(at(WED, '19:00', early).lockReason, 'bedtime');
    assert.equal(at(WED, '22:59', early).lockReason, 'bedtime');
    assert.equal(at(WED, '23:00', early).lockReason, null);
    assert.equal(at(THU, '03:00', early).lockReason, null);
  });

  it('an empty window (start = end) never locks', () => {
    const none = { ...KID, bedSchoolStart: '21:00', bedSchoolEnd: '21:00' };
    assert.equal(at(WED, '21:00', none).lockReason, null);
    assert.equal(at(THU, '03:00', none).lockReason, null);
  });

  it('bedtimeAt can be used on its own', () => {
    assert.deepEqual(bedtimeAt(KID, { day: SAT, weekday: 6, minutes: 6 * 60 + 30 }), { start: '21:30', end: '07:00', active: true });
    assert.deepEqual(bedtimeAt(KID, { day: MON, weekday: 1, minutes: 6 * 60 + 30 }), { start: '20:30', end: '06:00', active: false });
  });

  it('works in another time zone', () => {
    // 2026-03-11 19:45 UTC is 20:45 in Berlin (bedtime) and 13:45 in Denver (not).
    const moment = new Date('2026-03-11T19:45:00Z');
    assert.equal(evaluateRules(input({ now: moment, timezone: 'Europe/Berlin' })).lockReason, 'bedtime');
    assert.equal(evaluateRules(input({ now: moment, timezone: TZ })).lockReason, null);
  });
});

describe('lockReason priority', () => {
  const outOfTime = { apps: [app('a')], usage: [use('a', 999)] };
  const bedtimeNow = denver(WED, '22:00');

  it('paused beats everything', () => {
    const r = evaluateRules(input({ ...outOfTime, now: bedtimeNow, pausedAll: true, kid: { ...KID, locked: true } }));
    assert.equal(r.lockReason, 'paused');
    assert.equal(r.locked, true);
  });

  it('parent lock beats bedtime and time', () => {
    const r = evaluateRules(input({ ...outOfTime, now: bedtimeNow, kid: { ...KID, locked: true } }));
    assert.equal(r.lockReason, 'parent');
  });

  it('bedtime beats time', () => {
    const r = evaluateRules(input({ ...outOfTime, now: bedtimeNow }));
    assert.equal(r.lockReason, 'bedtime');
    assert.equal(r.leftMinutes, 0);
  });

  it('time when nothing else applies', () => {
    assert.equal(evaluateRules(input(outOfTime)).lockReason, 'time');
  });

  it('null when the kid may use the device', () => {
    const r = evaluateRules(input());
    assert.equal(r.lockReason, null);
    assert.equal(r.locked, false);
  });

  it('each reason alone', () => {
    assert.equal(evaluateRules(input({ pausedAll: true })).lockReason, 'paused');
    assert.equal(evaluateRules(input({ kid: { ...KID, locked: true } })).lockReason, 'parent');
    assert.equal(evaluateRules(input({ now: bedtimeNow })).lockReason, 'bedtime');
  });

  it('paused with bedtime off and time left is still paused', () => {
    const r = evaluateRules(input({ pausedAll: true, kid: { ...KID, bedtimeEnabled: false } }));
    assert.equal(r.lockReason, 'paused');
    assert.equal(r.leftMinutes, 120);
  });

  it('the numbers are still worked out while locked', () => {
    const r = evaluateRules(input({ pausedAll: true, grantMinutes: 10, apps: [app('a')], usage: [use('a', 50)] }));
    assert.equal(r.limitMinutes, 130);
    assert.equal(r.usedMinutes, 50);
    assert.equal(r.leftMinutes, 80);
  });
});

describe('purity', () => {
  it('gives the same answer for the same input and does not change it', () => {
    const data = input({ apps: [app('a', { limitMinutes: 10 })], usage: [use('a', 12)], grantMinutes: 5 });
    const copy = JSON.parse(JSON.stringify({ ...data, now: undefined })) as unknown;
    const first = evaluateRules(data);
    const second = evaluateRules(data);
    assert.deepEqual(first, second);
    assert.deepEqual(JSON.parse(JSON.stringify({ ...data, now: undefined })), copy);
  });
});

describe('status text', () => {
  it('formats minutes', () => {
    assert.equal(formatMinutes(0), '0 min');
    assert.equal(formatMinutes(45), '45 min');
    assert.equal(formatMinutes(60), '1 h');
    assert.equal(formatMinutes(125), '2 h 5 min');
  });

  it('has one line for every state', () => {
    assert.equal(statusText(evaluateRules(input())), '2 h left');
    assert.equal(statusText(evaluateRules(input({ pausedAll: true }))), 'Paused');
    assert.equal(statusText(evaluateRules(input({ kid: { ...KID, locked: true } }))), 'Locked by a parent');
    assert.equal(statusText(evaluateRules(input({ now: denver(WED, '22:00') }))), 'Bedtime until 06:00');
    assert.equal(statusText(evaluateRules(input({ now: denver(SAT, '06:30') }))), 'Bedtime until 07:00');
    assert.equal(statusText(evaluateRules(input({ apps: [app('a')], usage: [use('a', 120)] }))), 'Time is up. Family calls still work');
    assert.equal(statusText(evaluateRules(input()), 'Minecraft'), 'Using Minecraft');
    assert.equal(statusText(evaluateRules(input({ pausedAll: true })), 'Minecraft'), 'Paused');
  });
});
