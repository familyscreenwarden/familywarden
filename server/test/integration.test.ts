import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate } from '../src/db';
import { migrations } from '../src/migrations';
import { DEMO_EMAIL, seed } from '../src/seed';
import { lockExpiredTrials } from '../src/state';
import { signStripePayload } from '../src/stripe';
import {
  Client,
  createKid,
  pairDevice,
  resetDatabase,
  signIn,
  startServer,
  TEST_DATABASE_URL,
  TODAY,
  WEDNESDAY_AFTERNOON,
  type TestServer,
} from './helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOBODY = '00000000-0000-4000-8000-000000000000';

let server: TestServer;

before(async () => {
  await resetDatabase();
  server = await startServer();
});

after(async () => {
  await server.close();
});

describe('start-up', () => {
  it('answers /healthz with the database check', async () => {
    const res = await new Client(server.url).get('/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok', db: true });
  });

  it('records every migration once and is safe to run again', async () => {
    assert.deepEqual(await migrate(server.pool), []);
    const rows = await server.pool.query<{ id: string }>('SELECT id FROM migrations ORDER BY id');
    assert.deepEqual(rows.rows.map((r) => r.id), migrations.map((m) => m.id));
  });

  it('sends security headers and hides the framework', async () => {
    const res = await new Client(server.url).get('/healthz');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('answers unknown paths with a JSON error', async () => {
    const res = await new Client(server.url).get('/nope');
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.error, 'string');
  });
});

describe('sign-in by email link', () => {
  it('request link → verify → /api/me', async () => {
    const client = new Client(server.url);
    const anonymous = await client.get('/api/me');
    assert.equal(anonymous.status, 401);
    assert.equal(typeof anonymous.body.error, 'string');

    const asked = await client.post('/api/auth/request-link', { email: '  Parent.One@Example.com ' });
    assert.equal(asked.status, 200);
    assert.equal(asked.body.ok, true);
    assert.match(asked.body.devLink, /^http:\/\/console\.test\/api\/auth\/verify\?token=[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(server.sent.at(-1), { email: 'parent.one@example.com', link: asked.body.devLink });

    // Nothing exists for the family until the link is opened.
    const beforeVerify = await server.pool.query('SELECT 1 FROM accounts WHERE email = $1', ['parent.one@example.com']);
    assert.equal(beforeVerify.rowCount, 0);

    const link = new URL(asked.body.devLink);
    const verified = await client.get(link.pathname + link.search);
    assert.equal(verified.status, 302);
    assert.equal(verified.headers.get('location'), '/');
    const setCookie = verified.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^fsw_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);

    const me = await client.get('/api/me');
    assert.equal(me.status, 200);
    const account = me.body.account;
    assert.match(account.id, UUID);
    assert.equal(account.email, 'parent.one@example.com');
    assert.equal(account.timezone, 'America/Denver');
    assert.equal(account.plan, 'trial');
    assert.equal(account.trialDaysLeft, 30);
    assert.equal(account.pausedAll, false);
    assert.equal(account.hasPin, false);
    assert.ok(Math.abs(new Date(account.trialEndsAt).getTime() - (Date.now() + 30 * 86400000)) < 60000);
    assert.deepEqual(Object.keys(account).sort(), ['email', 'hasPin', 'id', 'pausedAll', 'plan', 'timezone', 'trialDaysLeft', 'trialEndsAt']);
  });

  it('stores only hashes of the link token and the session cookie', async () => {
    const client = new Client(server.url);
    const asked = await client.post('/api/auth/request-link', { email: 'hashes@example.com' });
    const token = new URL(asked.body.devLink).searchParams.get('token') ?? '';
    await client.get(`/api/auth/verify?token=${token}`);
    const cookieValue = decodeURIComponent(client.cookie.split('=')[1] ?? '');
    const tokens = await server.pool.query<{ token_hash: string }>("SELECT token_hash FROM login_tokens WHERE email = 'hashes@example.com'");
    const sessions = await server.pool.query<{ token_hash: string }>(
      "SELECT s.token_hash FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.email = 'hashes@example.com'",
    );
    assert.equal(tokens.rows.length, 1);
    assert.equal(sessions.rows.length, 1);
    assert.match(tokens.rows[0]?.token_hash ?? '', /^[0-9a-f]{64}$/);
    assert.match(sessions.rows[0]?.token_hash ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(tokens.rows[0]?.token_hash, token);
    assert.notEqual(sessions.rows[0]?.token_hash, cookieValue);
  });

  it('a link works only once', async () => {
    const client = new Client(server.url);
    const asked = await client.post('/api/auth/request-link', { email: 'once@example.com' });
    const link = new URL(asked.body.devLink);
    assert.equal((await client.get(link.pathname + link.search)).headers.get('location'), '/');
    const second = new Client(server.url);
    const again = await second.get(link.pathname + link.search);
    assert.equal(again.status, 302);
    assert.equal(again.headers.get('location'), '/signin?error=expired');
    assert.equal(second.cookie, '');
  });

  it('an expired, unknown or missing token goes to /signin?error=expired', async () => {
    const client = new Client(server.url);
    const asked = await client.post('/api/auth/request-link', { email: 'late@example.com' });
    const link = new URL(asked.body.devLink);
    await server.pool.query("UPDATE login_tokens SET expires_at = now() - interval '1 second' WHERE email = 'late@example.com'");
    for (const p of [link.pathname + link.search, '/api/auth/verify?token=not-a-real-token', '/api/auth/verify']) {
      const res = await client.get(p);
      assert.equal(res.status, 302, p);
      assert.equal(res.headers.get('location'), '/signin?error=expired', p);
    }
    assert.equal(client.cookie, '');
  });

  it('the link runs out after 15 minutes', async () => {
    await new Client(server.url).post('/api/auth/request-link', { email: 'fifteen@example.com' });
    const row = await server.pool.query<{ seconds: number }>(
      "SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::int AS seconds FROM login_tokens WHERE email = 'fifteen@example.com'",
    );
    assert.equal(row.rows[0]?.seconds, 900);
  });

  it('signing in twice gives the same family, not a second one', async () => {
    const first = await signIn(server, 'twice@example.com');
    const second = await signIn(server, 'TWICE@example.com');
    const a = (await first.get('/api/me')).body.account.id;
    const b = (await second.get('/api/me')).body.account.id;
    assert.equal(a, b);
  });

  it('rejects things that are not an email address', async () => {
    const client = new Client(server.url);
    for (const email of ['', 'nope', 'a@b', 'two words@example.com', 42, null]) {
      const res = await client.post('/api/auth/request-link', { email });
      assert.equal(res.status, 400, String(email));
      assert.equal(typeof res.body.error, 'string');
    }
  });

  it('allows 5 links per email per hour', async () => {
    const client = new Client(server.url);
    for (let i = 0; i < 5; i++) {
      assert.equal((await client.post('/api/auth/request-link', { email: 'many@example.com' })).status, 200, `try ${i + 1}`);
    }
    const sixth = await client.post('/api/auth/request-link', { email: 'many@example.com' });
    assert.equal(sixth.status, 429);
    assert.equal(typeof sixth.body.error, 'string');
    assert.equal(sixth.body.devLink, undefined);
    // A burst for one email cannot slip past the count either.
    const burst = await Promise.all(Array.from({ length: 8 }, () => new Client(server.url).post('/api/auth/request-link', { email: 'burst-many@example.com' })));
    assert.equal(burst.filter((r) => r.status === 200).length, 5);
    // Another email is not affected.
    assert.equal((await client.post('/api/auth/request-link', { email: 'other-many@example.com' })).status, 200);
  });

  it('logout ends the session', async () => {
    const client = await signIn(server, 'logout@example.com');
    const cookie = client.cookie;
    const out = await client.post('/api/auth/logout');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true });
    assert.equal(client.cookie, '');
    const replay = new Client(server.url);
    replay.cookie = cookie;
    assert.equal((await replay.get('/api/me')).status, 401);
  });

  it('an expired session answers 401', async () => {
    const client = await signIn(server, 'oldsession@example.com');
    await server.pool.query(
      "UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE account_id = (SELECT id FROM accounts WHERE email = 'oldsession@example.com')",
    );
    assert.equal((await client.get('/api/me')).status, 401);
  });

  it('a made-up cookie answers 401', async () => {
    const client = new Client(server.url);
    client.cookie = 'fsw_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    assert.equal((await client.get('/api/me')).status, 401);
    assert.equal((await client.get('/api/dashboard')).status, 401);
    assert.equal((await client.post('/api/kids', { name: 'X' })).status, 401);
  });

  it('PATCH /api/account changes the time zone and checks it', async () => {
    const client = await signIn(server, 'tz@example.com');
    const ok = await client.patch('/api/account', { timezone: 'Europe/Berlin' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.account.timezone, 'Europe/Berlin');
    assert.equal((await client.get('/api/me')).body.account.timezone, 'Europe/Berlin');
    assert.equal((await client.patch('/api/account', { timezone: 'Not/AZone' })).status, 400);
    assert.equal((await client.patch('/api/account', {})).status, 400);
  });
});

describe('without DEV_LINKS', () => {
  it('the response never carries the link, and the mailer still gets it', async () => {
    const quiet = await startServer({ DEV_LINKS: '' });
    try {
      const res = await new Client(quiet.url).post('/api/auth/request-link', { email: 'quiet@example.com' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(quiet.sent.length, 1);
      assert.equal(quiet.sent[0]?.email, 'quiet@example.com');
    } finally {
      await quiet.close();
    }
  });
});

describe('kids', () => {
  it('creates kids with the default rules', async () => {
    const parent = await signIn(server, 'kids@example.com');
    assert.deepEqual((await parent.get('/api/kids')).body, { kids: [] });

    const made = await parent.post('/api/kids', { name: ' Max ' });
    assert.equal(made.status, 201);
    const kid = made.body.kid;
    assert.match(kid.id, UUID);
    assert.equal(kid.name, 'Max');
    assert.match(kid.color, /^#[0-9a-f]{6}$/);
    assert.equal(kid.limitSchoolMinutes, 120);
    assert.equal(kid.limitWeekendMinutes, 180);
    assert.equal(kid.bedSchoolStart, '20:30');
    assert.equal(kid.bedSchoolEnd, '06:00');
    assert.equal(kid.bedOtherStart, '21:30');
    assert.equal(kid.bedOtherEnd, '07:00');
    assert.equal(kid.bedtimeEnabled, true);
    assert.equal(kid.onlyAllowedSites, true);
    assert.equal(kid.safeSearch, true);
    assert.equal(kid.youtubeRestricted, true);
    assert.equal(kid.blockPrivate, true);
    assert.equal(kid.locked, false);

    const ava = await parent.post('/api/kids', { name: 'Ava', color: '#AABBCC' });
    assert.equal(ava.status, 201);
    assert.equal(ava.body.kid.color, '#aabbcc');
    assert.notEqual(ava.body.kid.color, kid.color);

    const list = await parent.get('/api/kids');
    assert.deepEqual(list.body.kids.map((k: { name: string }) => k.name), ['Max', 'Ava']);

    const detail = await parent.get(`/api/kids/${kid.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.kid.id, kid.id);
    assert.deepEqual(detail.body.apps, []);
    assert.deepEqual(detail.body.contacts, []);
    assert.deepEqual(detail.body.today, { limitMinutes: 120, usedMinutes: 0, leftMinutes: 120, locked: false, lockReason: null });
  });

  it('validates the body', async () => {
    const parent = await signIn(server, 'kids-validate@example.com');
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(41) }, { name: 5 }, { name: 'Max', color: 'red' }, [], 'text']) {
      const res = await parent.post('/api/kids', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(typeof res.body.error, 'string');
    }
    const id = await createKid(parent, 'Max');
    for (const body of [
      {},
      { limitSchoolMinutes: -1 },
      { limitSchoolMinutes: 1441 },
      { limitWeekendMinutes: 12.5 },
      { limitWeekendMinutes: '60' },
      { bedSchoolStart: '25:00' },
      { bedOtherEnd: '7am' },
      { bedtimeEnabled: 'yes' },
      { color: '#12' },
      { name: '' },
    ]) {
      assert.equal((await parent.patch(`/api/kids/${id}`, body)).status, 400, JSON.stringify(body));
    }
  });

  it('changes any kid field', async () => {
    const parent = await signIn(server, 'kids-patch@example.com');
    const id = await createKid(parent, 'Max');
    const patch = {
      name: 'Maximilian',
      color: '#123456',
      limitSchoolMinutes: 90,
      limitWeekendMinutes: 200,
      bedSchoolStart: '19:45',
      bedSchoolEnd: '06:30',
      bedOtherStart: '22:00',
      bedOtherEnd: '08:00',
      bedtimeEnabled: false,
      onlyAllowedSites: false,
      safeSearch: false,
      youtubeRestricted: false,
      blockPrivate: false,
      locked: true,
    };
    const res = await parent.patch(`/api/kids/${id}`, patch);
    assert.equal(res.status, 200);
    for (const [key, value] of Object.entries(patch)) assert.equal(res.body.kid[key], value, key);
    const detail = await parent.get(`/api/kids/${id}`);
    for (const [key, value] of Object.entries(patch)) assert.equal(detail.body.kid[key], value, key);
    assert.equal(detail.body.today.limitMinutes, 90);
    assert.equal(detail.body.today.lockReason, 'parent');
  });

  it('deletes a kid with everything that belongs to it', async () => {
    const parent = await signIn(server, 'kids-delete@example.com');
    const id = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, id, 'windows', 'PC');
    await device.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'a.exe', name: 'A', minutes: 5 }] });
    await parent.post(`/api/kids/${id}/contacts`, { name: 'Mom', phone: '+1 555 0100' });
    assert.deepEqual((await parent.del(`/api/kids/${id}`)).body, { ok: true });
    assert.equal((await parent.get(`/api/kids/${id}`)).status, 404);
    assert.equal((await parent.del(`/api/kids/${id}`)).status, 404);
    assert.deepEqual((await parent.get('/api/devices')).body.devices, []);
    assert.equal((await device.post('/api/device/sync', {})).status, 401);
    for (const table of ['devices', 'apps', 'usage', 'contacts']) {
      const left = await server.pool.query(`SELECT 1 FROM ${table} WHERE kid_id = $1`, [id]);
      assert.equal(left.rowCount, 0, table);
    }
  });

  it('answers 404 for ids that do not exist or are not ids', async () => {
    const parent = await signIn(server, 'kids-404@example.com');
    for (const id of [NOBODY, 'abc', '1', "1' OR '1'='1"]) {
      const p = `/api/kids/${encodeURIComponent(id)}`;
      assert.equal((await parent.get(p)).status, 404, id);
      assert.equal((await parent.patch(p, { name: 'X' })).status, 404, id);
      assert.equal((await parent.del(p)).status, 404, id);
      assert.equal((await parent.post(`${p}/grant`, { minutes: 5 })).status, 404, id);
      assert.equal((await parent.post(`${p}/lock`, { locked: true })).status, 404, id);
    }
  });
});

describe('apps and contacts', () => {
  it('adds, changes and removes apps and sites', async () => {
    const parent = await signIn(server, 'apps@example.com');
    const kid = await createKid(parent, 'Max');

    const game = await parent.post(`/api/kids/${kid}/apps`, { kind: 'app', platform: 'windows', identifier: 'Minecraft.exe', name: 'Minecraft', limitMinutes: 60 });
    assert.equal(game.status, 201);
    assert.match(game.body.app.id, UUID);
    assert.equal(game.body.app.identifier, 'minecraft.exe');
    assert.equal(game.body.app.allowed, true);
    assert.equal(game.body.app.free, false);
    assert.equal(game.body.app.limitMinutes, 60);
    assert.equal(game.body.app.usedMinutes, 0);

    const site = await parent.post(`/api/kids/${kid}/apps`, { kind: 'site', identifier: 'https://www.KhanAcademy.org/math', name: 'Khan Academy', free: true });
    assert.equal(site.status, 201);
    assert.equal(site.body.app.identifier, 'khanacademy.org');
    assert.equal(site.body.app.platform, 'any');
    assert.equal(site.body.app.free, true);
    assert.equal(site.body.app.limitMinutes, null);

    const twice = await parent.post(`/api/kids/${kid}/apps`, { kind: 'site', identifier: 'khanacademy.org', name: 'Again' });
    assert.equal(twice.status, 409);

    for (const body of [{}, { kind: 'game', identifier: 'x', name: 'X' }, { kind: 'app', identifier: '', name: 'X' }, { kind: 'app', identifier: 'x', name: 'X', limitMinutes: -1 }, { kind: 'app', identifier: 'x', name: 'X', platform: 'ios' }, { kind: 'app', identifier: 'x', name: 'X', allowed: 'no' }]) {
      assert.equal((await parent.post(`/api/kids/${kid}/apps`, body)).status, 400, JSON.stringify(body));
    }

    const changed = await parent.patch(`/api/apps/${game.body.app.id}`, { allowed: false, free: true, limitMinutes: null, name: 'MC' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.app.allowed, false);
    assert.equal(changed.body.app.free, true);
    assert.equal(changed.body.app.limitMinutes, null);
    assert.equal(changed.body.app.name, 'MC');
    assert.equal((await parent.patch(`/api/apps/${game.body.app.id}`, {})).status, 400);
    assert.equal((await parent.patch(`/api/apps/${game.body.app.id}`, { limitMinutes: 5000 })).status, 400);

    const detail = await parent.get(`/api/kids/${kid}`);
    assert.deepEqual(detail.body.apps.map((a: { name: string }) => a.name), ['Khan Academy', 'MC']);

    assert.deepEqual((await parent.del(`/api/apps/${game.body.app.id}`)).body, { ok: true });
    assert.equal((await parent.del(`/api/apps/${game.body.app.id}`)).status, 404);
    assert.equal((await parent.patch(`/api/apps/${NOBODY}`, { allowed: true })).status, 404);
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.apps.length, 1);
  });

  it('adds, changes and removes contacts', async () => {
    const parent = await signIn(server, 'contacts@example.com');
    const kid = await createKid(parent, 'Ava');
    const mom = await parent.post(`/api/kids/${kid}/contacts`, { name: 'Mom', phone: '+1 (555) 010-0101' });
    assert.equal(mom.status, 201);
    assert.match(mom.body.contact.id, UUID);
    assert.equal(mom.body.contact.canCall, true);
    assert.equal(mom.body.contact.canText, true);
    const grandma = await parent.post(`/api/kids/${kid}/contacts`, { name: 'Grandma', phone: '555 0103', canText: false });
    assert.equal(grandma.body.contact.canText, false);

    for (const body of [{}, { name: 'X' }, { name: 'X', phone: 'call me' }, { name: '', phone: '555 0100' }, { name: 'X', phone: '555 0100', canCall: 1 }]) {
      assert.equal((await parent.post(`/api/kids/${kid}/contacts`, body)).status, 400, JSON.stringify(body));
    }

    const changed = await parent.patch(`/api/contacts/${grandma.body.contact.id}`, { name: 'Nana', canCall: false, canText: true, phone: '555 0199' });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.contact, { id: grandma.body.contact.id, kidId: kid, name: 'Nana', phone: '555 0199', canCall: false, canText: true });

    const detail = await parent.get(`/api/kids/${kid}`);
    assert.deepEqual(detail.body.contacts.map((c: { name: string }) => c.name), ['Mom', 'Nana']);

    assert.deepEqual((await parent.del(`/api/contacts/${mom.body.contact.id}`)).body, { ok: true });
    assert.equal((await parent.del(`/api/contacts/${mom.body.contact.id}`)).status, 404);
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.contacts.length, 1);
  });
});

describe('devices: pairing and sync', () => {
  it('pairing code → device pair → sync with usage → dashboard numbers', async () => {
    const parent = await signIn(server, 'sync@example.com');
    const max = await createKid(parent, 'Max');
    const ava = await createKid(parent, 'Ava');
    await parent.post(`/api/kids/${max}/apps`, { kind: 'app', platform: 'windows', identifier: 'minecraft.exe', name: 'Minecraft', limitMinutes: 60 });
    await parent.post(`/api/kids/${max}/apps`, { kind: 'site', identifier: 'khanacademy.org', name: 'Khan Academy', free: true });
    await parent.post(`/api/kids/${max}/contacts`, { name: 'Mom', phone: '+1 555 0101' });

    // --- pairing code
    const code = await parent.post('/api/devices/pairing-code', { kidId: max, platform: 'windows' });
    assert.equal(code.status, 201);
    assert.match(code.body.code, /^[A-HJ-NP-Z2-9]{8}$/);
    const ttl = new Date(code.body.expiresAt).getTime() - Date.now();
    assert.ok(ttl > 29 * 60000 && ttl <= 30 * 60000, `expires in ${ttl} ms`);

    // --- pair
    const device = new Client(server.url);
    const paired = await device.post('/api/device/pair', {
      code: code.body.code.toLowerCase(), // kids type it however they like
      name: "Max's PC",
      platform: 'windows',
      model: 'Dell Inspiron',
      osVersion: 'Windows 11',
      appVersion: '1.0.0',
    });
    assert.equal(paired.status, 201);
    assert.match(paired.body.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(paired.body.deviceId, UUID);
    assert.equal(paired.body.kid.id, max);
    assert.equal(paired.body.kid.name, 'Max');
    assert.match(paired.body.kid.color, /^#[0-9a-f]{6}$/);
    device.bearer = paired.body.deviceToken;

    // The token is stored as a hash only.
    const stored = await server.pool.query<{ token_hash: string }>('SELECT token_hash FROM devices WHERE id = $1', [paired.body.deviceId]);
    assert.match(stored.rows[0]?.token_hash ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(stored.rows[0]?.token_hash, paired.body.deviceToken);

    // The code is single-use.
    const reuse = await new Client(server.url).post('/api/device/pair', { code: code.body.code, name: 'Other', platform: 'windows' });
    assert.equal(reuse.status, 404);
    assert.equal(typeof reuse.body.error, 'string');

    // --- first sync, nothing to report
    const empty = await device.post('/api/device/sync', {});
    assert.equal(empty.status, 200);
    assert.ok(Math.abs(new Date(empty.body.serverTime).getTime() - Date.now()) < 60000);
    assert.equal(empty.body.kid.id, max);
    assert.equal(empty.body.kid.name, 'Max');
    assert.equal(empty.body.rules.limitMinutes, 120);
    assert.equal(empty.body.rules.usedMinutes, 0);
    assert.equal(empty.body.rules.leftMinutes, 120);
    assert.equal(empty.body.rules.locked, false);
    assert.equal(empty.body.rules.lockReason, null);
    assert.deepEqual(empty.body.rules.bedtime, { enabled: true, start: '20:30', end: '06:00' });
    assert.deepEqual(empty.body.rules.safe, { onlyAllowedSites: true, safeSearch: true, youtubeRestricted: true, blockPrivate: true });
    assert.deepEqual(empty.body.rules.contacts, [{ name: 'Mom', phone: '+1 555 0101', canCall: true, canText: true }]);
    assert.deepEqual(
      empty.body.rules.apps,
      [
        { kind: 'site', platform: 'any', identifier: 'khanacademy.org', name: 'Khan Academy', allowed: true, free: true, limitMinutes: null, usedMinutes: 0 },
        { kind: 'app', platform: 'windows', identifier: 'minecraft.exe', name: 'Minecraft', allowed: true, free: false, limitMinutes: 60, usedMinutes: 0 },
      ],
    );

    // --- sync with usage, an unknown app, an installed list and blocked sites
    const sync = await device.post('/api/device/sync', {
      appVersion: '1.0.1',
      frontApp: 'Minecraft',
      usage: [
        { kind: 'app', identifier: 'Minecraft.exe', name: 'Minecraft', minutes: 48 },
        { kind: 'site', identifier: 'khanacademy.org', name: 'Khan Academy', minutes: 25 },
        { kind: 'app', identifier: 'steam.exe', name: 'Steam', minutes: 7 },
      ],
      installed: [
        { kind: 'app', identifier: 'steam.exe', name: 'Steam' },
        { kind: 'app', identifier: 'notepad.exe', name: 'Notepad' },
      ],
      blocked: [
        { host: 'twitch.tv', at: new Date(WEDNESDAY_AFTERNOON.getTime() - 60000).toISOString() },
        { host: 'https://www.Reddit.com/r/all', at: WEDNESDAY_AFTERNOON.toISOString() },
      ],
    });
    assert.equal(sync.status, 200);
    // 48 (Minecraft) + 7 (Steam). Khan Academy is free and does not count.
    assert.equal(sync.body.rules.usedMinutes, 55);
    assert.equal(sync.body.rules.leftMinutes, 65);
    assert.equal(sync.body.rules.limitMinutes, 120);
    const apps = new Map<string, { allowed: boolean; usedMinutes: number; free: boolean }>(
      sync.body.rules.apps.map((a: { identifier: string }) => [a.identifier, a]),
    );
    assert.equal(apps.get('minecraft.exe')?.usedMinutes, 48);
    assert.equal(apps.get('khanacademy.org')?.usedMinutes, 25);
    // Unknown apps are added, not allowed, so the parent can see and allow them; their usage is still recorded.
    assert.equal(apps.get('steam.exe')?.allowed, false);
    assert.equal(apps.get('steam.exe')?.usedMinutes, 7);
    assert.equal(apps.get('notepad.exe')?.allowed, false);
    assert.equal(apps.get('notepad.exe')?.usedMinutes, 0);
    assert.equal(apps.size, 4);

    // --- day totals: a lower number never lowers the total; a higher one raises it
    const lower = await device.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'minecraft.exe', name: 'Minecraft', minutes: 10 }] });
    assert.equal(lower.body.rules.usedMinutes, 55);
    const higher = await device.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'minecraft.exe', name: 'Minecraft', minutes: 50 }] });
    assert.equal(higher.body.rules.usedMinutes, 57);

    // --- a second device for the same kid adds to the same day
    const { device: laptop, deviceId: laptopId } = await pairDevice(server, parent, max, 'windows', 'Family laptop');
    const second = await laptop.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'minecraft.exe', name: 'Minecraft', minutes: 5 }] });
    assert.equal(second.body.rules.usedMinutes, 62);
    assert.equal(second.body.rules.leftMinutes, 58);

    // --- dashboard
    const dash = await parent.get('/api/dashboard');
    assert.equal(dash.status, 200);
    assert.deepEqual(Object.keys(dash.body).sort(), ['appLimits', 'blocked', 'devices', 'familyPercent', 'kids', 'pausedAll', 'requests', 'week']);
    assert.equal(dash.body.kids.length, 2);
    const dMax = dash.body.kids[0];
    assert.deepEqual(dMax, {
      id: max,
      name: 'Max',
      color: dMax.color,
      limitMinutes: 120,
      usedMinutes: 62,
      leftMinutes: 58,
      locked: false,
      lockReason: null,
      statusText: 'Using Minecraft',
      bedtimeTonight: '20:30',
    });
    const dAva = dash.body.kids[1];
    assert.equal(dAva.id, ava);
    assert.equal(dAva.usedMinutes, 0);
    assert.equal(dAva.leftMinutes, 120);
    assert.equal(dAva.statusText, '2 h left');

    assert.equal(dash.body.devices.length, 2);
    const pc = dash.body.devices[0];
    assert.equal(pc.id, paired.body.deviceId);
    assert.equal(pc.name, "Max's PC");
    assert.equal(pc.platform, 'windows');
    assert.equal(pc.model, 'Dell Inspiron');
    assert.equal(pc.osVersion, 'Windows 11');
    assert.equal(pc.appVersion, '1.0.1');
    assert.equal(pc.kidId, max);
    assert.equal(pc.kidName, 'Max');
    assert.equal(pc.status, 'in_use');
    assert.ok(Math.abs(new Date(pc.lastSeenAt).getTime() - Date.now()) < 60000);
    assert.equal(dash.body.devices[1].id, laptopId);

    assert.deepEqual(dash.body.requests, []);
    assert.equal(dash.body.week.length, 7);
    assert.equal(dash.body.week[0].day, '2026-03-05');
    assert.equal(dash.body.week[6].day, TODAY);
    assert.deepEqual(dash.body.week[6].minutes, { [max]: 62, [ava]: 0 });
    assert.deepEqual(dash.body.week[0].minutes, { [max]: 0, [ava]: 0 });
    assert.equal(dash.body.blocked.length, 7);
    assert.equal(dash.body.blocked.reduce((n: number, b: { count: number }) => n + b.count, 0), 2);
    assert.deepEqual(dash.body.appLimits.map((a: { appId?: string }) => ({ ...a, appId: undefined })), [
      { kidId: max, kidName: 'Max', appId: undefined, appName: 'Minecraft', usedMinutes: 55, limitMinutes: 60 },
    ]);
    // 62 of 240 minutes for the whole family.
    assert.equal(dash.body.familyPercent, 26);
    assert.equal(dash.body.pausedAll, false);

    // --- kid page shows today's minutes per app
    const detail = await parent.get(`/api/kids/${max}`);
    const byName = new Map<string, number>(detail.body.apps.map((a: { name: string; usedMinutes: number }) => [a.name, a.usedMinutes]));
    assert.equal(byName.get('Minecraft'), 55);
    assert.equal(byName.get('Khan Academy'), 25);
    assert.equal(byName.get('Steam'), 7);
    assert.equal(byName.get('Notepad'), 0);
    assert.deepEqual(detail.body.today, { limitMinutes: 120, usedMinutes: 62, leftMinutes: 58, locked: false, lockReason: null });

    // --- device list
    const devices = await parent.get('/api/devices');
    assert.equal(devices.body.devices.length, 2);
    assert.equal(devices.body.devices[0].status, 'in_use');

    // --- reports
    const report = await parent.get(`/api/reports?kidId=${max}&days=7`);
    assert.equal(report.status, 200);
    assert.equal(report.body.days.length, 7);
    const last = report.body.days[6];
    assert.equal(last.day, TODAY);
    assert.equal(last.minutes, 62);
    assert.deepEqual(
      last.byApp.map((a: { name: string; minutes: number }) => [a.name, a.minutes]),
      [['Minecraft', 55], ['Khan Academy', 25], ['Steam', 7]],
    );
    assert.deepEqual(report.body.days[0], { day: '2026-03-05', minutes: 0, byApp: [] });
    assert.deepEqual(report.body.blocked.map((b: { host: string; count: number }) => [b.host, b.count]).sort(), [['reddit.com', 1], ['twitch.tv', 1]]);
    assert.ok(!Number.isNaN(new Date(report.body.blocked[0].lastAt).getTime()));
    assert.equal((await parent.get('/api/reports?days=30')).body.days.length, 30);
    assert.equal((await parent.get('/api/reports?kidId=&days=7')).body.days[6].minutes, 62);
    assert.equal((await parent.get(`/api/reports?kidId=${ava}&days=7`)).body.days[6].minutes, 0);
    assert.equal((await parent.get('/api/reports?days=14')).status, 400);
    assert.equal((await parent.get(`/api/reports?kidId=${NOBODY}`)).status, 404);
  });

  it('a device that has not been seen for 3 minutes is off; a locked kid shows locked', async () => {
    const parent = await signIn(server, 'status@example.com');
    const kid = await createKid(parent, 'Max');
    const { device, deviceId } = await pairDevice(server, parent, kid, 'android', 'Phone');
    await device.post('/api/device/sync', {});
    const status = async (): Promise<string> => (await parent.get('/api/dashboard')).body.devices[0].status as string;
    assert.equal(await status(), 'in_use');
    await parent.post(`/api/kids/${kid}/lock`, { locked: true });
    assert.equal(await status(), 'locked');
    await server.pool.query("UPDATE devices SET last_seen_at = now() - interval '2 minutes 50 seconds' WHERE id = $1", [deviceId]);
    assert.equal(await status(), 'locked');
    await server.pool.query("UPDATE devices SET last_seen_at = now() - interval '3 minutes 5 seconds' WHERE id = $1", [deviceId]);
    assert.equal(await status(), 'off');
    await device.post('/api/device/sync', {});
    assert.equal(await status(), 'locked');
  });

  it('pair rejects wrong, expired and mismatched codes', async () => {
    const parent = await signIn(server, 'pair-bad@example.com');
    const kid = await createKid(parent, 'Max');
    const anyone = new Client(server.url);

    assert.equal((await anyone.post('/api/device/pair', { code: 'ZZZZZZZZ', name: 'PC', platform: 'windows' })).status, 404);
    assert.equal((await anyone.post('/api/device/pair', { code: 'short', name: 'PC', platform: 'windows' })).status, 404);
    assert.equal((await anyone.post('/api/device/pair', { name: 'PC', platform: 'windows' })).status, 400);

    const code = (await parent.post('/api/devices/pairing-code', { kidId: kid, platform: 'android' })).body.code as string;
    assert.equal((await anyone.post('/api/device/pair', { code, platform: 'android' })).status, 400); // no name
    assert.equal((await anyone.post('/api/device/pair', { code, name: 'X', platform: 'ios' })).status, 400);
    const mismatch = await anyone.post('/api/device/pair', { code, name: 'PC', platform: 'windows' });
    assert.equal(mismatch.status, 400);
    // The mismatch did not burn the code.
    await server.pool.query("UPDATE pairing_codes SET expires_at = now() - interval '1 second' WHERE code = $1", [code]);
    assert.equal((await anyone.post('/api/device/pair', { code, name: 'Phone', platform: 'android' })).status, 404);

    assert.equal((await parent.post('/api/devices/pairing-code', { kidId: kid, platform: 'ios' })).status, 400);
    assert.equal((await parent.post('/api/devices/pairing-code', { kidId: NOBODY, platform: 'android' })).status, 404);
    assert.equal((await parent.post('/api/devices/pairing-code', { platform: 'android' })).status, 404);
    assert.deepEqual((await parent.get('/api/devices')).body.devices, []);
  });

  it('two devices racing for one code: only one wins', async () => {
    const parent = await signIn(server, 'pair-race@example.com');
    const kid = await createKid(parent, 'Max');
    const code = (await parent.post('/api/devices/pairing-code', { kidId: kid, platform: 'windows' })).body.code as string;
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => new Client(server.url).post('/api/device/pair', { code, name: `PC ${n}`, platform: 'windows' })),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 404, 404, 404]);
    assert.equal((await parent.get('/api/devices')).body.devices.length, 1);
  });

  it('device routes need a valid bearer token', async () => {
    const nobody = new Client(server.url);
    assert.equal((await nobody.post('/api/device/sync', {})).status, 401);
    nobody.bearer = 'A'.repeat(43);
    for (const [method, p] of [['POST', '/api/device/sync'], ['POST', '/api/device/request'], ['POST', '/api/device/pin'], ['GET', `/api/device/requests/${NOBODY}`]] as const) {
      const res = await nobody.send(method, p, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 401, p);
      assert.equal(typeof res.body.error, 'string');
    }
    // A parent cookie is not a device token, and a device token is not a parent session.
    const parent = await signIn(server, 'bearer@example.com');
    assert.equal((await parent.post('/api/device/sync', {})).status, 401);
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    assert.equal((await device.get('/api/dashboard')).status, 401);
    assert.equal((await device.get('/api/me')).status, 401);
  });

  it('sync validates what the device sends', async () => {
    const parent = await signIn(server, 'sync-validate@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    for (const body of [
      { usage: 'lots' },
      { usage: [{ kind: 'app', identifier: 'a.exe', name: 'A' }] },
      { usage: [{ kind: 'app', identifier: 'a.exe', name: 'A', minutes: -3 }] },
      { usage: [{ kind: 'app', identifier: 'a.exe', name: 'A', minutes: '5' }] },
      { usage: [{ kind: 'thing', identifier: 'a.exe', name: 'A', minutes: 5 }] },
      { usage: [null] },
      { installed: [{ kind: 'app' }] },
      { blocked: [{ at: 'now' }] },
      { blocked: {} },
      [],
    ]) {
      const res = await device.post('/api/device/sync', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(typeof res.body.error, 'string');
    }
    // Repeats in one report: the highest total wins. Minutes are capped at one day.
    const res = await device.post('/api/device/sync', {
      usage: [
        { kind: 'app', identifier: 'a.exe', name: 'A', minutes: 5 },
        { kind: 'app', identifier: 'A.EXE', name: 'A', minutes: 9 },
        { kind: 'app', identifier: 'b.exe', name: 'B', minutes: 99999 },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.rules.usedMinutes, 9 + 1440);
    assert.equal(res.body.rules.apps.length, 2);
    // A blocked entry with a nonsense time is stored with the server's time, not rejected.
    assert.equal((await device.post('/api/device/sync', { blocked: [{ host: 'x.example', at: 'whenever' }, { host: 'y.example', at: '2999-01-01T00:00:00Z' }] })).status, 200);
    const stored = await server.pool.query<{ at: Date }>('SELECT at FROM blocked_events WHERE kid_id = $1', [kid]);
    assert.deepEqual(stored.rows.map((r) => r.at.toISOString()), [WEDNESDAY_AFTERNOON.toISOString(), WEDNESDAY_AFTERNOON.toISOString()]);
  });

  it('usage is filed under the day in the family time zone', async () => {
    const parent = await signIn(server, 'day@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    await device.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'a.exe', name: 'A', minutes: 30 }] });
    const rows = await server.pool.query<{ day: string; minutes: number }>('SELECT day, minutes FROM usage WHERE kid_id = $1', [kid]);
    assert.deepEqual(rows.rows, [{ day: TODAY, minutes: 30 }]);

    // The next day starts fresh: yesterday's minutes no longer count, and the week chart keeps them.
    server.setNow(new Date('2026-03-12T21:00:00Z'));
    try {
      const next = await device.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'a.exe', name: 'A', minutes: 4 }] });
      assert.equal(next.body.rules.usedMinutes, 4);
      const week = (await parent.get('/api/dashboard')).body.week;
      assert.equal(week[6].day, '2026-03-12');
      assert.equal(week[6].minutes[kid], 4);
      assert.equal(week[5].minutes[kid], 30);
    } finally {
      server.setNow(new Date('2026-03-11T21:00:00Z'));
    }
  });

  it('weekend limit and bedtime reach the device', async () => {
    const parent = await signIn(server, 'weekend@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'android', 'Phone');
    try {
      server.setNow(new Date('2026-03-14T18:00:00Z')); // Saturday noon in Denver
      const saturday = (await device.post('/api/device/sync', {})).body.rules;
      assert.equal(saturday.limitMinutes, 180);
      assert.equal(saturday.lockReason, null);
      assert.deepEqual(saturday.bedtime, { enabled: true, start: '21:30', end: '07:00' });

      server.setNow(new Date('2026-03-14T12:30:00Z')); // Saturday 06:30: Friday's "other night" still runs
      const early = (await device.post('/api/device/sync', {})).body.rules;
      assert.equal(early.locked, true);
      assert.equal(early.lockReason, 'bedtime');
      assert.equal((await parent.get('/api/dashboard')).body.kids[0].statusText, 'Bedtime until 07:00');

      server.setNow(new Date('2026-03-12T03:00:00Z')); // Wednesday 21:00: school night
      assert.equal((await device.post('/api/device/sync', {})).body.rules.lockReason, 'bedtime');
      await parent.patch(`/api/kids/${kid}`, { bedtimeEnabled: false });
      const off = (await device.post('/api/device/sync', {})).body.rules;
      assert.equal(off.lockReason, null);
      assert.equal(off.bedtime.enabled, false);
      assert.equal((await parent.get('/api/dashboard')).body.kids[0].bedtimeTonight, null);
    } finally {
      server.setNow(new Date('2026-03-11T21:00:00Z'));
    }
  });

  it('the family time zone decides what "today" is', async () => {
    const parent = await signIn(server, 'tokyo@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'android', 'Phone');
    await parent.patch(`/api/kids/${kid}`, { bedtimeEnabled: false });
    try {
      server.setNow(new Date('2026-03-14T02:00:00Z')); // Friday 20:00 in Denver, Saturday 11:00 in Tokyo
      assert.equal((await device.post('/api/device/sync', {})).body.rules.limitMinutes, 120);
      await parent.patch('/api/account', { timezone: 'Asia/Tokyo' });
      assert.equal((await device.post('/api/device/sync', {})).body.rules.limitMinutes, 180);
    } finally {
      server.setNow(new Date('2026-03-11T21:00:00Z'));
    }
  });

  it('renames a device, moves it to another kid, and removes it', async () => {
    const parent = await signIn(server, 'device-edit@example.com');
    const max = await createKid(parent, 'Max');
    const ava = await createKid(parent, 'Ava');
    const { device, deviceId } = await pairDevice(server, parent, max, 'android', 'Phone');

    const renamed = await parent.patch(`/api/devices/${deviceId}`, { name: "Ava's phone", kidId: ava });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.device.name, "Ava's phone");
    assert.equal(renamed.body.device.kidId, ava);
    assert.equal(renamed.body.device.kidName, 'Ava');
    assert.equal((await device.post('/api/device/sync', {})).body.kid.id, ava);

    assert.equal((await parent.patch(`/api/devices/${deviceId}`, {})).status, 400);
    assert.equal((await parent.patch(`/api/devices/${deviceId}`, { name: '' })).status, 400);
    assert.equal((await parent.patch(`/api/devices/${deviceId}`, { kidId: NOBODY })).status, 404);
    assert.equal((await parent.patch(`/api/devices/${NOBODY}`, { name: 'X' })).status, 404);

    assert.deepEqual((await parent.del(`/api/devices/${deviceId}`)).body, { ok: true });
    assert.equal((await parent.del(`/api/devices/${deviceId}`)).status, 404);
    // The removed device's token stops working at once.
    assert.equal((await device.post('/api/device/sync', {})).status, 401);
  });

  it('removing a device keeps the minutes the kid already used', async () => {
    const parent = await signIn(server, 'device-keep@example.com');
    const kid = await createKid(parent, 'Max');
    const { device, deviceId } = await pairDevice(server, parent, kid, 'windows', 'PC');
    await device.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'a.exe', name: 'A', minutes: 40 }] });
    await parent.del(`/api/devices/${deviceId}`);
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.today.usedMinutes, 40);
  });
});

describe('requests from the kid', () => {
  it('device request → parent approves → the next sync shows more time', async () => {
    const parent = await signIn(server, 'requests@example.com');
    const kid = await createKid(parent, 'Max');
    const { device, deviceId } = await pairDevice(server, parent, kid, 'windows', "Max's PC");

    const before = await device.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'game.exe', name: 'Game', minutes: 120 }] });
    assert.equal(before.body.rules.limitMinutes, 120);
    assert.equal(before.body.rules.leftMinutes, 0);
    assert.equal(before.body.rules.locked, true);
    assert.equal(before.body.rules.lockReason, 'time');

    const asked = await device.post('/api/device/request', { kind: 'time', minutes: 15 });
    assert.equal(asked.status, 201);
    assert.match(asked.body.id, UUID);
    assert.equal(asked.body.status, 'pending');
    assert.deepEqual((await device.get(`/api/device/requests/${asked.body.id}`)).body, { id: asked.body.id, status: 'pending' });

    // The parent sees it on the dashboard and in the list.
    const dash = await parent.get('/api/dashboard');
    assert.equal(dash.body.requests.length, 1);
    const shown = dash.body.requests[0];
    assert.equal(shown.id, asked.body.id);
    assert.equal(shown.kidId, kid);
    assert.equal(shown.kidName, 'Max');
    assert.equal(shown.deviceId, deviceId);
    assert.equal(shown.deviceName, "Max's PC");
    assert.equal(shown.kind, 'time');
    assert.equal(shown.minutes, 15);
    assert.equal(shown.status, 'pending');
    assert.equal(shown.decidedAt, null);
    assert.ok(!Number.isNaN(new Date(shown.createdAt).getTime()));
    assert.equal((await parent.get('/api/requests?status=pending')).body.requests.length, 1);
    assert.equal((await parent.get('/api/requests')).body.requests.length, 1);

    // Nothing changes until the parent answers.
    assert.equal((await device.post('/api/device/sync', {})).body.rules.leftMinutes, 0);

    const decided = await parent.post(`/api/requests/${asked.body.id}/decide`, { approve: true });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.request.status, 'approved');
    assert.ok(decided.body.request.decidedAt);

    const afterSync = await device.post('/api/device/sync', {});
    assert.equal(afterSync.body.rules.limitMinutes, 135);
    assert.equal(afterSync.body.rules.usedMinutes, 120);
    assert.equal(afterSync.body.rules.leftMinutes, 15);
    assert.equal(afterSync.body.rules.locked, false);
    assert.equal(afterSync.body.rules.lockReason, null);
    assert.deepEqual((await device.get(`/api/device/requests/${asked.body.id}`)).body, { id: asked.body.id, status: 'approved' });

    // Answered requests leave the waiting list but stay in "all".
    assert.deepEqual((await parent.get('/api/dashboard')).body.requests, []);
    assert.deepEqual((await parent.get('/api/requests?status=pending')).body.requests, []);
    assert.equal((await parent.get('/api/requests?status=all')).body.requests.length, 1);
    assert.equal((await parent.get('/api/requests?status=old')).status, 400);

    // A request can be answered only once.
    assert.equal((await parent.post(`/api/requests/${asked.body.id}/decide`, { approve: true })).status, 409);
    assert.equal((await parent.post(`/api/requests/${asked.body.id}/decide`, { approve: false })).status, 409);
    assert.equal((await device.post('/api/device/sync', {})).body.rules.limitMinutes, 135);

    // The grant is for today only.
    server.setNow(new Date('2026-03-12T21:00:00Z'));
    try {
      assert.equal((await device.post('/api/device/sync', {})).body.rules.limitMinutes, 120);
    } finally {
      server.setNow(new Date('2026-03-11T21:00:00Z'));
    }
  });

  it('a denied request changes nothing', async () => {
    const parent = await signIn(server, 'requests-deny@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    const asked = await device.post('/api/device/request', { kind: 'time', minutes: 30 });
    const decided = await parent.post(`/api/requests/${asked.body.id}/decide`, { approve: false });
    assert.equal(decided.body.request.status, 'denied');
    assert.equal((await device.get(`/api/device/requests/${asked.body.id}`)).body.status, 'denied');
    assert.equal((await device.post('/api/device/sync', {})).body.rules.limitMinutes, 120);
    assert.equal((await parent.post(`/api/requests/${asked.body.id}/decide`, {})).status, 400);
  });

  it('approving an app or site request allows it', async () => {
    const parent = await signIn(server, 'requests-app@example.com');
    const kid = await createKid(parent, 'Ava');
    const { device } = await pairDevice(server, parent, kid, 'android', "Ava's phone");

    // An app the device already reported (so it exists, not allowed).
    await device.post('/api/device/sync', { installed: [{ kind: 'app', identifier: 'com.duolingo', name: 'Duolingo' }] });
    const appReq = await device.post('/api/device/request', { kind: 'app', detail: 'Duolingo', identifier: 'com.duolingo' });
    assert.equal(appReq.status, 201);
    // A site nobody has seen yet.
    const siteReq = await device.post('/api/device/request', { kind: 'site', detail: 'https://www.PBSkids.org/games' });
    assert.equal(siteReq.status, 201);

    const list = (await parent.get('/api/requests')).body.requests;
    assert.equal(list.length, 2);
    assert.equal(list[0].id, siteReq.body.id); // newest first
    assert.equal(list[0].kind, 'site');
    assert.equal(list[0].identifier, 'pbskids.org');
    assert.equal(list[1].detail, 'Duolingo');

    await parent.post(`/api/requests/${appReq.body.id}/decide`, { approve: true });
    await parent.post(`/api/requests/${siteReq.body.id}/decide`, { approve: true });

    const apps = (await device.post('/api/device/sync', {})).body.rules.apps as Array<{ identifier: string; allowed: boolean; kind: string; platform: string }>;
    assert.deepEqual(
      apps.map((a) => [a.kind, a.platform, a.identifier, a.allowed]).sort(),
      [['app', 'android', 'com.duolingo', true], ['site', 'any', 'pbskids.org', true]],
    );
  });

  it('validates requests and allows at most 5 waiting per kid', async () => {
    const parent = await signIn(server, 'requests-limit@example.com');
    const kid = await createKid(parent, 'Max');
    const other = await createKid(parent, 'Ava');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    const { device: otherDevice } = await pairDevice(server, parent, other, 'android', 'Phone');

    for (const body of [{}, { kind: 'toy' }, { kind: 'time' }, { kind: 'time', minutes: 0 }, { kind: 'time', minutes: 241 }, { kind: 'time', minutes: 1.5 }, { kind: 'app' }, { kind: 'site', detail: '' }]) {
      assert.equal((await device.post('/api/device/request', body)).status, 400, JSON.stringify(body));
    }
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await device.post('/api/device/request', { kind: 'time', minutes: 10 + i });
      assert.equal(res.status, 201);
      ids.push(res.body.id);
    }
    const sixth = await device.post('/api/device/request', { kind: 'time', minutes: 10 });
    assert.equal(sixth.status, 429);
    assert.equal(typeof sixth.body.error, 'string');
    // The limit is per kid.
    assert.equal((await otherDevice.post('/api/device/request', { kind: 'time', minutes: 10 })).status, 201);
    // Once one is answered there is room again.
    await parent.post(`/api/requests/${ids[0]}/decide`, { approve: false });
    assert.equal((await device.post('/api/device/request', { kind: 'time', minutes: 10 })).status, 201);
    // A burst cannot slip past the limit.
    await parent.post(`/api/requests/${ids[1]}/decide`, { approve: false });
    const burst = await Promise.all([1, 2, 3, 4].map(() => device.post('/api/device/request', { kind: 'time', minutes: 5 })));
    assert.equal(burst.filter((r) => r.status === 201).length, 1);
    const pending = await server.pool.query("SELECT 1 FROM requests WHERE kid_id = $1 AND status = 'pending'", [kid]);
    assert.equal(pending.rowCount, 5);

    assert.equal((await device.get(`/api/device/requests/${NOBODY}`)).status, 404);
    assert.equal((await device.get('/api/device/requests/abc')).status, 404);
    assert.equal((await parent.post(`/api/requests/${NOBODY}/decide`, { approve: true })).status, 404);
  });
});

describe('parent controls', () => {
  it('extra time from the parent (grant)', async () => {
    const parent = await signIn(server, 'grant@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    const granted = await parent.post(`/api/kids/${kid}/grant`, { minutes: 15 });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.today.limitMinutes, 135);
    await parent.post(`/api/kids/${kid}/grant`, { minutes: 240 });
    assert.equal((await device.post('/api/device/sync', {})).body.rules.limitMinutes, 375);
    for (const minutes of [0, 241, -5, 1.5, '15', null]) {
      assert.equal((await parent.post(`/api/kids/${kid}/grant`, { minutes })).status, 400, String(minutes));
    }
    assert.equal((await parent.post(`/api/kids/${kid}/grant`, {})).status, 400);
  });

  it('lock now, then unlock', async () => {
    const parent = await signIn(server, 'lock@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    assert.equal((await device.post('/api/device/sync', {})).body.rules.locked, false);

    const locked = await parent.post(`/api/kids/${kid}/lock`, { locked: true });
    assert.equal(locked.status, 200);
    assert.equal(locked.body.kid.locked, true);
    assert.equal(locked.body.today.lockReason, 'parent');

    const sync = await device.post('/api/device/sync', {});
    assert.equal(sync.body.rules.locked, true);
    assert.equal(sync.body.rules.lockReason, 'parent');
    assert.equal(sync.body.rules.leftMinutes, 120); // the time is not taken away
    const dash = await parent.get('/api/dashboard');
    assert.equal(dash.body.kids[0].locked, true);
    assert.equal(dash.body.kids[0].lockReason, 'parent');
    assert.equal(dash.body.kids[0].statusText, 'Locked by a parent');
    assert.equal(dash.body.devices[0].status, 'locked');
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.kid.locked, true);

    await parent.post(`/api/kids/${kid}/lock`, { locked: false });
    const unlocked = await device.post('/api/device/sync', {});
    assert.equal(unlocked.body.rules.locked, false);
    assert.equal(unlocked.body.rules.lockReason, null);
    assert.equal((await parent.post(`/api/kids/${kid}/lock`, {})).status, 400);
    assert.equal((await parent.post(`/api/kids/${kid}/lock`, { locked: 'yes' })).status, 400);
  });

  it('pause all screens locks every kid, and beats the other reasons', async () => {
    const parent = await signIn(server, 'pause@example.com');
    const max = await createKid(parent, 'Max');
    const ava = await createKid(parent, 'Ava');
    const { device: pc } = await pairDevice(server, parent, max, 'windows', 'PC');
    const { device: phone } = await pairDevice(server, parent, ava, 'android', 'Phone');
    await parent.post(`/api/kids/${ava}/lock`, { locked: true });

    const paused = await parent.post('/api/pause-all', { paused: true });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.pausedAll, true);
    assert.equal((await parent.get('/api/me')).body.account.pausedAll, true);

    for (const device of [pc, phone]) {
      const rules = (await device.post('/api/device/sync', {})).body.rules;
      assert.equal(rules.locked, true);
      assert.equal(rules.lockReason, 'paused');
    }
    const dash = await parent.get('/api/dashboard');
    assert.equal(dash.body.pausedAll, true);
    assert.deepEqual(dash.body.kids.map((k: { lockReason: string }) => k.lockReason), ['paused', 'paused']);
    assert.deepEqual(dash.body.kids.map((k: { statusText: string }) => k.statusText), ['Paused', 'Paused']);
    assert.deepEqual(dash.body.devices.map((d: { status: string }) => d.status), ['locked', 'locked']);

    await parent.post('/api/pause-all', { paused: false });
    assert.equal((await pc.post('/api/device/sync', {})).body.rules.lockReason, null);
    assert.equal((await phone.post('/api/device/sync', {})).body.rules.lockReason, 'parent'); // Ava is still locked by the parent
    assert.equal((await parent.get('/api/dashboard')).body.pausedAll, false);
    assert.equal((await parent.post('/api/pause-all', {})).status, 400);
    assert.equal((await parent.post('/api/pause-all', { paused: 1 })).status, 400);
  });

  it('removing an app gives back only today\'s minutes for it and the device can report again', async () => {
    const parent = await signIn(server, 'app-remove@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    await device.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'a.exe', name: 'A', minutes: 30 }] });
    const app = (await parent.get(`/api/kids/${kid}`)).body.apps[0];
    await parent.del(`/api/apps/${app.id}`);
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.today.usedMinutes, 0);
    const again = await device.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'a.exe', name: 'A', minutes: 31 }] });
    assert.equal(again.body.rules.usedMinutes, 31);
    assert.equal(again.body.rules.apps[0].allowed, false);
  });

  it('a free app stops counting as soon as the parent marks it free', async () => {
    const parent = await signIn(server, 'free@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    const first = await device.post('/api/device/sync', {
      usage: [{ kind: 'app', identifier: 'scratch.exe', name: 'Scratch', minutes: 50 }, { kind: 'app', identifier: 'game.exe', name: 'Game', minutes: 20 }],
    });
    assert.equal(first.body.rules.usedMinutes, 70);
    const scratch = (await parent.get(`/api/kids/${kid}`)).body.apps.find((a: { name: string }) => a.name === 'Scratch');
    await parent.patch(`/api/apps/${scratch.id}`, { free: true, allowed: true });
    const second = await device.post('/api/device/sync', {});
    assert.equal(second.body.rules.usedMinutes, 20);
    assert.equal(second.body.rules.leftMinutes, 100);
    const dash = await parent.get('/api/dashboard');
    assert.equal(dash.body.kids[0].usedMinutes, 20);
    assert.equal(dash.body.week[6].minutes[kid], 20);
    const report = await parent.get(`/api/reports?kidId=${kid}&days=7`);
    assert.equal(report.body.days[6].minutes, 20);
    assert.equal(report.body.days[6].byApp.length, 2); // the free app is still listed
  });
});

describe('account isolation', () => {
  it('account B cannot read or change anything of account A', async () => {
    const a = await signIn(server, 'family-a@example.com');
    const b = await signIn(server, 'family-b@example.com');

    // Family A: a kid, a device, an app, a contact, a waiting request.
    const kidA = await createKid(a, 'Max');
    const { device: deviceA, deviceId: deviceIdA } = await pairDevice(server, a, kidA, 'windows', "Max's PC");
    await deviceA.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'game.exe', name: 'Game', minutes: 33 }], blocked: [{ host: 'secret.example' }] });
    const appA = (await a.post(`/api/kids/${kidA}/apps`, { kind: 'site', identifier: 'a-family.example', name: 'A site' })).body.app.id as string;
    const contactA = (await a.post(`/api/kids/${kidA}/contacts`, { name: 'Mom A', phone: '555 0001' })).body.contact.id as string;
    const requestA = (await deviceA.post('/api/device/request', { kind: 'time', minutes: 20 })).body.id as string;

    // Family B has its own kid and device.
    const kidB = await createKid(b, 'Zoe');
    const { device: deviceB, deviceId: deviceIdB } = await pairDevice(server, b, kidB, 'android', "Zoe's phone");

    // --- kid
    assert.equal((await b.get(`/api/kids/${kidA}`)).status, 404);
    assert.equal((await b.patch(`/api/kids/${kidA}`, { name: 'Hacked', limitSchoolMinutes: 0 })).status, 404);
    assert.equal((await b.post(`/api/kids/${kidA}/grant`, { minutes: 60 })).status, 404);
    assert.equal((await b.post(`/api/kids/${kidA}/lock`, { locked: true })).status, 404);
    assert.equal((await b.post(`/api/kids/${kidA}/apps`, { kind: 'site', identifier: 'evil.example', name: 'Evil' })).status, 404);
    assert.equal((await b.post(`/api/kids/${kidA}/contacts`, { name: 'Stranger', phone: '555 6666' })).status, 404);
    assert.equal((await b.del(`/api/kids/${kidA}`)).status, 404);
    // --- device
    assert.equal((await b.patch(`/api/devices/${deviceIdA}`, { name: 'Hacked' })).status, 404);
    assert.equal((await b.patch(`/api/devices/${deviceIdA}`, { kidId: kidB })).status, 404);
    assert.equal((await b.del(`/api/devices/${deviceIdA}`)).status, 404);
    // B's own device cannot be moved to A's kid either.
    assert.equal((await b.patch(`/api/devices/${deviceIdB}`, { kidId: kidA })).status, 404);
    assert.equal((await b.post('/api/devices/pairing-code', { kidId: kidA, platform: 'windows' })).status, 404);
    // --- app
    assert.equal((await b.patch(`/api/apps/${appA}`, { allowed: false, free: true, name: 'Hacked' })).status, 404);
    assert.equal((await b.del(`/api/apps/${appA}`)).status, 404);
    // --- contact
    assert.equal((await b.patch(`/api/contacts/${contactA}`, { name: 'Hacked', phone: '555 6666' })).status, 404);
    assert.equal((await b.del(`/api/contacts/${contactA}`)).status, 404);
    // --- request
    assert.equal((await b.post(`/api/requests/${requestA}/decide`, { approve: true })).status, 404);
    assert.equal((await b.post(`/api/requests/${requestA}/decide`, { approve: false })).status, 404);
    assert.equal((await deviceB.get(`/api/device/requests/${requestA}`)).status, 404);
    // --- reports
    assert.equal((await b.get(`/api/reports?kidId=${kidA}&days=7`)).status, 404);

    // --- B's lists show only B's things
    const dashB = await b.get('/api/dashboard');
    assert.deepEqual(dashB.body.kids.map((k: { id: string }) => k.id), [kidB]);
    assert.deepEqual(dashB.body.devices.map((d: { id: string }) => d.id), [deviceIdB]);
    assert.deepEqual(dashB.body.requests, []);
    assert.deepEqual(dashB.body.appLimits, []);
    assert.deepEqual(Object.keys(dashB.body.week[6].minutes), [kidB]);
    assert.equal(dashB.body.blocked.reduce((n: number, x: { count: number }) => n + x.count, 0), 0);
    assert.deepEqual((await b.get('/api/kids')).body.kids.map((k: { id: string }) => k.id), [kidB]);
    assert.deepEqual((await b.get('/api/devices')).body.devices.map((d: { id: string }) => d.id), [deviceIdB]);
    assert.deepEqual((await b.get('/api/requests?status=all')).body.requests, []);
    const reportB = await b.get('/api/reports?days=30');
    assert.equal(reportB.body.days.reduce((n: number, d: { minutes: number }) => n + d.minutes, 0), 0);
    assert.deepEqual(reportB.body.blocked, []);
    const text = JSON.stringify([dashB.body, reportB.body]);
    for (const secret of [kidA, deviceIdA, appA, contactA, requestA, 'secret.example', 'Max', 'Mom A']) {
      assert.equal(text.includes(secret), false, `B can see ${secret}`);
    }
    // --- B's device sees only B's rules
    const syncB = await deviceB.post('/api/device/sync', {});
    assert.equal(syncB.body.kid.id, kidB);
    assert.deepEqual(syncB.body.rules.apps, []);
    assert.deepEqual(syncB.body.rules.contacts, []);
    // --- pausing B does not pause A
    await b.post('/api/pause-all', { paused: true });
    assert.equal((await deviceA.post('/api/device/sync', {})).body.rules.lockReason, null);

    // --- and after all that, family A is exactly as it was
    const detailA = await a.get(`/api/kids/${kidA}`);
    assert.equal(detailA.status, 200);
    assert.equal(detailA.body.kid.name, 'Max');
    assert.equal(detailA.body.kid.locked, false);
    assert.equal(detailA.body.kid.limitSchoolMinutes, 120);
    assert.deepEqual(detailA.body.today, { limitMinutes: 120, usedMinutes: 33, leftMinutes: 87, locked: false, lockReason: null });
    assert.deepEqual(detailA.body.apps.map((x: { name: string; allowed: boolean; free: boolean }) => [x.name, x.allowed, x.free]), [['A site', true, false], ['Game', false, false]]);
    assert.deepEqual(detailA.body.contacts.map((c: { name: string; phone: string }) => [c.name, c.phone]), [['Mom A', '555 0001']]);
    const devicesA = (await a.get('/api/devices')).body.devices;
    assert.equal(devicesA.length, 1);
    assert.equal(devicesA[0].name, "Max's PC");
    assert.equal(devicesA[0].kidId, kidA);
    const requestsA = (await a.get('/api/requests')).body.requests;
    assert.equal(requestsA.length, 1);
    assert.equal(requestsA[0].status, 'pending');
    const codes = await server.pool.query('SELECT 1 FROM pairing_codes WHERE kid_id = $1 AND used_at IS NULL', [kidA]);
    assert.equal(codes.rowCount, 0);
  });

  it('the same app or site in two families stays separate', async () => {
    const a = await signIn(server, 'same-a@example.com');
    const b = await signIn(server, 'same-b@example.com');
    const kidA = await createKid(a, 'Kid');
    const kidB = await createKid(b, 'Kid');
    const appA = await a.post(`/api/kids/${kidA}/apps`, { kind: 'site', identifier: 'shared.example', name: 'Shared', free: true });
    const appB = await b.post(`/api/kids/${kidB}/apps`, { kind: 'site', identifier: 'shared.example', name: 'Shared' });
    assert.equal(appA.status, 201);
    assert.equal(appB.status, 201);
    assert.notEqual(appA.body.app.id, appB.body.app.id);
    await b.patch(`/api/apps/${appB.body.app.id}`, { allowed: false });
    assert.equal((await a.get(`/api/kids/${kidA}`)).body.apps[0].allowed, true);
    assert.equal((await a.get(`/api/kids/${kidA}`)).body.apps[0].free, true);
  });
});

describe('trial end and the locked account', () => {
  it('a locked account gets 402 everywhere except /api/me, billing and sign-out', async () => {
    const parent = await signIn(server, 'locked@example.com');
    const kid = await createKid(parent, 'Max');
    const { device, deviceId } = await pairDevice(server, parent, kid, 'windows', 'PC');
    const app = (await parent.post(`/api/kids/${kid}/apps`, { kind: 'site', identifier: 'x.example', name: 'X' })).body.app.id as string;
    const contact = (await parent.post(`/api/kids/${kid}/contacts`, { name: 'Mom', phone: '555 0100' })).body.contact.id as string;
    const request = (await device.post('/api/device/request', { kind: 'time', minutes: 5 })).body.id as string;
    await parent.patch(`/api/kids/${kid}`, { limitSchoolMinutes: 45 });

    // The trial runs out.
    await server.pool.query("UPDATE accounts SET trial_ends_at = now() - interval '1 minute' WHERE email = 'locked@example.com'");

    const me = await parent.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.account.plan, 'locked');
    assert.equal(me.body.account.trialDaysLeft, 0);

    const billing = await parent.get('/api/billing');
    assert.equal(billing.status, 200);
    assert.equal(billing.body.plan, 'locked');
    assert.equal(billing.body.trialDaysLeft, 0);
    assert.deepEqual(billing.body.prices, { month: 4, year: 36 });
    assert.equal(billing.body.stripeReady, false);
    // Checkout is reachable (503 here only because this test server has no Stripe key), never 402.
    assert.equal((await parent.post('/api/billing/checkout', { interval: 'month' })).status, 503);
    assert.equal((await parent.post('/api/billing/portal')).status, 503);

    const blocked: Array<[string, string, unknown?]> = [
      ['GET', '/api/dashboard'],
      ['POST', '/api/pause-all', { paused: true }],
      ['PATCH', '/api/account', { timezone: 'UTC' }],
      ['GET', '/api/kids'],
      ['POST', '/api/kids', { name: 'New' }],
      ['GET', `/api/kids/${kid}`],
      ['PATCH', `/api/kids/${kid}`, { name: 'Changed' }],
      ['DELETE', `/api/kids/${kid}`],
      ['POST', `/api/kids/${kid}/grant`, { minutes: 5 }],
      ['POST', `/api/kids/${kid}/lock`, { locked: true }],
      ['POST', `/api/kids/${kid}/apps`, { kind: 'site', identifier: 'y.example', name: 'Y' }],
      ['PATCH', `/api/apps/${app}`, { allowed: false }],
      ['DELETE', `/api/apps/${app}`],
      ['POST', `/api/kids/${kid}/contacts`, { name: 'Dad', phone: '555 0101' }],
      ['PATCH', `/api/contacts/${contact}`, { name: 'Mum' }],
      ['DELETE', `/api/contacts/${contact}`],
      ['GET', '/api/devices'],
      ['POST', '/api/devices/pairing-code', { kidId: kid, platform: 'windows' }],
      ['PATCH', `/api/devices/${deviceId}`, { name: 'Changed' }],
      ['DELETE', `/api/devices/${deviceId}`],
      ['GET', '/api/requests'],
      ['POST', `/api/requests/${request}/decide`, { approve: true }],
      ['GET', '/api/reports?days=7'],
    ];
    for (const [method, p, body] of blocked) {
      const res = await parent.send(method, p, body);
      assert.equal(res.status, 402, `${method} ${p}`);
      assert.equal(res.body.locked, true, `${method} ${p}`);
      assert.equal(typeof res.body.error, 'string', `${method} ${p}`);
    }

    // Nothing was changed by the refused calls, and device rules keep working with the last settings.
    const sync = await device.post('/api/device/sync', { usage: [{ kind: 'app', identifier: 'a.exe', name: 'A', minutes: 10 }] });
    assert.equal(sync.status, 200);
    assert.equal(sync.body.kid.name, 'Max');
    assert.equal(sync.body.rules.limitMinutes, 45);
    assert.equal(sync.body.rules.usedMinutes, 10);
    assert.equal(sync.body.rules.locked, false);
    assert.equal(sync.body.rules.contacts.length, 1);
    assert.equal((await device.get(`/api/device/requests/${request}`)).body.status, 'pending');

    // Choosing a plan opens the console again.
    await server.pool.query("UPDATE accounts SET plan = 'active' WHERE email = 'locked@example.com'");
    assert.equal((await parent.get('/api/dashboard')).status, 200);
    assert.equal((await parent.get('/api/me')).body.account.plan, 'active');

    // A locked account can still sign out.
    await server.pool.query("UPDATE accounts SET plan = 'locked' WHERE email = 'locked@example.com'");
    assert.deepEqual((await parent.post('/api/auth/logout')).body, { ok: true });
    assert.equal((await parent.get('/api/me')).status, 401);
  });

  it('the background check locks trials that have ended, and only those', async () => {
    const ended = await signIn(server, 'bg-ended@example.com');
    const running = await signIn(server, 'bg-running@example.com');
    const paying = await signIn(server, 'bg-paying@example.com');
    await server.pool.query("UPDATE accounts SET trial_ends_at = now() - interval '1 hour' WHERE email IN ('bg-ended@example.com', 'bg-paying@example.com')");
    await server.pool.query("UPDATE accounts SET plan = 'active' WHERE email = 'bg-paying@example.com'");
    const changed = await lockExpiredTrials(server.pool);
    assert.ok(changed >= 1);
    const plans = await server.pool.query<{ email: string; plan: string }>("SELECT email, plan FROM accounts WHERE email LIKE 'bg-%' ORDER BY email");
    assert.deepEqual(plans.rows, [
      { email: 'bg-ended@example.com', plan: 'locked' },
      { email: 'bg-paying@example.com', plan: 'active' },
      { email: 'bg-running@example.com', plan: 'trial' },
    ]);
    assert.equal(await lockExpiredTrials(server.pool), 0);
    assert.equal((await ended.get('/api/dashboard')).status, 402);
    assert.equal((await running.get('/api/dashboard')).status, 200);
    assert.equal((await paying.get('/api/dashboard')).status, 200);
  });
});

describe('parent PIN on the device', () => {
  it('checks the PIN and locks out after 5 wrong tries for 5 minutes', async () => {
    const parent = await signIn(server, 'pin@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');

    // No PIN yet.
    const none = await device.post('/api/device/pin', { pin: '1234' });
    assert.equal(none.status, 403);
    assert.equal(typeof none.body.error, 'string');

    for (const pin of ['123', '123456789', 'abcd', '12 34', 1234, null]) {
      assert.equal((await parent.patch('/api/account', { pin })).status, pin === null ? 200 : 400, String(pin));
    }
    const set = await parent.patch('/api/account', { pin: '4821' });
    assert.equal(set.status, 200);
    assert.equal(set.body.account.hasPin, true);
    assert.equal((await parent.get('/api/me')).body.account.hasPin, true);
    assert.equal(JSON.stringify(set.body).includes('4821'), false);

    // Stored only as a scrypt hash.
    const stored = await server.pool.query<{ parent_pin_hash: string }>("SELECT parent_pin_hash FROM accounts WHERE email = 'pin@example.com'");
    assert.match(stored.rows[0]?.parent_pin_hash ?? '', /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(stored.rows[0]?.parent_pin_hash.includes('4821'), false);

    assert.deepEqual((await device.post('/api/device/pin', { pin: '4821' })).body, { ok: true });
    assert.equal((await device.post('/api/device/pin', {})).status, 400);
    assert.equal((await device.post('/api/device/pin', { pin: 'abcd' })).status, 400);

    // A right PIN clears earlier wrong tries.
    for (let i = 0; i < 4; i++) {
      const wrong = await device.post('/api/device/pin', { pin: '0000' });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.body.triesLeft, 4 - i - 0 - 1 + 1 - 1 + 1); // 4, 3, 2, 1
    }
    assert.equal((await device.post('/api/device/pin', { pin: '4821' })).status, 200);

    // Five wrong tries in a row.
    for (let i = 0; i < 5; i++) {
      const wrong = await device.post('/api/device/pin', { pin: '9999' });
      assert.equal(wrong.status, 403, `wrong try ${i + 1}`);
      assert.equal(typeof wrong.body.error, 'string');
    }
    // Now even the right PIN is refused.
    const lockedOut = await device.post('/api/device/pin', { pin: '4821' });
    assert.equal(lockedOut.status, 429);
    assert.equal(typeof lockedOut.body.error, 'string');
    assert.ok(lockedOut.body.retryAfterSeconds > 290 && lockedOut.body.retryAfterSeconds <= 300, String(lockedOut.body.retryAfterSeconds));
    assert.equal(lockedOut.headers.get('retry-after'), String(lockedOut.body.retryAfterSeconds));
    // The lock-out is for the family, so a second device does not give five more tries.
    const { device: phone } = await pairDevice(server, parent, kid, 'android', 'Phone');
    assert.equal((await phone.post('/api/device/pin', { pin: '4821' })).status, 429);

    // After 5 minutes it works again.
    await server.pool.query("UPDATE accounts SET pin_locked_until = now() - interval '1 second' WHERE email = 'pin@example.com'");
    assert.deepEqual((await device.post('/api/device/pin', { pin: '4821' })).body, { ok: true });
    assert.equal((await device.post('/api/device/pin', { pin: '9999' })).body.triesLeft, 4);

    // Removing the PIN.
    assert.equal((await parent.patch('/api/account', { pin: null })).body.account.hasPin, false);
    assert.equal((await device.post('/api/device/pin', { pin: '4821' })).status, 403);
  });

  it('a burst of parallel guesses gets no more than 5 tries', async () => {
    const parent = await signIn(server, 'pin-burst@example.com');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    await parent.patch('/api/account', { pin: '2468' });
    const guesses = ['1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '2468', '1212', '3434'];
    const results = await Promise.all(guesses.map((pin) => device.post('/api/device/pin', { pin })));
    const checked = results.filter((r) => r.status !== 429).length;
    assert.ok(checked <= 5, `${checked} guesses were checked`);
    assert.ok(results.filter((r) => r.status === 429).length >= guesses.length - 5);
  });

  it('one family\'s PIN does not open another family\'s device', async () => {
    const a = await signIn(server, 'pin-a@example.com');
    const b = await signIn(server, 'pin-b@example.com');
    await a.patch('/api/account', { pin: '1357' });
    await b.patch('/api/account', { pin: '8642' });
    const { device: deviceB } = await pairDevice(server, b, await createKid(b, 'Zoe'), 'android', 'Phone');
    assert.equal((await deviceB.post('/api/device/pin', { pin: '1357' })).status, 403);
    assert.equal((await deviceB.post('/api/device/pin', { pin: '8642' })).status, 200);
  });
});

describe('billing', () => {
  it('answers 503 with a clear message when Stripe is not set up', async () => {
    const parent = await signIn(server, 'billing-none@example.com');
    const billing = await parent.get('/api/billing');
    assert.equal(billing.status, 200);
    assert.equal(billing.body.plan, 'trial');
    assert.equal(billing.body.trialDaysLeft, 30);
    assert.ok(!Number.isNaN(new Date(billing.body.trialEndsAt).getTime()));
    assert.deepEqual(billing.body.prices, { month: 4, year: 36 });
    assert.equal(billing.body.stripeReady, false);

    const checkout = await parent.post('/api/billing/checkout', { interval: 'year' });
    assert.equal(checkout.status, 503);
    assert.match(checkout.body.error, /[Pp]ayments are not set up/);
    assert.equal((await parent.post('/api/billing/portal')).status, 503);
    assert.equal((await parent.post('/api/billing/checkout', { interval: 'week' })).status, 400);
    assert.equal((await new Client(server.url).get('/api/billing')).status, 401);

    const hook = await new Client(server.url).post('/stripe/webhook', { type: 'x' });
    assert.equal(hook.status, 503);
  });

  it('checkout, portal and webhooks against a stand-in for Stripe', async () => {
    // A stand-in for api.stripe.com: records every call and answers like Stripe does.
    const calls: Array<{ method: string; path: string; auth: string; params: URLSearchParams }> = [];
    const realFetch = globalThis.fetch;
    const fakeStripe = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== 'http://stripe.test') return realFetch(input, init);
      const headers = new Headers(init?.headers);
      const params = init?.method === 'POST' ? new URLSearchParams(String(init.body ?? '')) : url.searchParams;
      calls.push({ method: init?.method ?? 'GET', path: url.pathname, auth: headers.get('authorization') ?? '', params });
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/v1/prices') {
        const key = params.get('lookup_keys[]');
        if (key === 'fsw_family_month') return json({ data: [{ id: 'price_month' }] });
        if (key === 'fsw_family_year') return json({ data: [{ id: 'price_year' }] });
        return json({ data: [] });
      }
      if (url.pathname === '/v1/customers') return json({ id: 'cus_test_1' });
      if (url.pathname === '/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.stripe.test/pay/cs_1' });
      if (url.pathname === '/v1/billing_portal/sessions') return json({ id: 'bps_1', url: 'https://billing.stripe.test/session/bps_1' });
      return json({ error: { message: 'unknown' } }, 404);
    }) as typeof fetch;

    const secret = 'whsec_integration';
    const stripeServer = await startServer(
      { STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: secret, STRIPE_API_BASE: 'http://stripe.test', PUBLIC_URL: 'https://app.example.test' },
      { fetchImpl: fakeStripe },
    );
    try {
      const parent = await signIn(stripeServer, 'billing-stripe@example.com');
      const accountId = (await parent.get('/api/me')).body.account.id as string;
      assert.equal((await parent.get('/api/billing')).body.stripeReady, true);

      // No customer yet: nothing to manage.
      assert.equal((await parent.post('/api/billing/portal')).status, 400);

      const checkout = await parent.post('/api/billing/checkout', { interval: 'year' });
      assert.equal(checkout.status, 200);
      assert.deepEqual(checkout.body, { url: 'https://checkout.stripe.test/pay/cs_1' });
      assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/prices', 'POST /v1/customers', 'POST /v1/checkout/sessions']);
      assert.ok(calls.every((c) => c.auth === 'Bearer sk_test_123'));
      assert.equal(calls[0]?.params.get('lookup_keys[]'), 'fsw_family_year');
      assert.equal(calls[1]?.params.get('email'), 'billing-stripe@example.com');
      assert.equal(calls[1]?.params.get('metadata[account_id]'), accountId);
      const session = calls[2]?.params;
      assert.equal(session?.get('mode'), 'subscription');
      assert.equal(session?.get('customer'), 'cus_test_1');
      assert.equal(session?.get('line_items[0][price]'), 'price_year');
      assert.equal(session?.get('line_items[0][quantity]'), '1');
      assert.equal(session?.get('client_reference_id'), accountId);
      assert.equal(session?.get('subscription_data[metadata][account_id]'), accountId);
      assert.match(session?.get('success_url') ?? '', /^https:\/\/app\.example\.test\//);
      assert.match(session?.get('cancel_url') ?? '', /^https:\/\/app\.example\.test\//);

      // The second checkout reuses the customer and finds the monthly price.
      calls.length = 0;
      await parent.post('/api/billing/checkout', { interval: 'month' });
      assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/prices', 'POST /v1/checkout/sessions']);
      assert.equal(calls[1]?.params.get('line_items[0][price]'), 'price_month');

      calls.length = 0;
      const portal = await parent.post('/api/billing/portal');
      assert.deepEqual(portal.body, { url: 'https://billing.stripe.test/session/bps_1' });
      assert.equal(calls[0]?.params.get('customer'), 'cus_test_1');

      // --- webhooks
      const hook = async (event: unknown, header?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
        const payload = JSON.stringify(event);
        const res = await fetch(`${stripeServer.url}/stripe/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'stripe-signature': header ?? signStripePayload(payload, secret, Math.floor(Date.now() / 1000)) },
          body: payload,
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const plan = async (): Promise<string> => (await parent.get('/api/me')).body.account.plan as string;
      const subscription = (status: string, id = 'sub_1'): unknown => ({
        id: 'evt_x',
        data: { object: { id, object: 'subscription', customer: 'cus_test_1', status, metadata: { account_id: accountId } } },
      });

      // Bad signatures change nothing.
      const created = { ...(subscription('active') as object), type: 'customer.subscription.created' };
      const payload = JSON.stringify(created);
      const now = Math.floor(Date.now() / 1000);
      assert.equal((await hook(created, 't=1,v1=00')).status, 400);
      assert.equal((await hook(created, signStripePayload(payload, 'whsec_wrong', now))).status, 400);
      assert.equal((await hook(created, signStripePayload(payload, secret, now - 301))).status, 400); // too old (replay)
      assert.equal((await hook(created, signStripePayload(payload + ' ', secret, now))).status, 400); // body changed
      const noHeader = await fetch(`${stripeServer.url}/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
      assert.equal(noHeader.status, 400);
      assert.equal(await plan(), 'trial');

      // created → active
      assert.deepEqual(await hook(created), { status: 200, body: { received: true } });
      assert.equal(await plan(), 'active');
      const ids = await stripeServer.pool.query<{ stripe_customer_id: string; stripe_subscription_id: string }>(
        'SELECT stripe_customer_id, stripe_subscription_id FROM accounts WHERE id = $1',
        [accountId],
      );
      assert.deepEqual(ids.rows[0], { stripe_customer_id: 'cus_test_1', stripe_subscription_id: 'sub_1' });

      // An old, different subscription ending does not end the plan.
      await hook({ ...(subscription('canceled', 'sub_old') as object), type: 'customer.subscription.deleted' });
      assert.equal(await plan(), 'active');

      // updated: past_due keeps the plan; unpaid ends it. The trial is still running, so back to trial.
      await hook({ ...(subscription('past_due') as object), type: 'customer.subscription.updated' });
      assert.equal(await plan(), 'active');
      await hook({ ...(subscription('unpaid') as object), type: 'customer.subscription.updated' });
      assert.equal(await plan(), 'trial');

      // Subscribed again, then deleted after the trial has ended → locked.
      await hook({ ...(subscription('active', 'sub_2') as object), type: 'customer.subscription.updated' });
      assert.equal(await plan(), 'active');
      await stripeServer.pool.query("UPDATE accounts SET trial_ends_at = now() - interval '1 day' WHERE id = $1", [accountId]);
      assert.equal(await plan(), 'active'); // a paying family is never locked by the trial date
      assert.equal((await parent.get('/api/dashboard')).status, 200);
      await hook({ ...(subscription('canceled', 'sub_2') as object), type: 'customer.subscription.deleted' });
      assert.equal(await plan(), 'locked');
      assert.equal((await parent.get('/api/dashboard')).status, 402);

      // Paying again unlocks, found by customer id alone (no metadata).
      await hook({ id: 'evt_y', type: 'customer.subscription.created', data: { object: { id: 'sub_3', customer: 'cus_test_1', status: 'active', metadata: {} } } });
      assert.equal(await plan(), 'active');
      assert.equal((await parent.get('/api/dashboard')).status, 200);

      // Events for nobody we know, and event types we do not use, are accepted and ignored.
      assert.equal((await hook({ id: 'evt_z', type: 'customer.subscription.deleted', data: { object: { id: 'sub_9', customer: 'cus_unknown', status: 'canceled' } } })).status, 200);
      assert.equal((await hook({ id: 'evt_q', type: 'invoice.paid', data: { object: {} } })).status, 200);
      assert.equal(await plan(), 'active');

      // checkout.session.completed links customer and subscription for a fresh account.
      const fresh = await signIn(stripeServer, 'billing-fresh@example.com');
      const freshId = (await fresh.get('/api/me')).body.account.id as string;
      await hook({ id: 'evt_c', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: freshId, customer: 'cus_fresh', subscription: 'sub_fresh' } } });
      assert.equal((await fresh.get('/api/me')).body.account.plan, 'active');
    } finally {
      await stripeServer.close();
    }
  });

  it('a Stripe failure becomes a readable 502, not a crash', async () => {
    const failing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('http://stripe.test')) return new Response('{"error":{"message":"No such price"}}', { status: 400 });
      return fetch(input, init);
    }) as typeof fetch;
    const s = await startServer({ STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_API_BASE: 'http://stripe.test' }, { fetchImpl: failing });
    const original = console.error;
    console.error = () => undefined;
    try {
      const parent = await signIn(s, 'billing-fail@example.com');
      const res = await parent.post('/api/billing/checkout', { interval: 'month' });
      assert.equal(res.status, 502);
      assert.equal(typeof res.body.error, 'string');
      assert.equal(res.text.includes('sk_test_123'), false);
    } finally {
      console.error = original;
      await s.close();
    }
  });
});

describe('request hygiene', () => {
  it('rejects broken JSON and bodies that are too big', async () => {
    const parent = await signIn(server, 'hygiene@example.com');
    const broken = await parent.send('POST', '/api/kids', '{"name": ');
    assert.equal(broken.status, 400);
    assert.equal(typeof broken.body.error, 'string');
    const big = await parent.send('POST', '/api/kids', JSON.stringify({ name: 'x'.repeat(200 * 1024) }));
    assert.equal(big.status, 413);
    assert.equal(typeof big.body.error, 'string');
    const kid = await createKid(parent, 'Max');
    const { device } = await pairDevice(server, parent, kid, 'windows', 'PC');
    // Sync may carry a long installed list (bigger than the normal limit) but not an endless one.
    const installed = Array.from({ length: 2500 }, (_, i) => ({ kind: 'app', identifier: `program-number-${i}-with-a-long-name.exe`, name: `Program number ${i} with a long name` }));
    assert.ok(JSON.stringify({ installed }).length > 100 * 1024);
    assert.equal((await device.post('/api/device/sync', { installed })).status, 200);
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.apps.length, 2500);
    assert.equal((await device.send('POST', '/api/device/sync', JSON.stringify({ frontApp: 'x'.repeat(1100 * 1024) }))).status, 413);
    assert.equal((await device.post('/api/device/sync', { installed: Array.from({ length: 3001 }, (_, i) => ({ kind: 'app', identifier: `p${i}`, name: 'p' })) })).status, 400);
  });

  it('SQL in text fields is stored as text', async () => {
    const parent = await signIn(server, 'sql@example.com');
    const name = "Robert'); DROP TABLE kids;--";
    const id = await createKid(parent, name);
    assert.equal((await parent.get(`/api/kids/${id}`)).body.kid.name, name);
    assert.equal((await parent.get('/api/kids')).body.kids.length, 1);
  });

  it('API answers are never cached', async () => {
    const parent = await signIn(server, 'cache@example.com');
    assert.equal((await parent.get('/api/me')).headers.get('cache-control'), 'no-store');
  });

  it('unknown API paths answer JSON, signed in or not', async () => {
    const parent = await signIn(server, 'unknown@example.com');
    const res = await parent.get('/api/nothing-here');
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.error, 'string');
    assert.equal((await new Client(server.url).get('/api/nothing-here')).status, 401);
  });
});

describe('JSON shapes the web console is built against', () => {
  it('uses camelCase names of the database columns, in answers and in PATCH bodies', async () => {
    const parent = await signIn(server, 'shapes@example.com');
    const made = await parent.post('/api/kids', { name: 'Max' });
    const kid = made.body.kid.id as string;
    const kidKeys = ['bedOtherEnd', 'bedOtherStart', 'bedSchoolEnd', 'bedSchoolStart', 'bedtimeEnabled', 'blockPrivate', 'color', 'createdAt', 'id', 'limitSchoolMinutes', 'limitWeekendMinutes', 'locked', 'name', 'onlyAllowedSites', 'safeSearch', 'youtubeRestricted'];
    assert.deepEqual(Object.keys(made.body.kid).sort(), kidKeys);
    assert.ok(!Number.isNaN(new Date(made.body.kid.createdAt).getTime()));

    const { device, deviceId } = await pairDevice(server, parent, kid, 'android', 'Phone');
    await device.post('/api/device/sync', { frontApp: 'Chrome' });
    const app = await parent.post(`/api/kids/${kid}/apps`, { kind: 'app', platform: 'android', identifier: 'com.example.app', name: 'Example', allowed: true, free: false, limitMinutes: 30 });
    const contact = await parent.post(`/api/kids/${kid}/contacts`, { name: 'Mom', phone: '555 0100', canCall: true, canText: false });
    const request = await device.post('/api/device/request', { kind: 'time', minutes: 15 });

    // PATCH bodies use the same names.
    const patchedKid = await parent.patch(`/api/kids/${kid}`, { limitSchoolMinutes: 100, limitWeekendMinutes: 200, bedSchoolStart: '20:00', bedSchoolEnd: '06:30', bedOtherStart: '22:00', bedOtherEnd: '08:00', bedtimeEnabled: true, onlyAllowedSites: false, safeSearch: true, youtubeRestricted: false, blockPrivate: true });
    assert.equal(patchedKid.status, 200);
    assert.deepEqual(Object.keys(patchedKid.body.kid).sort(), kidKeys);
    assert.equal((await parent.patch(`/api/apps/${app.body.app.id}`, { limitMinutes: 45, allowed: false, free: true })).body.app.limitMinutes, 45);
    assert.equal((await parent.patch(`/api/contacts/${contact.body.contact.id}`, { canCall: false, canText: true })).body.contact.canText, true);

    const detail = await parent.get(`/api/kids/${kid}`);
    assert.deepEqual(Object.keys(detail.body).sort(), ['apps', 'contacts', 'kid', 'today']);
    assert.deepEqual(Object.keys(detail.body.kid).sort(), kidKeys);
    assert.equal(detail.body.kid.limitSchoolMinutes, 100);
    assert.equal(detail.body.kid.bedOtherEnd, '08:00');
    assert.deepEqual(Object.keys(detail.body.apps[0]).sort(), ['allowed', 'createdAt', 'free', 'id', 'identifier', 'kidId', 'kind', 'limitMinutes', 'name', 'platform', 'usedMinutes']);
    assert.deepEqual(Object.keys(detail.body.contacts[0]).sort(), ['canCall', 'canText', 'id', 'kidId', 'name', 'phone']);
    assert.deepEqual(Object.keys(detail.body.today).sort(), ['leftMinutes', 'limitMinutes', 'lockReason', 'locked', 'usedMinutes']);

    const kids = await parent.get('/api/kids');
    assert.deepEqual(Object.keys(kids.body), ['kids']);
    assert.deepEqual(Object.keys(kids.body.kids[0]).sort(), [...kidKeys, 'today'].sort());

    const devices = await parent.get('/api/devices');
    assert.deepEqual(Object.keys(devices.body), ['devices']);
    assert.equal(devices.body.devices[0].id, deviceId);
    assert.deepEqual(Object.keys(devices.body.devices[0]).sort(), ['appVersion', 'createdAt', 'frontApp', 'id', 'kidId', 'kidName', 'lastSeenAt', 'model', 'name', 'osVersion', 'platform', 'status']);

    const requests = await parent.get('/api/requests?status=pending');
    assert.deepEqual(Object.keys(requests.body), ['requests']);
    assert.equal(requests.body.requests[0].id, request.body.id);
    assert.deepEqual(Object.keys(requests.body.requests[0]).sort(), ['createdAt', 'decidedAt', 'detail', 'deviceId', 'deviceName', 'id', 'identifier', 'kidId', 'kidName', 'kind', 'minutes', 'status']);

    // bedtimeTonight is tonight's start as 'HH:MM', or null when bedtime is off.
    const dash = await parent.get('/api/dashboard');
    assert.deepEqual(Object.keys(dash.body.kids[0]).sort(), ['bedtimeTonight', 'color', 'id', 'leftMinutes', 'limitMinutes', 'lockReason', 'locked', 'name', 'statusText', 'usedMinutes']);
    assert.equal(dash.body.kids[0].bedtimeTonight, '20:00'); // Wednesday: a school night
    assert.equal(dash.body.kids[0].statusText, 'Using Chrome');
    assert.deepEqual(Object.keys(dash.body.devices[0]).sort(), Object.keys(devices.body.devices[0]).sort());
    assert.deepEqual(Object.keys(dash.body.requests[0]).sort(), Object.keys(requests.body.requests[0]).sort());
    try {
      server.setNow(new Date('2026-03-13T21:00:00Z')); // Friday afternoon: an "other" night
      assert.equal((await parent.get('/api/dashboard')).body.kids[0].bedtimeTonight, '22:00');
    } finally {
      server.setNow(WEDNESDAY_AFTERNOON);
    }
    await parent.patch(`/api/kids/${kid}`, { bedtimeEnabled: false });
    assert.equal((await parent.get('/api/dashboard')).body.kids[0].bedtimeTonight, null);
  });
});

describe('per-address rate limits', () => {
  it('limit sign-in links, pairing tries and API calls from one address', async () => {
    const strict = await startServer({}, { ipLimits: { links: 3, verify: 2, pair: 2, api: 40 } });
    try {
      const client = new Client(strict.url);
      const links: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await client.post('/api/auth/request-link', { email: `limit-${i}@example.com` });
        assert.equal(res.status, 200);
        links.push(res.body.devLink as string);
      }
      const tooMany = await client.post('/api/auth/request-link', { email: 'limit-9@example.com' });
      assert.equal(tooMany.status, 429);
      assert.equal(typeof tooMany.body.error, 'string');

      // Opening links: the third try from one address is turned away, even with a good token.
      for (const link of links.slice(0, 2)) {
        const u = new URL(link);
        assert.equal((await new Client(strict.url).get(u.pathname + u.search)).headers.get('location'), '/');
      }
      const third = new URL(links[2] ?? '');
      assert.equal((await new Client(strict.url).get(third.pathname + third.search)).headers.get('location'), '/signin?error=expired');

      // Guessing pairing codes.
      for (let i = 0; i < 2; i++) {
        assert.equal((await client.post('/api/device/pair', { code: 'ZZZZZZZZ', name: 'PC', platform: 'windows' })).status, 404);
      }
      assert.equal((await client.post('/api/device/pair', { code: 'ZZZZZZZZ', name: 'PC', platform: 'windows' })).status, 429);

      // Everything under /api.
      let limited = 0;
      for (let i = 0; i < 45; i++) if ((await client.get('/api/me')).status === 429) limited++;
      assert.ok(limited >= 5, `${limited} calls were limited`);
      // The health check is not under the limit.
      assert.equal((await client.get('/healthz')).status, 200);
    } finally {
      await strict.close();
    }
  });
});

describe('production settings', () => {
  it('marks the cookie Secure, sends HSTS and refuses changes from other origins', async () => {
    const prod = await startServer({ NODE_ENV: 'production', SESSION_SECRET: 'a-long-test-secret-for-production-mode', PUBLIC_URL: 'https://app.example.test' });
    try {
      const client = new Client(prod.url);
      const asked = await client.post('/api/auth/request-link', { email: 'prod@example.com' });
      const link = new URL(asked.body.devLink);
      assert.equal(link.origin, 'https://app.example.test');
      const verified = await client.get(link.pathname + link.search);
      assert.match(verified.headers.get('set-cookie') ?? '', /; Secure$/);
      assert.match(verified.headers.get('strict-transport-security') ?? '', /max-age=\d+/);
      assert.equal((await client.get('/api/me')).status, 200);

      const foreign = await client.send('POST', '/api/kids', { name: 'Max' }, { origin: 'https://evil.example' });
      assert.equal(foreign.status, 403);
      const own = await client.send('POST', '/api/kids', { name: 'Max' }, { origin: 'https://app.example.test' });
      assert.equal(own.status, 201);
      assert.equal((await client.get('/api/kids')).body.kids.length, 1);

      // The session hash is keyed with the server secret: the same cookie is useless to a server with another secret.
      const other = await startServer({ NODE_ENV: 'production', SESSION_SECRET: 'a-different-secret-for-the-test-run', PUBLIC_URL: 'https://app.example.test' });
      try {
        const stolen = new Client(other.url);
        stolen.cookie = client.cookie;
        assert.equal((await stolen.get('/api/me')).status, 401);
      } finally {
        await other.close();
      }
    } finally {
      await prod.close();
    }
  });
});

describe('serving the web app', () => {
  it('serves web/dist and falls back to index.html for non-API paths', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-dist-'));
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Family Screen Warden</title><div id="root"></div>');
    fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log("app")');
    const web = await startServer({ WEB_DIST: dist });
    try {
      const client = new Client(web.url);
      for (const p of ['/', '/signin', '/kids/123', '/billing?checkout=success']) {
        const page = await client.get(p);
        assert.equal(page.status, 200, p);
        assert.match(page.headers.get('content-type') ?? '', /text\/html/, p);
        assert.match(page.text, /<div id="root">/, p);
      }
      const asset = await client.get('/assets/app-abc123.js');
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('content-type') ?? '', /javascript/);
      assert.match(asset.headers.get('cache-control') ?? '', /immutable/);

      // API paths never get the HTML page.
      const api = await client.get('/api/me');
      assert.equal(api.status, 401);
      assert.match(api.headers.get('content-type') ?? '', /application\/json/);
      assert.equal((await client.get('/healthz')).body.status, 'ok');
      assert.equal((await client.post('/some/page', {})).status, 404);
      // No way out of the folder.
      const escape = await fetch(`${web.url}/..%2f..%2f..%2fetc%2fpasswd`);
      assert.equal((await escape.text()).includes('root:'), false);
    } finally {
      await web.close();
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });

  it('without a built web app, pages answer 404 JSON', async () => {
    const none = await startServer({ WEB_DIST: path.join(os.tmpdir(), 'fsw-no-such-folder') });
    try {
      const res = await new Client(none.url).get('/');
      assert.equal(res.status, 404);
      assert.equal(typeof res.body.error, 'string');
    } finally {
      await none.close();
    }
  });
});

describe('seed', () => {
  it('builds the demo family and is safe to run twice', async () => {
    await seed(TEST_DATABASE_URL);
    await seed(TEST_DATABASE_URL);
    const count = async (sql: string): Promise<number> => (await server.pool.query<{ n: number }>(sql, [DEMO_EMAIL])).rows[0]?.n ?? -1;
    assert.equal(await count('SELECT count(*)::int AS n FROM accounts WHERE email = $1'), 1);
    assert.equal(await count('SELECT count(*)::int AS n FROM kids k JOIN accounts a ON a.id = k.account_id WHERE a.email = $1'), 2);
    assert.equal(await count('SELECT count(*)::int AS n FROM devices d JOIN accounts a ON a.id = d.account_id WHERE a.email = $1'), 3);
    assert.equal(await count("SELECT count(*)::int AS n FROM requests r JOIN accounts a ON a.id = r.account_id WHERE a.email = $1 AND r.status = 'pending'"), 2);
    assert.equal(await count('SELECT count(*)::int AS n FROM contacts c JOIN accounts a ON a.id = c.account_id WHERE a.email = $1'), 6);
    assert.ok((await count('SELECT count(*)::int AS n FROM blocked_events b JOIN accounts a ON a.id = b.account_id WHERE a.email = $1')) >= 3);

    // The dashboard has data. (The seed uses the real date, so this server uses the real clock.)
    const real = await startServer();
    real.setNow(new Date());
    try {
      const realParent = await signIn(real, DEMO_EMAIL);
      const dash = (await realParent.get('/api/dashboard')).body;
      assert.deepEqual(dash.kids.map((k: { name: string }) => k.name), ['Max', 'Ava']);
      assert.deepEqual(dash.devices.map((d: { name: string }) => d.name), ["Max's PC", "Ava's phone", 'Family laptop']);
      assert.deepEqual(dash.devices.map((d: { platform: string }) => d.platform), ['windows', 'android', 'windows']);
      assert.equal(dash.devices[2].status, 'off');
      assert.equal(dash.requests.length, 2);
      assert.equal(dash.requests[0].kidName, 'Max');
      assert.equal(dash.requests[1].detail, 'Duolingo');
      assert.equal(dash.appLimits.length, 3);
      assert.ok(dash.blocked.reduce((n: number, b: { count: number }) => n + b.count, 0) >= 3);
      assert.equal(dash.week.length, 7);
    } finally {
      await real.close();
    }
  });
});
