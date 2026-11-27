import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import {
  KIDS_ADMIN,
  KIDS_PACKAGE,
  KIDS_SCHEME,
  apkChecksum,
  appSlug,
  bedtimeInstants,
  choreShown,
  choreWindowStart,
  clock12,
  guessCategory,
  isPackageName,
  isVersion,
  newerVersion,
  nextLocalMidnight,
  normalizeSignatureChecksum,
  numKey,
  prettyNumber,
  provisioningPayload,
  unlockCode,
  wireRequest,
  zonedToUtc,
} from '../src/compat/logic';
import { loadConfig } from '../src/config';
import { shownPlan } from '../src/state';
import type { RuleKid } from '../src/rules';

const DENVER = 'America/Denver';

const kid: RuleKid = {
  limitSchoolMinutes: 120,
  limitWeekendMinutes: 180,
  bedSchoolStart: '20:30',
  bedSchoolEnd: '06:00',
  bedOtherStart: '21:30',
  bedOtherEnd: '07:00',
  bedtimeEnabled: true,
  locked: false,
};

describe('wall clock to instant', () => {
  it('turns a local day and time into the right instant, winter and summer', () => {
    assert.equal(zonedToUtc('2026-03-11', '15:00', DENVER).toISOString(), '2026-03-11T21:00:00.000Z'); // MDT, UTC-6
    assert.equal(zonedToUtc('2026-01-15', '20:30', DENVER).toISOString(), '2026-01-16T03:30:00.000Z'); // MST, UTC-7
    assert.equal(zonedToUtc('2026-07-01', '00:00', 'Europe/Berlin').toISOString(), '2026-06-30T22:00:00.000Z');
    assert.equal(zonedToUtc('2026-07-01', '12:00', 'UTC').toISOString(), '2026-07-01T12:00:00.000Z');
  });

  it('is right on the days the clocks change', () => {
    // 8 March 2026: clocks go forward at 02:00 in Denver.
    assert.equal(zonedToUtc('2026-03-08', '01:00', DENVER).toISOString(), '2026-03-08T08:00:00.000Z');
    assert.equal(zonedToUtc('2026-03-08', '06:00', DENVER).toISOString(), '2026-03-08T12:00:00.000Z');
    // 1 November 2026: clocks go back.
    assert.equal(zonedToUtc('2026-11-01', '06:00', DENVER).toISOString(), '2026-11-01T13:00:00.000Z');
    assert.equal(zonedToUtc('2026-10-31', '21:30', DENVER).toISOString(), '2026-11-01T03:30:00.000Z');
  });

  it('the day ends at the next local midnight', () => {
    assert.equal(nextLocalMidnight(new Date('2026-03-11T21:00:00Z'), DENVER).toISOString(), '2026-03-12T06:00:00.000Z');
    // 23:59 local still ends the same night; 00:00 local ends the next one.
    assert.equal(nextLocalMidnight(new Date('2026-03-12T05:59:00Z'), DENVER).toISOString(), '2026-03-12T06:00:00.000Z');
    assert.equal(nextLocalMidnight(new Date('2026-03-12T06:00:00Z'), DENVER).toISOString(), '2026-03-13T06:00:00.000Z');
    // The night the clocks change is 23 hours long.
    assert.equal(nextLocalMidnight(new Date('2026-03-08T07:00:00Z'), DENVER).toISOString(), '2026-03-09T06:00:00.000Z');
  });
});

describe('bedtime as two instants', () => {
  it('in the afternoon it is tonight\'s window', () => {
    // Wednesday 15:00: school night, 20:30 to 06:00.
    const b = bedtimeInstants(kid, new Date('2026-03-11T21:00:00Z'), DENVER);
    assert.deepEqual([b?.at.toISOString(), b?.until.toISOString()], ['2026-03-12T02:30:00.000Z', '2026-03-12T12:00:00.000Z']);
  });

  it('early in the morning it is still last night\'s window', () => {
    // Thursday 05:00 local: inside Wednesday night's window.
    const now = new Date('2026-03-12T11:00:00Z');
    const b = bedtimeInstants(kid, now, DENVER);
    assert.deepEqual([b?.at.toISOString(), b?.until.toISOString()], ['2026-03-12T02:30:00.000Z', '2026-03-12T12:00:00.000Z']);
    assert.ok(b && b.at.getTime() <= now.getTime() && now.getTime() < b.until.getTime());
  });

  it('once the window is over the next one is tonight\'s', () => {
    // Thursday 06:00 local exactly: over. Next is Thursday 20:30.
    const b = bedtimeInstants(kid, new Date('2026-03-12T12:00:00Z'), DENVER);
    assert.equal(b?.at.toISOString(), '2026-03-13T02:30:00.000Z');
  });

  it('Friday and Saturday nights use the other times; Sunday is a school night again', () => {
    const fri = bedtimeInstants(kid, new Date('2026-03-13T21:00:00Z'), DENVER); // Friday 15:00
    assert.deepEqual([fri?.at.toISOString(), fri?.until.toISOString()], ['2026-03-14T03:30:00.000Z', '2026-03-14T13:00:00.000Z']);
    // Saturday 06:30 local is still inside Friday's 21:30 to 07:00.
    const satMorning = bedtimeInstants(kid, new Date('2026-03-14T12:30:00Z'), DENVER);
    assert.equal(satMorning?.until.toISOString(), '2026-03-14T13:00:00.000Z');
    const sun = bedtimeInstants(kid, new Date('2026-03-15T21:00:00Z'), DENVER); // Sunday 15:00
    assert.equal(sun?.at.toISOString(), '2026-03-16T02:30:00.000Z');
  });

  it('follows the rule engine for windows that do not cross midnight', () => {
    // 19:00 to 23:00: all inside the evening.
    const evening = { ...kid, bedSchoolStart: '19:00', bedSchoolEnd: '23:00' };
    const a = bedtimeInstants(evening, new Date('2026-03-11T21:00:00Z'), DENVER);
    assert.deepEqual([a?.at.toISOString(), a?.until.toISOString()], ['2026-03-12T01:00:00.000Z', '2026-03-12T05:00:00.000Z']);
    // At 23:30 that evening it is over: the next is tomorrow evening.
    const later = bedtimeInstants(evening, new Date('2026-03-12T05:30:00Z'), DENVER);
    assert.equal(later?.at.toISOString(), '2026-03-13T01:00:00.000Z');
    // 00:30 to 06:00 starts after midnight and belongs to the night before.
    const late = { ...kid, bedSchoolStart: '00:30', bedSchoolEnd: '06:00' };
    const c = bedtimeInstants(late, new Date('2026-03-11T21:00:00Z'), DENVER);
    assert.deepEqual([c?.at.toISOString(), c?.until.toISOString()], ['2026-03-12T06:30:00.000Z', '2026-03-12T12:00:00.000Z']);
  });

  it('is null when bedtime is off or the window is empty', () => {
    assert.equal(bedtimeInstants({ ...kid, bedtimeEnabled: false }, new Date('2026-03-11T21:00:00Z'), DENVER), null);
    const empty = { ...kid, bedSchoolStart: '20:00', bedSchoolEnd: '20:00', bedOtherStart: '21:00', bedOtherEnd: '21:00' };
    assert.equal(bedtimeInstants(empty, new Date('2026-03-11T21:00:00Z'), DENVER), null);
  });

  it('shows a clock the way people say it', () => {
    assert.deepEqual(['00:05', '08:30', '12:00', '20:30', '23:59'].map(clock12), ['12:05 am', '8:30 am', '12:00 pm', '8:30 pm', '11:59 pm']);
  });
});

describe('apps', () => {
  it('knows a package name from other text', () => {
    for (const ok of ['com.roblox.client', 'org.khanacademy.android', 'a.b', 'com.example.app_2']) assert.equal(isPackageName(ok), true, ok);
    for (const bad of ['roblox', 'Toca Boca', 'com..x', '.com.x', '1com.x', 'com.x.', 'not a package', '', `com.${'x'.repeat(200)}`]) assert.equal(isPackageName(bad), false, bad);
  });

  it('gives the same slug to the same name written differently', () => {
    assert.equal(appSlug('Toca Boca World'), 'toca-boca-world');
    assert.equal(appSlug('  toca   boca: WORLD!  '), 'toca-boca-world');
    assert.equal(appSlug('Pokémon GO'), 'pokemon-go');
    assert.equal(appSlug('!!!'), '');
    assert.equal(appSlug('x'.repeat(100)).length, 60);
  });

  it('guesses where an app belongs on the launcher', () => {
    assert.equal(guessCategory('Chrome', 'com.android.chrome'), 'browser');
    assert.equal(guessCategory('YouTube Kids', 'com.google.android.apps.youtube.kids'), 'video');
    assert.equal(guessCategory('Khan Academy Kids', 'org.khanacademy.android'), 'school');
    assert.equal(guessCategory('Roblox', 'com.roblox.client'), 'game');
    assert.equal(guessCategory('Calculator', 'com.google.android.calculator'), 'other');
  });
});

describe('phone numbers', () => {
  it('compares numbers by their digits, the last 10 when there are more', () => {
    assert.equal(numKey('(555) 010-2231'), '5550102231');
    assert.equal(numKey('+1 555 010 2231'), '5550102231');
    assert.equal(numKey('555-0101'), '5550101');
    assert.equal(numKey('call me'), '');
    assert.equal(prettyNumber('5550102231'), '(555) 010-2231');
    assert.equal(prettyNumber('5550101'), '5550101');
  });
});

describe('emergency codes', () => {
  it('matches the scheme the app checks offline: HMAC-SHA256(secret, "unlock:n"), 4 bytes, mod 1e8', () => {
    const secret = Buffer.alloc(32, 7).toString('base64');
    const expected = (n: number): string => {
      const d = crypto.createHmac('sha256', Buffer.alloc(32, 7)).update(`unlock:${n}`).digest();
      return String((((d[0]! << 24) >>> 0) + (d[1]! << 16) + (d[2]! << 8) + d[3]!) % 100000000).padStart(8, '0');
    };
    for (const n of [1, 2, 3, 250]) {
      assert.equal(unlockCode(secret, n), expected(n));
      assert.match(unlockCode(secret, n), /^\d{8}$/);
    }
    assert.notEqual(unlockCode(secret, 1), unlockCode(secret, 2));
    assert.notEqual(unlockCode(secret, 1), unlockCode(Buffer.alloc(32, 8).toString('base64'), 1));
  });
});

describe('app versions and the setup QR', () => {
  it('reads versions as numbers, not as text', () => {
    assert.equal(newerVersion('1.10.0', '1.9.3'), true);
    assert.equal(newerVersion('1.9.3', '1.10.0'), false);
    assert.equal(newerVersion('2.0.0', '1.99.99'), true);
    assert.equal(newerVersion('1.0.7', '1.0.7'), false);
    for (const ok of ['1.0.0', '12.34.56']) assert.equal(isVersion(ok), true);
    for (const bad of ['1.0', '1.0.0-beta', 'v1.0.0', '1.0.0.0', '../1.0.0', '']) assert.equal(isVersion(bad), false, bad);
  });

  it('builds the payload Android\'s setup screen reads', () => {
    const sha = crypto.createHash('sha256').update('apk').digest('hex');
    const p = provisioningPayload({
      server: 'https://app.familyscreenwarden.com',
      code: 'ABCD2345',
      version: '1.2.3',
      sha256: sha,
      wifi: { ssid: 'Home', password: 'secret-pass', security: 'WPA' },
    });
    assert.equal(KIDS_PACKAGE, 'com.familyscreenwarden.kids');
    assert.equal(KIDS_ADMIN, 'com.familyscreenwarden.kids/.admin.KidsAdminReceiver');
    assert.deepEqual(p, {
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': 'com.familyscreenwarden.kids/.admin.KidsAdminReceiver',
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': 'https://app.familyscreenwarden.com/api/android/download?v=1.2.3',
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM': Buffer.from(sha, 'hex').toString('base64url'),
      'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
      'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { server: 'https://app.familyscreenwarden.com', code: 'ABCD2345' },
      'android.app.extra.PROVISIONING_WIFI_SSID': 'Home',
      'android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE': 'WPA',
      'android.app.extra.PROVISIONING_WIFI_PASSWORD': 'secret-pass',
    });
    assert.equal(apkChecksum(sha).includes('='), false);
  });

  it('uses the signing certificate\'s checksum instead of the file\'s when the publisher sent one', () => {
    const cert = Buffer.alloc(32, 9);
    const b64 = cert.toString('base64url');
    const p = provisioningPayload({ server: 'https://x.test', code: 'ABCD2345', version: '1.0.0', sha256: 'ab'.repeat(32), signatureChecksum: b64 });
    assert.equal(p['android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM'], b64);
    assert.equal('android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM' in p, false);
    // Whatever form it is sent in, it is kept as URL-safe base64 without padding.
    assert.equal(normalizeSignatureChecksum(b64), b64);
    assert.equal(normalizeSignatureChecksum(cert.toString('base64')), b64);
    assert.equal(normalizeSignatureChecksum(cert.toString('hex')), b64);
    assert.equal(normalizeSignatureChecksum(cert.toString('hex').toUpperCase().replace(/(..)(?=.)/g, '$1:')), b64);
    for (const bad of ['', 'short', 'ab'.repeat(20), `${b64}xx`, '../../etc/passwd']) assert.equal(normalizeSignatureChecksum(bad), null, bad);
    assert.equal(KIDS_SCHEME, 'screenwarden');
  });

  it('leaves Wi-Fi out when there is none, and the password out for an open network', () => {
    const base = { server: 'https://x.test', code: 'ABCD2345', version: '1.0.0', sha256: 'ab'.repeat(32) };
    assert.equal(Object.keys(provisioningPayload(base)).some((k) => k.includes('WIFI')), false);
    const open = provisioningPayload({ ...base, wifi: { ssid: 'Cafe', password: 'ignored', security: 'NONE' } });
    assert.equal(open['android.app.extra.PROVISIONING_WIFI_SSID'], 'Cafe');
    assert.equal('android.app.extra.PROVISIONING_WIFI_PASSWORD' in open, false);
  });
});

describe('chores', () => {
  const WED = '2026-03-11';

  it('a daily chore is done once a day, a weekly one once a week from Monday', () => {
    assert.equal(choreWindowStart('daily', WED), WED);
    assert.equal(choreWindowStart('weekly', WED), '2026-03-09');
    assert.equal(choreWindowStart('weekly', '2026-03-09'), '2026-03-09'); // a Monday
    assert.equal(choreWindowStart('weekly', '2026-03-15'), '2026-03-09'); // a Sunday
    assert.equal(choreWindowStart('once', WED), null);
  });

  it('shows todo, waiting and done to the kid', () => {
    assert.equal(choreShown('daily', WED, []), 'todo');
    assert.equal(choreShown('daily', WED, [{ day: WED, status: 'pending', decidedDay: null }]), 'waiting');
    assert.equal(choreShown('daily', WED, [{ day: WED, status: 'approved', decidedDay: WED }]), 'done');
    // Yesterday's approval does not count for today.
    assert.equal(choreShown('daily', WED, [{ day: '2026-03-10', status: 'approved', decidedDay: '2026-03-10' }]), 'todo');
    // Marked yesterday and still not answered: still waiting, not asked for twice.
    assert.equal(choreShown('daily', WED, [{ day: '2026-03-10', status: 'pending', decidedDay: null }]), 'waiting');
    // A declined try can be done again.
    assert.equal(choreShown('daily', WED, [{ day: WED, status: 'declined', decidedDay: WED }]), 'todo');
  });

  it('a weekly chore stays done until Monday', () => {
    const monday = [{ day: '2026-03-09', status: 'approved' as const, decidedDay: '2026-03-09' }];
    assert.equal(choreShown('weekly', WED, monday), 'done');
    assert.equal(choreShown('weekly', '2026-03-15', monday), 'done');
    assert.equal(choreShown('weekly', '2026-03-16', monday), 'todo');
  });

  it('a one-time chore shows done on the day it was approved, then goes away', () => {
    const marks = [{ day: '2026-03-10', status: 'approved' as const, decidedDay: WED }];
    assert.equal(choreShown('once', WED, marks), 'done');
    assert.equal(choreShown('once', '2026-03-12', marks), 'hidden');
    assert.equal(choreShown('once', WED, [{ day: '2026-03-01', status: 'declined', decidedDay: '2026-03-02' }]), 'todo');
  });
});

describe('requests as the apps read them', () => {
  it('uses the words the apps know: allowed, denied, pending', () => {
    const base = { id: 'r1', minutes: null, detail: '', identifier: null };
    assert.deepEqual(wireRequest({ ...base, kind: 'time', minutes: 30, status: 'pending' }), { id: 'r1', exe: 'time:30', name: '30 more minutes', status: 'pending' });
    assert.deepEqual(wireRequest({ ...base, kind: 'site', detail: 'khanacademy.org', identifier: 'khanacademy.org', status: 'approved' }), {
      id: 'r1', exe: 'site:khanacademy.org', name: 'Website: khanacademy.org', status: 'allowed',
    });
    assert.deepEqual(wireRequest({ ...base, kind: 'app', detail: 'Roblox', identifier: 'com.roblox.client', status: 'denied' }), {
      id: 'r1', exe: 'com.roblox.client', name: 'Roblox', status: 'denied',
    });
  });
});

describe('settings for the paywall, publishing and files', () => {
  const base = { DATABASE_URL: 'postgres://x/y' };

  it('billing is off unless it is switched on', () => {
    assert.equal(loadConfig(base).billingEnabled, false);
    assert.equal(loadConfig({ ...base, BILLING_ENABLED: '' }).billingEnabled, false);
    assert.equal(loadConfig({ ...base, BILLING_ENABLED: '0' }).billingEnabled, false);
    assert.equal(loadConfig({ ...base, BILLING_ENABLED: 'false' }).billingEnabled, false);
    for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(loadConfig({ ...base, BILLING_ENABLED: on }).billingEnabled, true, on);
  });

  it('reads PUBLISH_TOKEN and DATA_DIR', () => {
    const c = loadConfig({ ...base, PUBLISH_TOKEN: ' tok ', DATA_DIR: '/var/lib/fsw' });
    assert.equal(c.publishToken, 'tok');
    assert.equal(c.dataDir, '/var/lib/fsw');
    assert.equal(loadConfig(base).publishToken, '');
    assert.ok(loadConfig(base).dataDir.endsWith('data'));
  });

  it('with billing off a locked row is never shown as locked', () => {
    assert.equal(shownPlan({ plan: 'locked' }, false), 'trial');
    assert.equal(shownPlan({ plan: 'locked' }, true), 'locked');
    assert.equal(shownPlan({ plan: 'active' }, false), 'active');
    assert.equal(shownPlan({ plan: 'trial' }, false), 'trial');
  });
});
