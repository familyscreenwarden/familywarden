/**
 * The kids' Android app against the real server and a real Postgres.
 *
 * The first suite is the phone contract: it walks one phone through setup check → pair → sync → launcher → request
 * → chore → chat → texts → photos and videos → APK push → update, sending what the app and its launcher page send (and what the
 * workflow's publish step sends) and reading what they read. The other suites cover the walls between families,
 * limits, and the paywall switch.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { unlockCode } from '../src/compat/logic';
import { lockExpiredTrials, purgeExpired } from '../src/state';
import { Client, createKid, pairDevice, resetDatabase, signIn, startServer, TEST_DATA_DIR, TODAY, WEDNESDAY_AFTERNOON, type Json, type Reply, type TestServer } from './helpers';

const TOKEN = 'publish-token-for-tests-0123456789abcdef';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOBODY = '00000000-0000-4000-8000-000000000000';

function fakeApk(bytes = 150_000): Buffer {
  return Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(bytes)]);
}
const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
/** The first bytes of a PNG file, then filler: what the server checks before it keeps a picture. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(600)]);

let server: TestServer;

before(async () => {
  await resetDatabase();
  // The server's own default: BILLING_ENABLED not set.
  server = await startServer({ BILLING_ENABLED: '', PUBLISH_TOKEN: TOKEN });
});

after(async () => {
  await server.close();
});

/** The app marks its two raw uploads with X-FSW-Upload: 1. Pass 'X-FSW-Upload': '' to leave the marker out. */
function withMarker(method: string, url: string, headers: Record<string, string>): Record<string, string> {
  const h = { ...headers };
  if (method === 'POST' && /^\/api\/android\/(text-media\/|media$)/.test(url) && h['X-FSW-Upload'] === undefined) h['X-FSW-Upload'] = '1';
  if (h['X-FSW-Upload'] === '') delete h['X-FSW-Upload'];
  return h;
}

async function raw(method: string, url: string, body: Buffer | undefined, plain: Record<string, string>): Promise<Reply> {
  const headers = withMarker(method, url, plain);
  const res = await fetch(server.url + url, { method, headers, body });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = {};
  }
  return { status: res.status, body: json, headers: res.headers, text };
}

/** The signing certificate's SHA-256 as .github/workflows/android.yml sends it: URL-safe base64, no padding. */
const CERT_HEX = crypto.createHash('sha256').update('the signing certificate').digest('hex');
const CERT = Buffer.from(CERT_HEX, 'hex').toString('base64url');

function publish(apk: Buffer, version: string, extra: Record<string, string> = {}, token = TOKEN): Promise<Reply> {
  // The same request the workflow's "Publish to families" step sends with curl --data-binary.
  return raw('POST', '/internal/android/publish', apk, {
    Authorization: `Bearer ${token}`,
    'X-Version': version,
    'X-Sha256': sha(apk),
    'X-Signature-Checksum': CERT,
    'X-Notes': Buffer.from('First version').toString('base64'),
    'Content-Type': 'application/octet-stream',
    ...extra,
  });
}

async function download(url: string, headers: Record<string, string> = {}): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
  const res = await fetch(server.url + url, { headers });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

/** The phone: JSON calls with, once paired, the bearer token. */
function phoneClient(token = ''): Client {
  const c = new Client(server.url);
  c.bearer = token;
  return c;
}

interface Setup {
  parent: Client;
  kid: string;
  phone: Client;
  deviceId: string;
  secret: string;
}

/** A family with one kid and a paired phone, through the real QR + pair flow. Needs a published app. */
async function family(email: string, kidName: string, machine: string): Promise<Setup> {
  const parent = await signIn(server, email);
  const kid = await createKid(parent, kidName);
  const qr = await parent.post('/api/devices/android-qr', { kidId: kid });
  assert.equal(qr.status, 201, qr.text);
  const paired = await phoneClient().post('/api/android/pair', { code: qr.body.code, memberId: kid, deviceId: machine, model: 'Google Pixel 7a', version: '1.0.7' });
  assert.equal(paired.status, 200, paired.text);
  return { parent, kid, phone: phoneClient(paired.body.token), deviceId: paired.body.computerId, secret: paired.body.secret };
}

const APK_107 = fakeApk();
const APK_110 = fakeApk(160_000);

describe('the phone contract, end to end', () => {
  let parent: Client;
  let kid: string;
  let code = '';
  let token = '';
  let secret = '';
  let computerId = '';
  let phone: Client;

  const sync = async (extra: Json = {}): Promise<Json> => {
    const r = await phone.post('/api/warden/sync', { version: '1.0.7', unlocksUsed: [], ...extra });
    assert.equal(r.status, 200, r.text);
    return r.body;
  };

  it('a family with a kid; nothing is published yet, so there is no QR', async () => {
    parent = await signIn(server, 'cade@example.com');
    kid = await createKid(parent, 'Mia Test');
    const app = await parent.get('/api/android-app');
    assert.deepEqual(app.body, { latest: null, package: 'com.familyscreenwarden.kids', admin: 'com.familyscreenwarden.kids/.admin.KidsAdminReceiver' });
    const qr = await parent.post('/api/devices/android-qr', { kidId: kid });
    assert.equal(qr.status, 409);
    assert.match(qr.body.error, /not published/);
    assert.equal((await download('/api/android/download')).status, 404);
    assert.equal((await new Client(server.url).get('/internal/android/latest')).text, 'null');
  });

  it('GitHub publishes the app: token, version and checksum are checked', async () => {
    assert.equal((await publish(APK_107, '1.0.7', {}, 'wrong-token-wrong-token-wrong-token-0000')).status, 401);
    assert.equal((await raw('POST', '/internal/android/publish', APK_107, { 'X-Version': '1.0.7' })).status, 401);
    assert.equal((await publish(APK_107, 'one.two')).status, 400);
    assert.equal((await publish(APK_107, '../1.0.7')).status, 400);
    assert.equal((await publish(Buffer.from('not an apk at all'.repeat(10000)), '1.0.7')).status, 400);
    assert.equal((await publish(APK_107, '1.0.7', { 'X-Sha256': 'ab'.repeat(32) })).status, 400);
    assert.equal((await publish(APK_107, '1.0.7', { 'X-Signature-Checksum': 'not-a-checksum' })).status, 400);
    // Nothing of the refused uploads is left behind or offered.
    assert.equal((await new Client(server.url).get('/internal/android/latest')).text, 'null');
    assert.deepEqual(fs.readdirSync(path.join(TEST_DATA_DIR, 'releases', 'android')), []);

    const ok = await publish(APK_107, '1.0.7');
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.body, { ok: true, version: '1.0.7', sha256: sha(APK_107), size: APK_107.length, signatureChecksum: CERT });
    assert.equal((await publish(APK_107, '1.0.7')).status, 409);

    const latest = await new Client(server.url).get('/internal/android/latest');
    assert.equal(latest.body.version, '1.0.7');
    assert.equal(latest.body.sha256, sha(APK_107));
    assert.equal(latest.body.notes, 'First version');
    assert.equal(latest.body.signatureChecksum, CERT);
    const app = await parent.get('/api/android-app');
    assert.equal(app.body.latest.version, '1.0.7');
    assert.equal(app.body.latest.size, APK_107.length);
  });

  it('the setup QR carries the component, the download, the checksum, the Wi-Fi and the admin extras', async () => {
    const qr = await parent.post('/api/devices/android-qr', { kidId: kid, wifi: { ssid: 'Hardy Home', password: 'secret-pass', security: 'WPA' } });
    assert.equal(qr.status, 201, qr.text);
    const payload = JSON.parse(qr.body.payload);
    assert.equal(payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME'], 'com.familyscreenwarden.kids/.admin.KidsAdminReceiver');
    // The checksum is the signing certificate's, the one the workflow published (not the file's: Android takes one).
    assert.equal(payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM'], CERT);
    assert.equal('android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM' in payload, false);
    assert.equal(payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION'], 'http://console.test/api/android/download?v=1.0.7');
    assert.equal(payload['android.app.extra.PROVISIONING_WIFI_SSID'], 'Hardy Home');
    assert.equal(payload['android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE'], 'WPA');
    assert.equal(payload['android.app.extra.PROVISIONING_WIFI_PASSWORD'], 'secret-pass');
    const extras = payload['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'];
    assert.deepEqual(Object.keys(extras).sort(), ['code', 'server']);
    assert.equal(extras.server, 'http://console.test');
    assert.match(extras.code, /^[A-Z2-9]{8}$/);
    assert.equal(extras.code, qr.body.code);
    assert.ok(qr.body.svg.startsWith('<svg'));
    assert.equal(qr.body.version, '1.0.7');
    assert.equal(qr.body.minutes, 60);
    assert.ok(new Date(qr.body.expiresAt).getTime() > Date.now() + 55 * 60 * 1000);
    code = extras.code;

    // The Wi-Fi password is only in the QR: nothing of it is kept.
    const kept = await server.pool.query('SELECT * FROM pairing_codes WHERE code = $1', [code]);
    assert.equal(JSON.stringify(kept.rows).includes('secret-pass'), false);

    // The quick-install QR: a link any camera opens, a page with the download and the app link.
    assert.equal(qr.body.link, `http://console.test/api/android/get?c=${code}`);
    assert.ok(qr.body.linkSvg.startsWith('<svg'));
    const page = await new Client(server.url).get(`/api/android/get?c=${code}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(page.text, /href="\/api\/android\/download"/);
    assert.ok(page.text.includes(`intent://setup?server=${encodeURIComponent('http://console.test')}`) && page.text.includes(`code=${code}#Intent;scheme=screenwarden;`) && page.text.includes('package=com.familyscreenwarden.kids'));
    const nasty = await new Client(server.url).get('/api/android/get?c=%3Cscript%3Ealert(1)%3C/script%3E');
    assert.equal(nasty.text.includes('<script>'), false);

    // Bad input.
    assert.equal((await parent.post('/api/devices/android-qr', { kidId: NOBODY })).status, 404);
    assert.equal((await parent.post('/api/devices/android-qr', { kidId: kid, wifi: { ssid: '' } })).status, 400);
    assert.equal((await parent.post('/api/devices/android-qr', { kidId: kid, wifi: { ssid: 'x', security: 'WPA3' } })).status, 400);
    assert.equal((await new Client(server.url).post('/api/devices/android-qr', { kidId: kid })).status, 401);
  });

  it("the app download Android's setup does is public and matches the checksum", async () => {
    const dl = await download('/api/android/download?v=1.0.7');
    assert.equal(dl.status, 200);
    assert.equal(sha(dl.bytes), sha(APK_107));
    assert.equal(dl.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(dl.headers.get('content-disposition') ?? '', /FamilyScreenWardenKids-1\.0\.7\.apk/);
    assert.equal(sha((await download('/api/android/download')).bytes), sha(APK_107));
    assert.equal((await download('/api/android/download?v=9.9.9')).status, 404);
    assert.equal((await download('/api/android/download?v=..%2F..%2Fetc')).status, 404);
  });

  it('the phone checks the code, then pairs as the kid', async () => {
    const check = await phoneClient().post('/api/warden/setup/check', { code });
    assert.equal(check.status, 200, check.text);
    assert.equal(check.body.family, 'cade@example.com');
    assert.equal(check.body.oneKid, true);
    assert.ok(check.body.minutesLeft >= 59 && check.body.minutesLeft <= 60);
    assert.deepEqual(check.body.kids, [{ id: kid, name: 'Mia Test', color: check.body.kids[0].color, avatar: null }]);
    // Typed by hand with a dash and small letters: the same code.
    assert.equal((await phoneClient().post('/api/warden/setup/check', { code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}` })).status, 200);

    const wrong = await phoneClient().post('/api/warden/setup/check', { code: 'AAAA-BBBB' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /wrong or has run out/);
    const bad = await phoneClient().post('/api/android/pair', { code: 'AAAA-BBBB', memberId: kid, deviceId: 'phone-test-0001' });
    assert.equal(bad.status, 400);
    assert.equal((await phoneClient().post('/api/android/pair', { code, memberId: NOBODY, deviceId: 'phone-test-0001' })).status, 400);
    assert.equal((await phoneClient().post('/api/android/pair', { code, memberId: kid, deviceId: 'short' })).status, 400);

    const pair = await phoneClient().post('/api/android/pair', { code, memberId: kid, deviceId: 'phone-test-0001', model: 'Google Pixel 7a', version: '1.0.7' });
    assert.equal(pair.status, 200, pair.text);
    assert.ok(pair.body.token.length >= 32);
    assert.equal(Buffer.from(pair.body.secret, 'base64').length, 32);
    assert.match(pair.body.computerId, UUID);
    assert.equal(pair.body.name, "Mia's phone");
    assert.deepEqual(pair.body.member, { id: kid, name: 'Mia Test' });
    assert.deepEqual(pair.body.warnMinutes, [10, 5]);

    // The same code from another phone: refused. From the same phone: it pairs its own row again.
    const other = await phoneClient().post('/api/android/pair', { code, memberId: kid, deviceId: 'phone-test-9999' });
    assert.equal(other.status, 409);
    const again = await phoneClient().post('/api/android/pair', { code, memberId: kid, deviceId: 'phone-test-0001', version: '1.0.7' });
    assert.equal(again.status, 200);
    assert.equal(again.body.computerId, pair.body.computerId);
    assert.notEqual(again.body.token, pair.body.token);
    // The first token stopped working.
    assert.equal((await phoneClient(pair.body.token).post('/api/warden/sync', {})).status, 401);

    ({ token, secret, computerId } = again.body);
    phone = phoneClient(token);

    const devices = await parent.get('/api/devices');
    assert.equal(devices.body.devices.length, 1);
    assert.equal(devices.body.devices[0].id, computerId);
    assert.equal(devices.body.devices[0].platform, 'android');
    assert.equal(devices.body.devices[0].name, "Mia's phone");
    assert.equal(devices.body.devices[0].model, 'Google Pixel 7a');
    // Only the hash of the token is kept.
    const row = await server.pool.query('SELECT token_hash FROM devices WHERE id = $1', [computerId]);
    assert.equal(row.rows[0].token_hash, sha(Buffer.from(token)));
  });

  it('every phone route needs the token', async () => {
    for (const p of ['/api/warden/sync', '/api/warden/launcher', '/api/warden/launcher/act', '/api/warden/pin', '/api/warden/redeem', '/api/android/request', '/api/android/friend']) {
      assert.equal((await phoneClient().post(p, {})).status, 401, p);
      assert.equal((await phoneClient('x'.repeat(43)).post(p, {})).status, 401, p);
    }
    assert.equal((await phoneClient().get(`/api/android/apk/${NOBODY}`)).status, 401);
    assert.equal((await phoneClient(token).get('/api/warden/nothing-here')).status, 404);
  });

  it('the sync answer has the rules, the phone lock-downs, the contacts and the app update', async () => {
    await parent.post(`/api/kids/${kid}/contacts`, { name: 'Mom', phone: '(555) 010-2231', always: true });
    await parent.post(`/api/kids/${kid}/contacts`, { name: 'Aunt Sam', phone: '555-010-9025', always: false });
    assert.equal((await parent.post(`/api/kids/${kid}/contacts`, { name: 'X', phone: 'call me' })).status, 400);
    const rules = { blockSettings: true, blockReset: true, blockSafeBoot: true, blockInstalls: true, blockAccounts: false, blockUsb: true, emergencyNumber: '112', playMinutes: 15 };
    const saved = await parent.send('PUT', `/api/kids/${kid}/phone-rules`, rules);
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.body.rules, rules);
    assert.equal((await parent.send('PUT', `/api/kids/${kid}/phone-rules`, { ...rules, emergencyNumber: 'help' })).status, 400);
    assert.equal((await parent.send('PUT', `/api/kids/${kid}/phone-rules`, { ...rules, playMinutes: 600 })).status, 400);
    await parent.post(`/api/kids/${kid}/apps`, { kind: 'app', platform: 'android', identifier: 'com.android.chrome', name: 'Chrome', limitMinutes: 30 });
    await parent.post(`/api/kids/${kid}/apps`, { kind: 'app', platform: 'android', identifier: 'org.khanacademy.android', name: 'Khan Academy Kids', free: true });
    await parent.post(`/api/kids/${kid}/apps`, { kind: 'app', platform: 'android', identifier: 'com.zhiliaoapp.musically', name: 'TikTok', allowed: false });
    await parent.post(`/api/kids/${kid}/apps`, { kind: 'app', platform: 'windows', identifier: 'minecraft.exe', name: 'Minecraft' });
    await parent.post(`/api/kids/${kid}/apps`, { kind: 'site', identifier: 'https://www.PBSkids.org/games', name: 'PBS Kids' });

    const s = await sync({ device: { model: 'Google Pixel 7a', android: '15', battery: 64, charging: false, deviceOwner: true, usageAccess: true } });
    // Every field the app's Snapshot model reads.
    assert.ok(Math.abs(new Date(s.serverTime).getTime() - Date.now()) < 5000);
    assert.equal(s.day, TODAY);
    assert.equal(s.dayEndsAt, '2026-03-12T06:00:00.000Z'); // the next midnight in Denver
    assert.equal(s.paused, false);
    assert.deepEqual(s.kid, { id: kid, name: 'Mia Test' });
    assert.deepEqual(s.allowance, { generalMinutes: 120, baseMinutes: 120, extraMinutes: 0, appMinutes: {} });
    assert.deepEqual(s.used, { generalSeconds: 0, appSeconds: {} });
    assert.deepEqual(s.warnMinutes, [10, 5]);
    assert.equal(s.locked, false);
    assert.equal(s.shutdown, null);
    assert.deepEqual(s.requests, []);
    assert.deepEqual(s.voidUnlocks, []);
    assert.deepEqual(s.safeSearch, { search: true, youTube: true });
    assert.deepEqual(s.launcher, { enabled: true, layout: 'bright', theme: 'galaxy', lookLocked: false });
    assert.equal(s.watchOnly, null);
    assert.equal(s.fastSync, false);
    // Wednesday afternoon: tonight's bedtime is 20:30 to 06:00 in Denver.
    assert.deepEqual(s.bedtime, { at: '2026-03-12T02:30:00.000Z', until: '2026-03-12T12:00:00.000Z', warnMinutes: [10, 5] });

    // Only allowed apps for a phone, keyed by the app's id, with the package in exes.
    assert.deepEqual(s.apps.map((a: Json) => a.name).sort(), ['Chrome', 'Khan Academy Kids']);
    const chrome = s.apps.find((a: Json) => a.name === 'Chrome');
    assert.match(chrome.key, UUID);
    assert.deepEqual({ ...chrome, key: 'k' }, { key: 'k', name: 'Chrome', category: 'other', exes: ['com.android.chrome'], allowed: true, budgeted: false, limitMinutes: 30, free: false });
    assert.equal(s.apps.find((a: Json) => a.name === 'Khan Academy Kids').free, true);
    assert.deepEqual(s.sites, [{ host: 'pbskids.org', tile: 'PBS Kids', folder: null, from: null, to: null }]);

    assert.deepEqual(s.phone.rules, rules);
    assert.deepEqual(s.phone.contacts.map((c: Json) => [c.name, c.phone, c.always]), [['Aunt Sam', '555-010-9025', false], ['Mom', '(555) 010-2231', true]]);
    assert.match(s.phone.contacts[0].id, UUID);
    assert.deepEqual(s.texting, { friends: [], asked: [], blocked: [], drop: [] });
    assert.deepEqual(s.apkInstalls, []);
    assert.deepEqual(s.update, { version: '1.0.7', url: '/api/android/download?v=1.0.7', sha256: sha(APK_107), size: APK_107.length });

    // What the phone said about itself shows in the console.
    const info = await parent.get(`/api/kids/${kid}/phone`);
    assert.equal(info.status, 200);
    assert.deepEqual(
      { ...info.body.phones[0], lastSeenAt: 'x' },
      { id: computerId, name: "Mia's phone", model: 'Google Pixel 7a', osVersion: 'Android 15', appVersion: '1.0.7', lastSeenAt: 'x', battery: 64, charging: false, deviceOwner: true, usageAccess: true, canUnlock: true },
    );
    assert.deepEqual(info.body.rules, rules);
    assert.deepEqual(info.body.launcher, { layout: 'bright', theme: 'galaxy', lookLocked: false });
    assert.deepEqual(info.body.contacts.map((c: Json) => [c.name, c.canCall, c.canText, c.always]), [['Aunt Sam', true, true, false], ['Mom', true, true, true]]);
    const dash = await parent.get('/api/dashboard');
    assert.equal(dash.body.devices[0].status, 'in_use');
    assert.equal(dash.body.devices[0].osVersion, 'Android 15');
  });

  it('time the phone reports counts for the kid, in the console and for other devices', async () => {
    const s0 = await sync();
    const chrome = s0.apps.find((a: Json) => a.name === 'Chrome').key;
    const khan = s0.apps.find((a: Json) => a.name === 'Khan Academy Kids').key;
    // 20 min of Chrome, 12 min of a free app, 5 min on a website tile: 25 min count (the free app does not).
    const s1 = await sync({
      usage: { day: TODAY, generalSeconds: 1500, appSeconds: { [chrome]: 1200, [khan]: 720, site: 300 } },
      live: { state: 'ok', foreground: chrome, foregroundName: 'Chrome', running: [], launcher: true, observeOnly: false },
    });
    assert.deepEqual(s1.used, { generalSeconds: 1500, appSeconds: { [chrome]: 1200, [khan]: 720, site: 300 } });

    const detail = await parent.get(`/api/kids/${kid}`);
    assert.deepEqual(detail.body.today, { limitMinutes: 120, usedMinutes: 25, leftMinutes: 95, locked: false, lockReason: null });
    const used = Object.fromEntries(detail.body.apps.map((a: Json) => [a.name, a.usedMinutes]));
    assert.equal(used['Chrome'], 20);
    assert.equal(used['Khan Academy Kids'], 12);
    const dash = await parent.get('/api/dashboard');
    assert.equal(dash.body.kids[0].usedMinutes, 25);
    assert.equal(dash.body.kids[0].statusText, 'Using Chrome');
    assert.equal(dash.body.week[6].minutes[kid], 25);

    // A repeat or a late, lower report changes nothing; a report for another day is dropped.
    await sync({ usage: { day: TODAY, generalSeconds: 900, appSeconds: { [chrome]: 600 } } });
    const s2 = await sync({ usage: { day: '2026-03-10', generalSeconds: 9000, appSeconds: {} } });
    assert.equal(s2.used.generalSeconds, 1500);
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.today.usedMinutes, 25);

    // A PC on the simple device API reports 10 minutes: the phone sees them as time used elsewhere.
    const { device: pc } = await pairDevice(server, parent, kid, 'windows', 'Mia PC');
    await pc.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'minecraft.exe', name: 'Minecraft', minutes: 10 }] });
    const s3 = await sync();
    assert.equal(s3.used.generalSeconds, 1500 + 600);
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.today.usedMinutes, 35);
    // And the PC sees the phone's time.
    const pcSync = await pc.post('/api/device/sync', {});
    assert.equal(pcSync.body.rules.usedMinutes, 35);
    // The PC still gets the simple shape, nothing of the phone's.
    assert.equal(pcSync.body.phone, undefined);

    // Bad usage is refused, not half-stored.
    assert.equal((await phone.post('/api/warden/sync', { usage: { day: TODAY, generalSeconds: 'lots' } })).status, 400);
    assert.equal((await phone.post('/api/warden/sync', { usage: { day: TODAY, generalSeconds: 10, appSeconds: { [chrome]: -5 } } })).status, 400);
  });

  it('apps the phone finds show up turned off; an app allowed by name becomes the one the phone has', async () => {
    await sync({ installed: [{ name: 'Spotify', exe: 'com.spotify.music' }, { name: 'Duolingo', exe: 'com.duolingo' }, { name: 'Chrome', exe: 'com.android.chrome' }, { name: 'Bad', exe: 'not a package' }] });
    let apps = (await parent.get(`/api/kids/${kid}`)).body.apps as Json[];
    const spotify = apps.find((a) => a.identifier === 'com.spotify.music');
    assert.deepEqual([spotify?.name, spotify?.allowed, spotify?.platform], ['Spotify', false, 'android']);
    assert.equal(apps.filter((a) => a.identifier === 'com.android.chrome').length, 1);
    assert.equal(apps.some((a) => a.identifier === 'not a package'), false);
    // Not allowed, so not in the phone's list.
    assert.equal((await sync()).apps.some((a: Json) => a.name === 'Spotify'), false);

    // The kid asks for "Toca Boca World" by name from the launcher, a parent says yes: allowed by name.
    const asked = await phone.post('/api/warden/launcher/act', { action: 'ask', what: 'app', text: 'Toca Boca World' });
    assert.deepEqual(asked.body, { ok: true, message: 'Sent to a parent. The answer shows up here.' });
    const req = (await parent.get('/api/requests')).body.requests.find((r: Json) => r.detail === 'Toca Boca World');
    assert.equal((await parent.post(`/api/requests/${req.id}/decide`, { approve: true })).status, 200);
    const byName = (await sync()).apps.find((a: Json) => a.name === 'Toca Boca World');
    assert.deepEqual(byName.exes, ['toca boca world']);
    // Then the phone gets the app: the same row now carries the package (one app in the list, not two).
    await sync({ installed: [{ name: 'Toca Boca World', exe: 'com.tocaboca.tocalifeworld' }] });
    apps = (await parent.get(`/api/kids/${kid}`)).body.apps as Json[];
    const toca = apps.filter((a) => /toca/i.test(a.name));
    assert.equal(toca.length, 1);
    assert.deepEqual([toca[0]?.identifier, toca[0]?.allowed, toca[0]?.platform], ['com.tocaboca.tocalifeworld', true, 'android']);
    assert.equal(toca[0]?.id, byName.key);
  });

  it('the launcher shows the kid and the chores a parent made', async () => {
    const sibling = await createKid(parent, 'Leo Test');
    const made = await parent.post(`/api/kids/${kid}/chores`, { name: 'Empty the dishwasher', minutes: 20, repeat: 'daily' });
    assert.equal(made.status, 201, made.text);
    assert.deepEqual({ ...made.body.chore, id: 'x', createdAt: 'x' }, { id: 'x', kidId: kid, name: 'Empty the dishwasher', minutes: 20, repeat: 'daily', active: true, today: 'todo', createdAt: 'x' });
    await parent.post(`/api/kids/${kid}/chores`, { name: 'Tidy your room', minutes: 0 });
    await parent.post(`/api/kids/${sibling}/chores`, { name: 'Feed the cat', minutes: 10, repeat: 'daily' });

    const info = await phone.post('/api/warden/launcher', {});
    assert.equal(info.status, 200, info.text);
    // What the launcher page reads: kid, chores (id, title, status, minutes), choreMinutes, dayText, bedtimeText.
    assert.deepEqual(info.body.kid, { id: kid, name: 'Mia', emoji: null, color: info.body.kid.color });
    assert.deepEqual(info.body.chores, [
      { id: made.body.chore.id, title: 'Empty the dishwasher', status: 'todo', minutes: 20, timer: false },
      { id: info.body.chores[1].id, title: 'Tidy your room', status: 'todo', minutes: 0, timer: false },
    ]);
    assert.equal(info.body.choreMinutes, 0);
    assert.equal(info.body.dayText, 'Wednesday');
    assert.equal(info.body.bedtimeText, 'Bedtime at 8:30 pm');
    // The chat is empty until someone writes. Nothing else is in the answer.
    assert.deepEqual(info.body.chat, []);
    assert.deepEqual(Object.keys(info.body).sort(), ['bedtimeText', 'chat', 'choreMinutes', 'chores', 'dayText', 'kid']);
  });

  it('a chore: the kid marks it done, a parent approves, the minutes are added to today', async () => {
    const chores = (await phone.post('/api/warden/launcher', {})).body.chores as Json[];
    const dishes = chores[0] as Json;
    const done = await phone.post('/api/warden/launcher/act', { action: 'chore', id: dishes.id });
    assert.deepEqual(done.body, { ok: true, message: 'Sent! A parent will check it.' });
    // A second tap does not ask twice.
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'chore', id: dishes.id })).body, { ok: true, message: 'Already done.' });
    assert.equal((await phone.post('/api/warden/launcher', {})).body.chores[0].status, 'waiting');
    // Not hers, not a chore.
    const leoChore = (await server.pool.query("SELECT id FROM chores WHERE name = 'Feed the cat'")).rows[0].id;
    assert.equal((await phone.post('/api/warden/launcher/act', { action: 'chore', id: leoChore })).status, 404);
    assert.equal((await phone.post('/api/warden/launcher/act', { action: 'chore', id: 'nope' })).status, 404);

    const waiting = await parent.get('/api/chore-approvals');
    assert.equal(waiting.status, 200);
    assert.equal(waiting.body.approvals.length, 1);
    const a = waiting.body.approvals[0];
    assert.deepEqual({ ...a, id: 'x', createdAt: 'x' }, {
      id: 'x', choreId: dishes.id, choreName: 'Empty the dishwasher', kidId: kid, kidName: 'Mia Test', deviceName: "Mia's phone",
      minutes: 20, day: TODAY, status: 'pending', createdAt: 'x', decidedAt: null,
    });
    assert.equal((await parent.get(`/api/kids/${kid}/chores`)).body.chores[0].today, 'waiting');
    // No time yet.
    assert.equal((await sync()).allowance.generalMinutes, 120);

    const yes = await parent.post(`/api/chore-approvals/${a.id}/decide`, { approve: true });
    assert.equal(yes.status, 200, yes.text);
    assert.equal(yes.body.approval.status, 'approved');
    assert.equal((await parent.post(`/api/chore-approvals/${a.id}/decide`, { approve: true })).status, 409);
    assert.equal((await parent.post(`/api/chore-approvals/${a.id}/decide`, { approve: 'yes' })).status, 400);
    assert.equal((await parent.post(`/api/chore-approvals/${NOBODY}/decide`, { approve: true })).status, 404);

    const s = await sync();
    assert.deepEqual(s.allowance, { generalMinutes: 140, baseMinutes: 120, extraMinutes: 20, appMinutes: {} });
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.today.limitMinutes, 140);
    const grant = await server.pool.query("SELECT day, minutes FROM time_grants WHERE kid_id = $1 AND reason = 'chore'", [kid]);
    assert.deepEqual(grant.rows, [{ day: TODAY, minutes: 20 }]);
    const info = (await phone.post('/api/warden/launcher', {})).body;
    assert.equal(info.chores[0].status, 'done');
    assert.equal((await parent.get('/api/chore-approvals')).body.approvals.length, 0);
    assert.equal((await parent.get('/api/chore-approvals?status=all')).body.approvals.length, 1);
    // A chore worth 0 minutes, declined: no time, and it can be done again.
    const room = chores[1] as Json;
    await phone.post('/api/warden/launcher/act', { action: 'chore', id: room.id });
    const second = (await parent.get('/api/chore-approvals')).body.approvals[0];
    assert.equal((await parent.post(`/api/chore-approvals/${second.id}/decide`, { approve: false })).body.approval.status, 'declined');
    assert.equal((await sync()).allowance.extraMinutes, 20);
    assert.equal((await phone.post('/api/warden/launcher', {})).body.chores[1].status, 'todo');

    // Tomorrow the daily chore is to do again, and the day's extra time is gone.
    server.setNow(new Date(WEDNESDAY_AFTERNOON.getTime() + 24 * 3600_000));
    assert.equal((await phone.post('/api/warden/launcher', {})).body.chores[0].status, 'todo');
    assert.equal((await sync()).allowance.extraMinutes, 0);
    server.setNow(WEDNESDAY_AFTERNOON);
  });

  it('chores can be changed and removed by a parent only', async () => {
    const list = (await parent.get(`/api/kids/${kid}/chores`)).body.chores as Json[];
    const room = list[1] as Json;
    const patched = await parent.patch(`/api/chores/${room.id}`, { name: 'Tidy your desk', minutes: 15, repeat: 'weekly' });
    assert.deepEqual([patched.body.chore.name, patched.body.chore.minutes, patched.body.chore.repeat], ['Tidy your desk', 15, 'weekly']);
    assert.equal((await parent.patch(`/api/chores/${room.id}`, { minutes: 999 })).status, 400);
    assert.equal((await parent.patch(`/api/chores/${room.id}`, { repeat: 'hourly' })).status, 400);
    assert.equal((await parent.patch(`/api/chores/${room.id}`, {})).status, 400);
    assert.equal((await parent.post(`/api/kids/${kid}/chores`, { name: '', minutes: 5 })).status, 400);
    assert.equal((await parent.post(`/api/kids/${kid}/chores`, { name: 'x', minutes: 5, repeat: 'never' })).status, 400);
    // Switched off: not on the launcher.
    await parent.patch(`/api/chores/${room.id}`, { active: false });
    assert.equal((await phone.post('/api/warden/launcher', {})).body.chores.length, 1);
    assert.equal((await parent.del(`/api/chores/${room.id}`)).status, 200);
    assert.equal((await parent.del(`/api/chores/${room.id}`)).status, 404);
    assert.equal((await parent.get(`/api/kids/${kid}/chores`)).body.chores.length, 1);
  });

  it('asking for an app by package: sent once, a parent says yes, the phone hears it', async () => {
    const ask = await phone.post('/api/android/request', { package: 'com.roblox.client', name: 'Roblox' });
    assert.equal(ask.status, 200, ask.text);
    assert.equal(ask.body.status, 'sent');
    assert.match(ask.body.id, UUID);
    const again = await phone.post('/api/android/request', { package: 'com.roblox.client', name: 'Roblox' });
    assert.equal(again.body.status, 'pending');
    assert.equal(again.body.id, ask.body.id);
    assert.equal((await phone.post('/api/android/request', { package: 'not a package' })).status, 400);

    const pending = (await sync()).requests.find((r: Json) => r.id === ask.body.id);
    assert.deepEqual(pending, { id: ask.body.id, exe: 'com.roblox.client', name: 'Roblox', status: 'pending' });
    const reqs = (await parent.get('/api/requests')).body.requests as Json[];
    const rq = reqs.find((r) => r.identifier === 'com.roblox.client');
    assert.deepEqual([rq?.kind, rq?.detail, rq?.deviceName, rq?.kidName], ['app', 'Roblox', "Mia's phone", 'Mia Test']);
    await parent.post(`/api/requests/${rq?.id}/decide`, { approve: true });
    const s = await sync();
    assert.ok(s.apps.some((a: Json) => a.allowed && a.exes.includes('com.roblox.client')));
    assert.equal(s.requests.find((r: Json) => r.id === ask.body.id).status, 'allowed');
    // Asking again for something allowed says so.
    assert.equal((await phone.post('/api/android/request', { package: 'com.roblox.client', name: 'Roblox' })).body.status, 'allowed');

    // A "no" stands for the rest of the day.
    const no = await phone.post('/api/android/request', { package: 'com.zhiliaoapp.musically', name: 'TikTok' });
    await parent.post(`/api/requests/${no.body.id}/decide`, { approve: false });
    const after = await phone.post('/api/android/request', { package: 'com.zhiliaoapp.musically', name: 'TikTok' });
    assert.deepEqual(after.body, { status: 'denied', message: 'A parent already said no to this today.' });
    assert.equal((await sync()).requests.find((r: Json) => r.id === no.body.id).status, 'denied');
  });

  it('asking for time and a website from the launcher', async () => {
    const time = await phone.post('/api/warden/launcher/act', { action: 'ask', what: 'time', minutes: 30 });
    assert.deepEqual(time.body, { ok: true, message: 'Sent to a parent. The answer shows up here.' });
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'ask', what: 'time', minutes: 15 })).body, { ok: true, message: 'Already asked. Waiting for a parent.' });
    const site = await phone.post('/api/warden/launcher/act', { action: 'ask', what: 'site', text: 'https://www.Scratch.mit.edu/projects' });
    assert.equal(site.body.ok, true);
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'ask', what: 'site', text: 'not a site' })).body, { ok: false, message: 'Type the website address, like khanacademy.org.' });
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'ask', what: 'app' })).body, { ok: false, message: 'Type what you want first.' });
    assert.equal((await phone.post('/api/warden/launcher/act', { action: 'ask', what: 'pony' })).status, 400);
    assert.equal((await phone.post('/api/warden/launcher/act', {})).status, 400);

    const wire = (await sync()).requests as Json[];
    assert.ok(wire.some((r) => r.exe === 'time:30' && r.name === '30 more minutes' && r.status === 'pending'));
    assert.ok(wire.some((r) => r.exe === 'site:scratch.mit.edu' && r.status === 'pending'));
    const reqs = (await parent.get('/api/requests')).body.requests as Json[];
    const before = (await sync()).allowance.generalMinutes;
    for (const r of reqs.filter((x) => x.status === 'pending')) await parent.post(`/api/requests/${r.id}/decide`, { approve: true });
    const s = await sync();
    assert.equal(s.allowance.generalMinutes, before + 30);
    assert.ok(s.sites.some((x: Json) => x.host === 'scratch.mit.edu'));
  });

  it('family chat: kids write from the launcher, parents read and write in the console, everyone sees it', async () => {
    // Leo (the sibling) gets a phone too.
    const leoId = (await parent.get('/api/kids')).body.kids.find((k: Json) => k.name === 'Leo Test').id;
    const qr = await parent.post('/api/devices/android-qr', { kidId: leoId });
    const leoPair = await phoneClient().post('/api/android/pair', { code: qr.body.code, memberId: leoId, deviceId: 'phone-test-leo1' });
    const leo = phoneClient(leoPair.body.token);

    // What launcher.js sends: { action: 'chat', text }.
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'chat', text: '  Can we have tacos?  ' })).body, { ok: true, message: '' });
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'chat', text: '   ' })).body, { ok: false, message: 'Type a message first.' });
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'chat' })).body, { ok: false, message: 'Type a message first.' });
    const long = await phone.post('/api/warden/launcher/act', { action: 'chat', text: 'x'.repeat(301) });
    assert.deepEqual(long.body, { ok: false, message: 'That message is too long (at most 300 characters).' });
    assert.equal((await phone.post('/api/warden/launcher/act', { action: 'chat', text: 'y'.repeat(300) })).body.ok, true);
    assert.equal((await leo.post('/api/warden/launcher/act', { action: 'chat', text: 'Me too!' })).body.ok, true);

    // A parent reads every message and answers.
    const read = await parent.get('/api/chat');
    assert.equal(read.status, 200);
    assert.equal(read.body.maxLength, 300);
    assert.deepEqual(read.body.messages.map((m: Json) => [m.from, m.text.slice(0, 20), m.kidId]), [
      ['Mia Test', 'Can we have tacos?', kid], ['Mia Test', 'y'.repeat(20), kid], ['Leo Test', 'Me too!', leoId],
    ]);
    assert.deepEqual(Object.keys(read.body.messages[0]).sort(), ['at', 'color', 'from', 'id', 'kidId', 'text']);
    const reply = await parent.post('/api/chat', { text: 'Yes, at six.' });
    assert.equal(reply.status, 201, reply.text);
    assert.deepEqual({ ...reply.body.message, id: 'x', at: 'x' }, { id: 'x', kidId: null, from: 'Parent', color: null, text: 'Yes, at six.', at: 'x' });
    assert.equal((await parent.post('/api/chat', { text: '' })).status, 400);
    assert.equal((await parent.post('/api/chat', { text: 'z'.repeat(301) })).status, 400);
    assert.equal((await parent.post('/api/chat', {})).status, 400);

    // Each launcher gets the chat in the shape the page draws, with its own messages marked.
    const mine = (await phone.post('/api/warden/launcher', {})).body.chat as Json[];
    assert.deepEqual(mine.map((m) => [m.who, m.text.slice(0, 20), m.mine]), [
      ['Mia', 'Can we have tacos?', true], ['Mia', 'y'.repeat(20), true], ['Leo', 'Me too!', false], ['Parent', 'Yes, at six.', false],
    ]);
    assert.deepEqual(Object.keys(mine[0] as Json).sort(), ['at', 'color', 'emoji', 'id', 'mine', 'text', 'who']);
    assert.match((mine[0] as Json).id, UUID);
    assert.ok(!Number.isNaN(new Date((mine[0] as Json).at).getTime()));
    const leos = (await leo.post('/api/warden/launcher', {})).body.chat as Json[];
    assert.deepEqual(leos.map((m) => m.mine), [false, false, true, false]);

    // A parent can take a message away: it is gone for everyone.
    assert.equal((await parent.del(`/api/chat/${read.body.messages[1].id}`)).status, 200);
    assert.equal((await parent.del(`/api/chat/${read.body.messages[1].id}`)).status, 404);
    assert.equal((await parent.del('/api/chat/not-an-id')).status, 404);
    assert.equal((await leo.post('/api/warden/launcher', {})).body.chat.length, 3);

    // Six a minute per kid; another kid is not slowed down by it.
    // (One of Mia's two earlier messages was deleted, so five more make six.)
    for (let i = 0; i < 5; i++) assert.equal((await phone.post('/api/warden/launcher/act', { action: 'chat', text: `hi ${i}` })).body.ok, true);
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'chat', text: 'again' })).body, { ok: false, message: 'Slow down a little!' });
    assert.equal((await leo.post('/api/warden/launcher/act', { action: 'chat', text: 'still here' })).body.ok, true);

    // Old messages leave the launcher after 7 days; only the newest 40 are sent.
    await server.pool.query("UPDATE family_chat SET created_at = now() - interval '8 days' WHERE text = 'Can we have tacos?'");
    const after = (await phone.post('/api/warden/launcher', {})).body.chat as Json[];
    assert.equal(after.some((m) => m.text === 'Can we have tacos?'), false);
    assert.equal((await parent.get('/api/chat')).body.messages.some((m: Json) => m.text === 'Can we have tacos?'), true);
    await server.pool.query(
      "INSERT INTO family_chat (account_id, kid_id, text, created_at) SELECT account_id, id, 'bulk ' || g, now() - (g || ' minutes')::interval FROM kids, generate_series(2, 60) g WHERE kids.id = $1",
      [leoId],
    );
    const capped = (await phone.post('/api/warden/launcher', {})).body.chat as Json[];
    assert.equal(capped.length, 40);
    assert.equal(capped[capped.length - 1]?.text, 'still here');
    await parent.del(`/api/devices/${leoPair.body.computerId}`);
  });

  it('the launcher colours: the kid picks them, a parent can lock them, nothing the page sends is refused', async () => {
    // What launcher.js sends: { action: 'look', layout: <stored layout or 'bright'>, theme }.
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'look', layout: 'bright', theme: 'ocean' })).body, { ok: true, message: '' });
    assert.deepEqual((await sync()).launcher, { enabled: true, layout: 'bright', theme: 'ocean', lookLocked: false });
    for (const theme of ['galaxy', 'jungle', 'sunset']) {
      assert.equal((await phone.post('/api/warden/launcher/act', { action: 'look', layout: 'bright', theme })).body.ok, true, theme);
      assert.equal((await sync()).launcher.theme, theme);
    }
    // The old layouts are still stored when sent; a name the server does not know is not an error, it just stays.
    assert.equal((await phone.post('/api/warden/launcher/act', { action: 'look', layout: 'gamer', theme: 'ocean' })).body.ok, true);
    const odd = await phone.post('/api/warden/launcher/act', { action: 'look', layout: 'plaid', theme: 'neon' });
    assert.deepEqual([odd.status, odd.body], [200, { ok: true, message: '' }]);
    assert.equal((await phone.post('/api/warden/launcher/act', { action: 'look', theme: 'jungle' })).body.ok, true);
    assert.deepEqual((await sync()).launcher, { enabled: true, layout: 'gamer', theme: 'jungle', lookLocked: false });

    const locked = await parent.send('PUT', `/api/kids/${kid}/launcher`, { layout: 'bright', theme: 'sunset', lookLocked: true });
    assert.deepEqual(locked.body.launcher, { layout: 'bright', theme: 'sunset', lookLocked: true });
    assert.equal((await parent.send('PUT', `/api/kids/${kid}/launcher`, { layout: 'bright', theme: 'neon', lookLocked: true })).status, 400);
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'look', layout: 'bright', theme: 'galaxy' })).body, { ok: false, message: 'A parent picked these colours.' });
    assert.equal((await sync()).launcher.theme, 'sunset');
    // From the PIN menu (the phone checked the PIN) a parent can still change it.
    assert.equal((await phone.post('/api/warden/launcher/act', { action: 'look', layout: 'bright', theme: 'jungle', what: 'grownup' })).body.ok, true);
    assert.deepEqual((await sync()).launcher, { enabled: true, layout: 'bright', theme: 'jungle', lookLocked: true });
    // An action this server does not know: a plain "no", not an error.
    const unknown = await phone.post('/api/warden/launcher/act', { action: 'cheer', id: 'x' });
    assert.deepEqual([unknown.status, unknown.body], [200, { ok: false, message: 'That is not available here.' }]);
  });

  it('texts: copied for the parents, a friend asked for, a stranger held and blocked, photos', async () => {
    // "Ask to add a friend": a request like any other; yes makes a contact the kid can text.
    const fask = await phone.post('/api/android/friend', { name: 'Ava', phone: '555-014-2290', note: 'In my class' });
    assert.equal(fask.status, 200, fask.text);
    assert.equal(fask.body.status, 'sent');
    assert.equal((await phone.post('/api/android/friend', { name: 'Ava', phone: '5550142290' })).body.status, 'pending');
    assert.equal((await phone.post('/api/android/friend', { name: 'Mom', phone: '+1 555 010 2231' })).body.status, 'approved');
    assert.equal((await phone.post('/api/android/friend', { name: 'X', phone: 'call me' })).status, 400);
    let s = await sync();
    assert.deepEqual(s.texting.friends, []);
    assert.deepEqual(s.texting.asked, [{ name: 'Ava', phone: '5550142290', status: 'pending' }]);
    const req = (await parent.get('/api/requests')).body.requests.find((r: Json) => r.kind === 'contact');
    assert.deepEqual([req.detail, req.identifier, req.status], ['Ava', '5550142290', 'pending']);
    await parent.post(`/api/requests/${req.id}/decide`, { approve: true });

    const now = Date.now();
    s = await sync({
      texts: [
        { id: 'm1', thread: ['+1 555 010 2231', '5550142290'], dir: 'in', from: '+15550102231', body: 'Who wants tacos?', at: now - 60000, media: [{ id: 'p1', type: 'image/jpeg' }] },
        { id: 'm2', thread: ['5550102231', '(555) 014-2290'], dir: 'out', body: 'Me!!', at: now - 30000 },
        { id: 'm3', thread: ['5550197733'], dir: 'in', from: '5550197733', body: 'hey is this mia?', at: now, status: 'held' },
      ],
    });
    assert.deepEqual(s.texting.friends.map((f: Json) => [f.name, f.phone]), [['Ava', '5550142290']]);
    assert.deepEqual(s.texting.asked, []);
    // Ava can be texted, not called: she is not in the phone's call list.
    assert.equal(s.phone.contacts.some((c: Json) => c.name === 'Ava'), false);

    const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(5000)]);
    const up = await raw('POST', '/api/android/text-media/m1/p1', JPG, { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg'});
    assert.equal(up.status, 201, up.text);
    // The same photo again is not stored twice.
    const twice = await raw('POST', '/api/android/text-media/m1/p1', JPG, { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' });
    assert.deepEqual([twice.status, twice.body.id], [200, up.body.id]);
    assert.equal((await raw('POST', '/api/android/text-media/m1/p2', JPG, { 'Content-Type': 'image/jpeg' })).status, 401);
    assert.equal((await raw('POST', '/api/android/text-media/m1/p2', JPG, { Authorization: `Bearer ${token}`, 'Content-Type': 'text/html' })).status, 415);

    let tx = (await parent.get(`/api/kids/${kid}/texts`)).body;
    assert.equal(tx.keepDays, 90);
    assert.equal(tx.threads.length, 1);
    const group = tx.threads[0];
    assert.equal(group.count, 2);
    assert.deepEqual([...group.names].sort(), ['Ava', 'Mom']);
    assert.deepEqual(group.last, { dir: 'out', fromName: null, body: 'Me!!' });
    assert.equal(tx.held.length, 1);
    assert.deepEqual([tx.held[0].body, tx.held[0].from, tx.held[0].fromName], ['hey is this mia?', '(555) 019-7733', null]);
    const th = (await parent.get(`/api/kids/${kid}/texts/thread?t=${encodeURIComponent(group.thread)}`)).body;
    assert.deepEqual(th.texts.map((t: Json) => [t.body, t.dir, t.fromName]), [['Who wants tacos?', 'in', 'Mom'], ['Me!!', 'out', null]]);
    const pic = await download(th.texts[0].media[0].url, { cookie: parent.cookie });
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get('content-type'), 'image/jpeg');
    assert.equal(sha(pic.bytes), sha(JPG));
    assert.equal((await download(th.texts[0].media[0].url)).status, 401);

    // A repeat of the same texts changes nothing.
    await sync({ texts: [{ id: 'm2', thread: ['5550102231', '5550142290'], dir: 'out', body: 'changed?', at: now }] });
    assert.equal((await parent.get(`/api/kids/${kid}/texts/thread?t=${encodeURIComponent(group.thread)}`)).body.texts[1].body, 'Me!!');

    // Block the stranger: the held text goes from the phone too.
    const blocked = await parent.post(`/api/kids/${kid}/blocked-numbers`, { phone: '(555) 019-7733' });
    assert.equal(blocked.status, 201);
    s = await sync();
    assert.deepEqual(s.texting.blocked, ['5550197733']);
    assert.deepEqual(s.texting.drop, ['m3']);
    tx = (await parent.get(`/api/kids/${kid}/texts`)).body;
    assert.equal(tx.held.length, 0);
    assert.deepEqual(tx.blocked.map((b: Json) => b.num), ['5550197733']);
    // The phone sending the dropped text again does not bring it back.
    await sync({ texts: [{ id: 'm3', thread: ['5550197733'], dir: 'in', from: '5550197733', body: 'hey is this mia?', at: now, status: 'held' }] });
    assert.equal((await parent.get(`/api/kids/${kid}/texts`)).body.held.length, 0);
    assert.equal((await parent.del(`/api/kids/${kid}/blocked-numbers/5550197733`)).status, 200);
    assert.deepEqual((await sync()).texting.blocked, []);

    // A held text a parent deletes.
    await sync({ texts: [{ id: 'm4', thread: ['5550111111'], dir: 'in', from: '5550111111', body: 'spam', at: now, status: 'held' }] });
    const held = (await parent.get(`/api/kids/${kid}/texts`)).body.held[0];
    assert.equal((await parent.post(`/api/texts/${held.id}/delete`)).status, 200);
    assert.ok((await sync()).texting.drop.includes('m4'));

    assert.equal((await phone.post('/api/warden/sync', { texts: [{ id: 'x', thread: ['555'], dir: 'sideways', at: now }] })).status, 400);
  });

  it('photos and videos: upload, list, Range, share link, deleted on the phone, delete', async () => {
    // What the phone's Camera and Movie Maker send: the file as the body, the rest in headers.
    const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(40_000)]);
    const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), crypto.randomBytes(300_000)]);
    const b64 = (t: string): string => Buffer.from(t, 'utf8').toString('base64');
    const upload = (body: Buffer, h: Record<string, string>, bearer = token): Promise<Reply> =>
      raw('POST', '/api/android/media', body, { Authorization: `Bearer ${bearer}`, 'X-Media-At': String(Date.now() - 5000), 'X-Media-Duration': '0', ...h });
    const ph = await upload(PHOTO, { 'Content-Type': 'image/jpeg', 'X-Media-Id': 'cam-1', 'X-Media-Kind': 'photo', 'X-Media-Title': b64('Our dog Pickles 🐶') });
    assert.equal(ph.status, 201, ph.text);
    assert.match(ph.body.id, UUID);
    assert.equal((await upload(PHOTO, { 'Content-Type': 'image/jpeg', 'X-Media-Id': 'cam-1', 'X-Media-Kind': 'photo', 'X-Media-Title': '' })).status, 200);
    const vh = { 'Content-Type': 'video/webm', 'X-Media-Id': 'mov-1', 'X-Media-Kind': 'movie', 'X-Media-Title': b64('Lego heist'), 'X-Media-At': String(Date.now()), 'X-Media-Duration': '42' };
    const vid = await upload(WEBM, vh);
    assert.equal(vid.status, 201, vid.text);
    const again = await upload(WEBM, vh);
    assert.deepEqual([again.status, again.body.id], [200, vid.body.id]);
    // Not a photo or video, or not what it says it is: the phone gives up on that one file (415).
    assert.equal((await upload(Buffer.from('hello'), { 'Content-Type': 'text/plain', 'X-Media-Id': 'x', 'X-Media-Kind': 'photo' })).status, 415);
    assert.equal((await upload(Buffer.from('not really a video at all'), { 'Content-Type': 'video/mp4', 'X-Media-Id': 'x2', 'X-Media-Kind': 'video' })).status, 415);
    assert.equal((await upload(PHOTO, { 'Content-Type': 'image/jpeg', 'X-Media-Id': 'x3', 'X-Media-Kind': 'photo' }, '')).status, 401);

    let md = (await parent.get(`/api/kids/${kid}/media`)).body;
    assert.equal(md.keepDays, 90);
    assert.deepEqual(md.items.map((i: Json) => i.kind), ['movie', 'photo']);
    const [mv, pi] = md.items;
    assert.deepEqual([mv.title, mv.durationSec, mv.size, mv.type], ['Lego heist', 42, WEBM.length, 'video/webm']);
    assert.equal(pi.title, 'Our dog Pickles 🐶');
    assert.deepEqual([mv.deletedOnPhone, mv.linkShared], [false, false]);
    assert.equal('familyScreen' in mv, false);
    const full = await download(mv.url, { cookie: parent.cookie });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/webm');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(full.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.ok(full.bytes.equals(WEBM));
    const part = await download(mv.url, { cookie: parent.cookie, Range: 'bytes=0-99' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-99/${WEBM.length}`);
    assert.ok(part.bytes.equals(WEBM.subarray(0, 100)));
    assert.equal((await download(mv.url)).status, 401);

    // A link for the family: the same link again, a watch page and the file, no sign-in.
    const link = (await phone.post('/api/android/media/mov-1/link', {})).body.link as string;
    assert.match(link, /^http:\/\/console\.test\/m\/[A-Za-z0-9_-]{20,}$/);
    assert.equal((await phone.post('/api/android/media/mov-1/link', {})).body.link, link);
    assert.equal((await phone.post('/api/android/media/nope/link', {})).status, 404);
    const tok = link.split('/m/')[1];
    const wp = await fetch(`${server.url}/m/${tok}`);
    assert.equal(wp.status, 200);
    const html = await wp.text();
    assert.ok(html.includes('Mia') && html.includes('Lego heist') && html.includes('<video controls playsinline'));
    const wf = await download(`/m/${tok}/file`, { Range: 'bytes=100-' });
    assert.equal(wf.status, 206);
    assert.equal(wf.bytes.length, WEBM.length - 100);
    assert.equal((await download(`/m/${tok}/file`)).status, 200);
    assert.equal((await fetch(`${server.url}/m/not-a-real-link`)).status, 404);

    // Deleted on the phone: the copy here stays.
    assert.deepEqual((await phone.post('/api/android/media/cam-1/deleted', {})).body, { ok: true });
    assert.equal((await phone.post('/api/android/media/nope/deleted', {})).status, 404);
    // "Show it on the family screen" is part of the app's API, but there is no such screen here: a plain answer, nothing stored.
    const fs1 = await phone.post('/api/android/media/mov-1/family-screen', {});
    assert.deepEqual([fs1.status, fs1.body.status, typeof fs1.body.message], [200, 'unavailable', 'string']);
    md = (await parent.get(`/api/kids/${kid}/media`)).body;
    assert.equal(md.items.find((i: Json) => i.id === mv.id).linkShared, true);
    assert.equal(md.items.find((i: Json) => i.id === pi.id).deletedOnPhone, true);

    // A parent deletes the movie: gone, its link too.
    assert.equal((await parent.del(`/api/media/${mv.id}`)).status, 200);
    md = (await parent.get(`/api/kids/${kid}/media`)).body;
    assert.deepEqual(md.items.map((i: Json) => i.id), [pi.id]);
    assert.equal((await download(mv.url, { cookie: parent.cookie })).status, 404);
    assert.equal((await fetch(`${server.url}/m/${tok}`)).status, 404);
    assert.equal((await fetch(`${server.url}/m/${tok}/file`)).status, 404);
  });

  it('an APK: upload, push, the phone downloads and installs it, and it is allowed', async () => {
    const APK = fakeApk(60_000);
    const headers = { cookie: parent.cookie, 'Content-Type': 'application/vnd.android.package-archive', 'X-FSW-Upload': '1', 'X-Filename': 'chess.apk' };
    const nope = await raw('POST', '/api/apks/upload?name=Bad', Buffer.from('not an apk at all'.repeat(100)), headers);
    assert.equal(nope.status, 400);
    assert.equal((await raw('POST', '/api/apks/upload?name=Chess', APK, { ...headers, cookie: '' })).status, 401);
    assert.equal((await raw('POST', '/api/apks/upload?name=Chess', APK, { cookie: parent.cookie })).status, 400); // no upload header
    assert.equal((await raw('POST', '/api/apks/upload', APK, headers)).status, 400); // no name
    const up = await raw('POST', '/api/apks/upload?name=Chess%20Kids', APK, headers);
    assert.equal(up.status, 201, up.text);
    assert.deepEqual({ ...up.body.apk, id: 'x', createdAt: 'x' }, { id: 'x', name: 'Chess Kids', fileName: 'chess.apk', package: null, size: APK.length, sha256: sha(APK), createdAt: 'x', pushes: [] });
    const apkId = up.body.apk.id;
    // Only the good upload left a file.
    assert.deepEqual(fs.readdirSync(path.join(TEST_DATA_DIR, 'apks')), [`${apkId}.apk`]);

    assert.equal((await parent.post(`/api/apks/${apkId}/push`, { kidIds: [] })).status, 400);
    assert.equal((await parent.post(`/api/apks/${NOBODY}/push`, { kidIds: [kid] })).status, 404);
    const pushed = await parent.post(`/api/apks/${apkId}/push`, { kidIds: [kid] });
    assert.deepEqual([pushed.status, pushed.body.phones, pushed.body.pushed], [201, 1, 1]);
    // Pushing again while it waits does not queue it twice.
    assert.equal((await parent.post(`/api/apks/${apkId}/push`, { kidIds: [kid] })).body.pushed, 0);

    const s2 = await sync();
    assert.equal(s2.apkInstalls.length, 1);
    assert.equal(s2.fastSync, true);
    const inst = s2.apkInstalls[0];
    assert.deepEqual({ ...inst, id: 'x', url: 'x' }, { id: 'x', name: 'Chess Kids', url: 'x', sha256: sha(APK), size: APK.length });
    assert.equal(inst.url, `/api/android/apk/${inst.id}`);
    const file = await download(inst.url, { Authorization: `Bearer ${token}` });
    assert.equal(file.status, 200);
    assert.equal(sha(file.bytes), sha(APK));
    assert.equal((await download(inst.url)).status, 401);

    // The phone says it is installing, then done (what Installer.kt sends).
    await sync({ installResults: [{ id: inst.id, status: 'installing' }] });
    assert.equal((await parent.get('/api/apks')).body.apks[0].pushes[0].status, 'installing');
    const s3 = await sync({ installResults: [{ id: inst.id, status: 'done', package: 'com.chesskids.app', label: 'Chess Kids' }] });
    assert.deepEqual(s3.apkInstalls, []);
    assert.equal(s3.fastSync, false);
    const chess = s3.apps.find((a: Json) => a.name === 'Chess Kids');
    assert.deepEqual([chess.allowed, chess.exes, chess.category], [true, ['com.chesskids.app'], 'game']);
    const apks = (await parent.get('/api/apks')).body.apks;
    assert.equal(apks[0].package, 'com.chesskids.app');
    assert.deepEqual([apks[0].pushes[0].status, apks[0].pushes[0].deviceName, apks[0].pushes[0].kidName], ['done', "Mia's phone", 'Mia Test']);
    // A late "failed" for a finished install does not undo it.
    await sync({ installResults: [{ id: inst.id, status: 'failed', message: 'late' }] });
    assert.equal((await parent.get('/api/apks')).body.apks[0].pushes[0].status, 'done');

    // A failed install keeps its message for the parent.
    await parent.post(`/api/apks/${apkId}/push`, { kidIds: [kid] });
    const inst2 = (await sync()).apkInstalls[0];
    await sync({ installResults: [{ id: inst2.id, status: 'failed', message: 'INSTALL_FAILED_INSUFFICIENT_STORAGE' }] });
    const failed = (await parent.get('/api/apks')).body.apks[0].pushes.find((p: Json) => p.id === inst2.id);
    assert.deepEqual([failed.status, failed.message], ['failed', 'INSTALL_FAILED_INSUFFICIENT_STORAGE']);
    assert.deepEqual((await sync()).apkInstalls, []);

    // Removing the APK removes the file.
    assert.equal((await parent.del(`/api/apks/${apkId}`)).status, 200);
    assert.deepEqual(fs.readdirSync(path.join(TEST_DATA_DIR, 'apks')), []);
    assert.equal((await download(inst.url, { Authorization: `Bearer ${token}` })).status, 404);
  });

  it('an app installed while a parent had the Play Store open is allowed', async () => {
    const s = await sync({ playInstalled: [{ package: 'com.duolingo', label: 'Duolingo' }, { package: 'bad package', label: 'Bad' }] });
    const duo = s.apps.find((a: Json) => a.name === 'Duolingo');
    assert.deepEqual([duo.allowed, duo.exes], [true, ['com.duolingo']]);
    assert.equal(s.apps.some((a: Json) => a.name === 'Bad'), false);
  });

  it('the parent PIN: 409 without one, then checked by the server', async () => {
    const none = await phone.post('/api/warden/pin', { pin: '1234' });
    assert.equal(none.status, 409);
    assert.match(none.body.error, /No parent PIN/);
    await parent.patch('/api/account', { pin: '4821' });
    assert.deepEqual((await phone.post('/api/warden/pin', { pin: '4821' })).body, { ok: true, message: '' });
    assert.deepEqual((await phone.post('/api/warden/pin', { pin: '0000' })).body, { ok: false, message: 'That PIN is not right.' });
    // An emergency code typed into the PIN box is just a wrong PIN to the server.
    assert.equal((await phone.post('/api/warden/pin', { pin: '12345678' })).body.ok, false);
    assert.equal((await phone.post('/api/warden/pin', { pin: 'letters' })).body.ok, false);
    assert.equal((await phone.post('/api/warden/pin', { pin: '4821' })).body.ok, true);
    // Five wrong tries lock PIN checks.
    for (let i = 0; i < 5; i++) await phone.post('/api/warden/pin', { pin: '1111' });
    assert.equal((await phone.post('/api/warden/pin', { pin: '4821' })).status, 429);
    await server.pool.query('UPDATE accounts SET pin_failed_count = 0, pin_locked_until = NULL');
  });

  it('from the PIN menu a parent adds time or locks the phone', async () => {
    const before = (await sync()).allowance.generalMinutes;
    assert.deepEqual((await phone.post('/api/warden/launcher/act', { action: 'parent', what: 'time', minutes: 45 })).body, { ok: true, message: 'Added 45 minutes.' });
    assert.equal((await sync()).allowance.generalMinutes, before + 45);
    assert.equal((await phone.post('/api/warden/launcher/act', { action: 'parent', what: 'lock' })).body.ok, true);
    assert.equal((await sync()).locked, true);
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.today.lockReason, 'parent');
    assert.equal((await phone.post('/api/warden/launcher/act', { action: 'parent', what: 'fly' })).status, 400);
    await parent.post(`/api/kids/${kid}/lock`, { locked: false });
    assert.equal((await sync()).locked, false);
  });

  it('emergency codes: the console makes the code the app works out by itself', async () => {
    const made = await parent.post(`/api/devices/${computerId}/unlock-code`);
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.counter, 1);
    assert.equal(made.body.code, unlockCode(secret, 1));
    assert.match(made.body.code, /^\d{8}$/);
    const second = await parent.post(`/api/devices/${computerId}/unlock-code`);
    assert.deepEqual([second.body.counter, second.body.code], [2, unlockCode(secret, 2)]);
    assert.deepEqual((await sync()).voidUnlocks, []);
    // The phone used code 1 while offline and says so.
    await sync({ unlocksUsed: [1] });
    assert.equal((await parent.del(`/api/devices/${computerId}/unlock-codes/1`)).status, 409);
    // Code 2 is cancelled: the phone is told to refuse it.
    assert.equal((await parent.del(`/api/devices/${computerId}/unlock-codes/2`)).status, 200);
    assert.deepEqual((await sync()).voidUnlocks, [2]);
    // A code nobody used runs out after 24 hours.
    await parent.post(`/api/devices/${computerId}/unlock-code`);
    await server.pool.query("UPDATE unlock_codes SET expires_at = now() - interval '1 minute' WHERE counter = 3");
    assert.deepEqual((await sync()).voidUnlocks, [3, 2]);
    assert.equal((await parent.post(`/api/devices/${NOBODY}/unlock-code`)).status, 404);
    // A PC paired through the simple API has no secret for codes.
    const pc = (await parent.get('/api/devices')).body.devices.find((d: Json) => d.platform === 'windows');
    assert.equal((await parent.post(`/api/devices/${pc.id}/unlock-code`)).status, 400);
  });

  it('a bonus-time code from a parent: works once, adds the minutes, lifts a lock', async () => {
    const made = await parent.post(`/api/kids/${kid}/time-code`, { minutes: 25 });
    assert.equal(made.status, 201, made.text);
    assert.match(made.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(made.body.minutes, 25);
    assert.deepEqual((await parent.get(`/api/kids/${kid}/phone`)).body.timeCodes.map((c: Json) => [c.code, c.minutes]), [[made.body.code, 25]]);
    assert.equal((await parent.post(`/api/kids/${kid}/time-code`, { minutes: 0 })).status, 400);

    const wrong = await phone.post('/api/warden/redeem', { code: 'ZZZZ-ZZZZ' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /not right/);
    await parent.post(`/api/kids/${kid}/lock`, { locked: true });
    const before = (await sync()).allowance.generalMinutes;
    // Small letters, no dash: the same code.
    const ok = await phone.post('/api/warden/redeem', { code: made.body.code.replace('-', '').toLowerCase() });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.minutes, 25);
    assert.equal(ok.body.appKey, null);
    assert.equal(ok.body.allowance.generalMinutes, before + 25);
    assert.equal(ok.body.locked, false);
    assert.equal(ok.body.kid.id, kid);
    assert.equal((await phone.post('/api/warden/redeem', { code: made.body.code })).status, 400);
    assert.deepEqual((await parent.get(`/api/kids/${kid}/phone`)).body.timeCodes, []);
  });

  it('pause all screens and bedtime reach the phone as a lock and a bedtime window', async () => {
    await parent.post('/api/pause-all', { paused: true });
    let s = await sync();
    assert.deepEqual([s.locked, s.paused], [true, false]);
    await parent.post('/api/pause-all', { paused: false });
    assert.equal((await sync()).locked, false);

    // 21:00 in Denver: inside tonight's window. The phone compares the two instants itself.
    server.setNow(new Date('2026-03-12T03:00:00Z'));
    s = await sync();
    assert.deepEqual(s.bedtime, { at: '2026-03-12T02:30:00.000Z', until: '2026-03-12T12:00:00.000Z', warnMinutes: [10, 5] });
    assert.equal(s.locked, false);
    await parent.patch(`/api/kids/${kid}`, { bedtimeEnabled: false });
    assert.equal((await sync()).bedtime, null);
    assert.equal((await phone.post('/api/warden/launcher', {})).body.bedtimeText, '');
    await parent.patch(`/api/kids/${kid}`, { bedtimeEnabled: true, safeSearch: false });
    assert.deepEqual((await sync()).safeSearch, { search: false, youTube: true });
    server.setNow(WEDNESDAY_AFTERNOON);
  });

  it('a newer version is offered as the update; older versions lose their file after three', async () => {
    assert.equal((await publish(APK_110, '1.10.0')).status, 200);
    const s = await sync();
    assert.deepEqual(s.update, { version: '1.10.0', url: '/api/android/download?v=1.10.0', sha256: sha(APK_110), size: APK_110.length });
    const dl = await download(s.update.url);
    assert.equal(sha(dl.bytes), sha(APK_110));
    // A QR code made just before still downloads the version it names.
    assert.equal(sha((await download('/api/android/download?v=1.0.7')).bytes), sha(APK_107));
    // 1.9.9 arrives late: 1.10.0 is still the newest (versions are numbers, not text).
    assert.equal((await publish(fakeApk(), '1.9.9')).status, 200);
    assert.equal((await sync()).update.version, '1.10.0');
    assert.equal((await publish(fakeApk(), '1.10.1')).status, 200);
    assert.equal((await sync()).update.version, '1.10.1');
    // Four versions: the oldest lost its file, the newest three keep theirs.
    assert.deepEqual(fs.readdirSync(path.join(TEST_DATA_DIR, 'releases', 'android')).sort(), ['1.10.0.apk', '1.10.1.apk', '1.9.9.apk']);
    assert.equal((await download('/api/android/download?v=1.0.7')).status, 404);
    assert.equal((await parent.get('/api/android-app')).body.latest.version, '1.10.1');
  });

  it('a removed phone is told so; removing the kid removes the photos from texts', async () => {
    const dir = path.join(TEST_DATA_DIR, 'text-media');
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.equal((await parent.del(`/api/devices/${computerId}`)).status, 200);
    const gone = await phone.post('/api/warden/sync', { version: '1.0.7', unlocksUsed: [] });
    assert.equal(gone.status, 401);
    assert.match(gone.body.error, /removed/);
    // The time it used still counts for the kid.
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.today.usedMinutes, 35);
    // The texts are still there for the parents.
    assert.equal((await parent.get(`/api/kids/${kid}/texts`)).body.threads.length, 1);
    assert.equal((await parent.del(`/api/kids/${kid}`)).status, 200);
    assert.equal(fs.readdirSync(dir).length, 0);
  });

  it('removing the kid removed the photos and videos too', async () => {
    const me = (await parent.get('/api/me')).body.account.id as string;
    assert.equal(fs.existsSync(path.join(TEST_DATA_DIR, 'kid-media', me, kid)), false);
    assert.equal((await server.pool.query('SELECT 1 FROM kid_media WHERE kid_id = $1', [kid])).rowCount, 0);
  });
});

describe('walls between families (phone routes)', () => {
  it("one family cannot read, change or use another family's phone things", async () => {
    const a = await family('wall-a@example.com', 'Ann', 'machine-a-000001');
    const b = await family('wall-b@example.com', 'Ben', 'machine-b-000001');

    const chore = (await a.parent.post(`/api/kids/${a.kid}/chores`, { name: 'Dishes', minutes: 10, repeat: 'daily' })).body.chore;
    await a.phone.post('/api/warden/launcher/act', { action: 'chore', id: chore.id });
    const approval = (await a.parent.get('/api/chore-approvals')).body.approvals[0];
    await a.phone.post('/api/warden/launcher/act', { action: 'chat', text: 'secret family words' });
    const chat = (await a.parent.get('/api/chat')).body.messages[0];
    await a.phone.post('/api/warden/sync', { texts: [{ id: 't1', thread: ['5550001111'], dir: 'in', from: '5550001111', body: 'private text', at: Date.now(), status: 'held', media: [{ id: 'p1', type: 'image/png' }] }] });
    const photo = await raw('POST', '/api/android/text-media/t1/p1', PNG, { Authorization: `Bearer ${a.phone.bearer}`, 'Content-Type': 'image/png' });
    const held = (await a.parent.get(`/api/kids/${a.kid}/texts`)).body.held[0];
    const APK = fakeApk(5000);
    const up = await raw('POST', '/api/apks/upload?name=Private', APK, { cookie: a.parent.cookie, 'X-FSW-Upload': '1' });
    const apkId = up.body.apk.id;
    await a.parent.post(`/api/apks/${apkId}/push`, { kidIds: [a.kid] });
    const inst = (await a.phone.post('/api/warden/sync', {})).body.apkInstalls[0];
    const code = (await a.parent.post(`/api/kids/${a.kid}/time-code`, { minutes: 30 })).body.code;

    // Parent B on family A's ids: always "not found".
    const P = b.parent;
    const rules = { blockSettings: false, blockReset: false, blockSafeBoot: false, blockInstalls: false, blockAccounts: false, blockUsb: false, emergencyNumber: '999', playMinutes: 5 };
    const tries: Array<[string, Promise<Reply>]> = [
      ['phone', P.get(`/api/kids/${a.kid}/phone`)],
      ['phone-rules', P.send('PUT', `/api/kids/${a.kid}/phone-rules`, rules)],
      ['launcher', P.send('PUT', `/api/kids/${a.kid}/launcher`, { layout: 'gamer', theme: 'ocean', lookLocked: true })],
      ['chores', P.get(`/api/kids/${a.kid}/chores`)],
      ['new chore', P.post(`/api/kids/${a.kid}/chores`, { name: 'Mine now', minutes: 240 })],
      ['patch chore', P.patch(`/api/chores/${chore.id}`, { minutes: 240 })],
      ['delete chore', P.del(`/api/chores/${chore.id}`)],
      ['decide', P.post(`/api/chore-approvals/${approval.id}/decide`, { approve: true })],
      ['texts', P.get(`/api/kids/${a.kid}/texts`)],
      ['thread', P.get(`/api/kids/${a.kid}/texts/thread?t=5550001111`)],
      ['photo', P.get(`/api/text-media/${photo.body.id}`)],
      ['delete text', P.post(`/api/texts/${held.id}/delete`)],
      ['block', P.post(`/api/kids/${a.kid}/blocked-numbers`, { phone: '5550001111' })],
      ['delete chat', P.del(`/api/chat/${chat.id}`)],
      ['delete apk', P.del(`/api/apks/${apkId}`)],
      ['push apk', P.post(`/api/apks/${apkId}/push`, { kidIds: [b.kid] })],
      ['unlock code', P.post(`/api/devices/${a.deviceId}/unlock-code`)],
      ['time code', P.post(`/api/kids/${a.kid}/time-code`, { minutes: 30 })],
      ['qr', P.post('/api/devices/android-qr', { kidId: a.kid })],
    ];
    for (const [what, p] of tries) assert.equal((await p).status, 404, what);
    // Pushing B's own kid cannot reach A's APK either; pushing A's kid with B's APK reaches no phone.
    const upB = await raw('POST', '/api/apks/upload?name=Bens', APK, { cookie: P.cookie, 'X-FSW-Upload': '1' });
    assert.equal((await P.post(`/api/apks/${upB.body.apk.id}/push`, { kidIds: [a.kid] })).status, 400);

    // Lists only hold the family's own things.
    assert.deepEqual((await P.get('/api/chore-approvals?status=all')).body.approvals, []);
    assert.deepEqual((await P.get('/api/apks')).body.apks.map((x: Json) => x.name), ['Bens']);

    // Phone B on family A's things.
    assert.equal((await b.phone.post('/api/warden/launcher/act', { action: 'chore', id: chore.id })).status, 404);
    assert.equal((await b.phone.post('/api/warden/redeem', { code })).status, 400);
    assert.equal((await download(inst.url, { Authorization: `Bearer ${b.phone.bearer}` })).status, 404);
    const infoB = (await b.phone.post('/api/warden/launcher', {})).body;
    assert.deepEqual([infoB.chores, infoB.chat], [[], []]);
    assert.deepEqual((await P.get('/api/chat')).body.messages, []);
    // B's family chats too; A sees none of it.
    await b.phone.post('/api/warden/launcher/act', { action: 'chat', text: 'from the other family' });
    await P.post('/api/chat', { text: 'parent of the other family' });
    assert.deepEqual((await a.parent.get('/api/chat')).body.messages.map((m: Json) => m.text), ['secret family words']);
    assert.deepEqual((await a.phone.post('/api/warden/launcher', {})).body.chat.map((m: Json) => m.text), ['secret family words']);
    const syncB = (await b.phone.post('/api/warden/sync', { installResults: [{ id: inst.id, status: 'done', package: 'com.evil.app', label: 'Evil' }] })).body;
    assert.deepEqual(syncB.apkInstalls, []);
    assert.equal(syncB.apps.some((x: Json) => x.name === 'Evil'), false);
    // A's install is untouched, and the code still works for A's phone only.
    assert.equal((await a.parent.get('/api/apks')).body.apks[0].pushes[0].status, 'waiting');
    assert.equal((await a.phone.post('/api/warden/redeem', { code })).status, 200);

    // Nothing of A changed.
    const still = (await a.parent.get(`/api/kids/${a.kid}/phone`)).body;
    assert.equal(still.rules.emergencyNumber, '911');
    assert.equal(still.launcher.lookLocked, false);
    assert.equal((await a.parent.get(`/api/kids/${a.kid}/chores`)).body.chores[0].minutes, 10);
    assert.equal((await a.parent.get('/api/chore-approvals')).body.approvals.length, 1);
    assert.equal((await a.parent.get(`/api/kids/${a.kid}/texts`)).body.held.length, 1);

    // A setup code is for its own kid: B's phone cannot pair into A with it, and a signed-out visitor gets nothing.
    const qrA = await a.parent.post('/api/devices/android-qr', { kidId: a.kid });
    assert.equal((await phoneClient().post('/api/android/pair', { code: qrA.body.code, memberId: b.kid, deviceId: 'machine-b-000001' })).status, 400);
    const anon = new Client(server.url);
    for (const p of ['/api/android-app', `/api/kids/${a.kid}/phone`, `/api/kids/${a.kid}/chores`, '/api/chore-approvals', '/api/chat', '/api/apks', `/api/kids/${a.kid}/texts`]) {
      assert.equal((await anon.get(p)).status, 401, p);
    }
  });

  it('a code made for a Windows PC does not pair a phone, and a used code is used up', async () => {
    const parent = await signIn(server, 'codes@example.com');
    const kid = await createKid(parent, 'Cody');
    const pcCode = (await parent.post('/api/devices/pairing-code', { kidId: kid, platform: 'windows' })).body.code;
    const asPhone = await phoneClient().post('/api/android/pair', { code: pcCode, memberId: kid, deviceId: 'machine-c-000001' });
    assert.equal(asPhone.status, 400);
    assert.match(asPhone.body.error, /Windows PC/);
    // The simple API's Android code works on the phone API too (typed by hand, no QR).
    const phoneCode = (await parent.post('/api/devices/pairing-code', { kidId: kid, platform: 'android' })).body.code;
    const ok = await phoneClient().post('/api/android/pair', { code: phoneCode, memberId: kid, deviceId: 'machine-c-000001' });
    assert.equal(ok.status, 200);
    // ...and is then used up for the simple API.
    const reuse = await new Client(server.url).post('/api/device/pair', { code: phoneCode, name: 'Other', platform: 'android' });
    assert.equal(reuse.status, 404);
    // An expired code.
    const old = (await parent.post('/api/devices/android-qr', { kidId: kid })).body.code;
    await server.pool.query("UPDATE pairing_codes SET expires_at = now() - interval '1 minute' WHERE code = $1", [old]);
    assert.equal((await phoneClient().post('/api/warden/setup/check', { code: old })).status, 400);
    assert.equal((await phoneClient().post('/api/android/pair', { code: old, memberId: kid, deviceId: 'machine-c-000002' })).status, 400);
  });
});

describe('limits on what a phone can do', () => {
  it('too many setup tries from one address are slowed down', async () => {
    const strict = await startServer({ BILLING_ENABLED: '' }, { ipLimits: { links: 100, verify: 100, pair: 3, api: 1000 } });
    try {
      const c = new Client(strict.url);
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await c.post('/api/warden/setup/check', { code: 'AAAA-BBBB' })).status);
      assert.deepEqual(statuses, [400, 400, 400, 429, 429]);
    } finally {
      await strict.close();
    }
  });

  it('at most 5 requests wait per kid, also through the phone routes', async () => {
    const f = await family('many@example.com', 'Max', 'machine-m-000001');
    for (let i = 0; i < 5; i++) assert.equal((await f.phone.post('/api/android/request', { package: `com.game.n${i}`, name: `Game ${i}` })).body.status, 'sent');
    const sixth = await f.phone.post('/api/android/request', { package: 'com.game.n6', name: 'Game 6' });
    assert.equal(sixth.body.status, 'pending');
    assert.equal(sixth.body.id, undefined);
    assert.deepEqual((await f.phone.post('/api/warden/launcher/act', { action: 'ask', what: 'time', minutes: 15 })).body, { ok: true, message: 'Lots of questions are waiting already. Ask a parent in person.' });
    assert.equal((await f.parent.get('/api/requests')).body.requests.length, 5);
  });

  it('publishing is off without a long PUBLISH_TOKEN, and big bodies are refused', async () => {
    const noToken = await startServer({ BILLING_ENABLED: '', PUBLISH_TOKEN: 'short' });
    try {
      const res = await fetch(`${noToken.url}/internal/android/publish`, { method: 'POST', headers: { Authorization: 'Bearer short', 'X-Version': '1.0.0' }, body: fakeApk() });
      assert.equal(res.status, 503);
    } finally {
      await noToken.close();
    }
    const f = await family('big@example.com', 'Bea', 'machine-g-000001');
    const tooBig = await raw('POST', '/api/android/text-media/m9/p9', Buffer.alloc(8 * 1024 * 1024 + 10, 1), { Authorization: `Bearer ${f.phone.bearer}`, 'Content-Type': 'image/jpeg' });
    assert.equal(tooBig.status, 413);
    assert.equal((await f.phone.post('/api/warden/sync', { installed: Array.from({ length: 1001 }, (_, i) => ({ name: `a${i}`, exe: `com.a.n${i}` })) })).status, 400);
  });

  it('a version published without the signing checksum (an unsigned build) gets the file checksum in the QR', async () => {
    const apk = fakeApk();
    // curl sends no header at all for an empty value; that is what an unsigned workflow run does.
    const res = await raw('POST', '/internal/android/publish', apk, { Authorization: `Bearer ${TOKEN}`, 'X-Version': '2.0.0', 'X-Sha256': sha(apk), 'Content-Type': 'application/octet-stream' });
    assert.deepEqual(res.body, { ok: true, version: '2.0.0', sha256: sha(apk), size: apk.length });
    const parent = await signIn(server, 'unsigned@example.com');
    const kid = await createKid(parent, 'Una');
    const payload = JSON.parse((await parent.post('/api/devices/android-qr', { kidId: kid })).body.payload);
    assert.equal(payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM'], Buffer.from(sha(apk), 'hex').toString('base64url'));
    assert.equal('android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM' in payload, false);
    assert.equal(Object.keys(payload).some((k) => k.includes('WIFI')), false);
  });

  it('housekeeping removes old texts with their photos', async () => {
    const f = await family('old@example.com', 'Olly', 'machine-o-000001');
    await f.phone.post('/api/warden/sync', { texts: [{ id: 'o1', thread: ['5550002222'], dir: 'out', body: 'old', at: Date.now(), media: [{ id: 'op1', type: 'image/png' }] }] });
    const up = await raw('POST', '/api/android/text-media/o1/op1', PNG, { Authorization: `Bearer ${f.phone.bearer}`, 'Content-Type': 'image/png' });
    const file = path.join(TEST_DATA_DIR, 'text-media', up.body.id);
    assert.equal(fs.existsSync(file), true);
    await server.pool.query("UPDATE texts SET at = now() - interval '91 days' WHERE phone_id = 'o1'");
    await server.pool.query("UPDATE text_media SET created_at = now() - interval '91 days' WHERE id = $1", [up.body.id]);
    await purgeExpired(server.pool, TEST_DATA_DIR);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual((await f.parent.get(`/api/kids/${f.kid}/texts`)).body.threads, []);
  });
});

describe('the paywall switch (BILLING_ENABLED off, the default)', () => {
  it('reports billing as off and never locks, even long after the trial date', async () => {
    const parent = await signIn(server, 'free@example.com');
    const kid = await createKid(parent, 'Finn');
    await server.pool.query("UPDATE accounts SET trial_ends_at = now() - interval '90 days' WHERE email = 'free@example.com'");

    const me = await parent.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.billingEnabled, false);
    assert.equal(me.body.account.plan, 'trial');
    // The account's own keys did not change.
    assert.deepEqual(Object.keys(me.body.account).sort(), ['email', 'hasPin', 'id', 'pausedAll', 'plan', 'timezone', 'trialDaysLeft', 'trialEndsAt']);

    // No 402 anywhere, reading or changing.
    for (const p of ['/api/dashboard', '/api/kids', `/api/kids/${kid}`, '/api/devices', '/api/requests', '/api/reports', '/api/chore-approvals', '/api/chat', '/api/apks']) {
      assert.equal((await parent.get(p)).status, 200, p);
    }
    assert.equal((await parent.patch(`/api/kids/${kid}`, { limitSchoolMinutes: 90 })).status, 200);
    assert.equal((await parent.post('/api/pause-all', { paused: false })).status, 200);
    // The row was not moved to "locked" behind the scenes.
    assert.equal((await server.pool.query("SELECT plan FROM accounts WHERE email = 'free@example.com'")).rows[0].plan, 'trial');

    const billing = await parent.get('/api/billing');
    assert.equal(billing.status, 200);
    assert.equal(billing.body.billingEnabled, false);
    assert.equal(billing.body.plan, 'trial');
    assert.equal(billing.body.stripeReady, false);
    assert.deepEqual(billing.body.prices, { month: 4, year: 36 });
    for (const [p, body] of [['/api/billing/checkout', { interval: 'month' }], ['/api/billing/portal', {}]] as const) {
      const res = await parent.post(p, body);
      assert.equal(res.status, 503, p);
      assert.match(res.body.error, /free to use right now/);
      assert.equal(res.body.locked, undefined);
    }
  });

  it('an account that was locked before the switch works again and shows as a trial', async () => {
    const parent = await signIn(server, 'waslocked@example.com');
    await createKid(parent, 'Lia');
    await server.pool.query("UPDATE accounts SET plan = 'locked', trial_ends_at = now() - interval '10 days' WHERE email = 'waslocked@example.com'");
    assert.equal((await parent.get('/api/me')).body.account.plan, 'trial');
    assert.equal((await parent.get('/api/billing')).body.plan, 'trial');
    assert.equal((await parent.get('/api/dashboard')).status, 200);
    assert.equal((await parent.post('/api/kids', { name: 'New kid' })).status, 201);
    assert.equal((await parent.patch('/api/account', { timezone: 'Europe/Berlin' })).body.account.plan, 'trial');
    await server.pool.query("UPDATE accounts SET plan = 'trial' WHERE email = 'waslocked@example.com'");
  });

  it('switched on again, the same data locks as before (the Stripe side is kept behind the flag)', async () => {
    const on = await startServer({ BILLING_ENABLED: '1' });
    try {
      const parent = await signIn(on, 'paid@example.com');
      await on.pool.query("UPDATE accounts SET trial_ends_at = now() - interval '1 minute' WHERE email = 'paid@example.com'");
      const me = await parent.get('/api/me');
      assert.equal(me.body.billingEnabled, true);
      assert.equal(me.body.account.plan, 'locked');
      const dash = await parent.get('/api/dashboard');
      assert.equal(dash.status, 402);
      assert.equal(dash.body.locked, true);
      assert.equal((await parent.get('/api/chore-approvals')).status, 402);
      assert.equal((await parent.get('/api/billing')).body.billingEnabled, undefined);
      // The background job is what the server skips when the flag is off; the function itself still works.
      await on.pool.query("UPDATE accounts SET plan = 'trial' WHERE email = 'paid@example.com'");
      assert.ok((await lockExpiredTrials(on.pool)) >= 1);
      await on.pool.query("UPDATE accounts SET plan = 'trial', trial_ends_at = now() + interval '30 days' WHERE email IN ('paid@example.com', 'free@example.com', 'waslocked@example.com')");
    } finally {
      await on.close();
    }
  });

  it('a phone keeps working whatever the plan says', async () => {
    const f = await family('device-plan@example.com', 'Dee', 'machine-d-000001');
    await server.pool.query("UPDATE accounts SET plan = 'locked' WHERE email = 'device-plan@example.com'");
    assert.equal((await f.phone.post('/api/warden/sync', {})).status, 200);
    assert.equal((await f.phone.post('/api/warden/launcher', {})).status, 200);
  });
});
