/**
 * The live map against the real server and a real Postgres. This is the location of children, so every privacy rule
 * has a test here: who can read, who can write, what is kept when sharing is off, how long things are kept, and
 * what deleting removes. The last suite covers the map tiles (against a stand-in tile provider on this machine).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config';
import { CHECKIN_KEEP_DAYS, MAX_POINTS_PER_KID, purgeExpired } from '../src/state';
import { TileStore, tileUserAgent } from '../src/tiles';
import {
  Client, createKid, fakeTile, pairDevice, resetDatabase, signIn, startServer, startTileSource, TEST_DATABASE_URL, type Json, type TestServer, type TileSource,
} from './helpers';

const NOBODY = '00000000-0000-4000-8000-000000000000';
let server: TestServer;
let source: TileSource;

before(async () => {
  await resetDatabase();
  source = await startTileSource();
  server = await startServer({ MAP_TILE_URL: source.template, MAP_TILE_ATTRIBUTION: '© Example Maps', MAP_TILE_ATTRIBUTION_URL: 'https://maps.example/credit' });
});

after(async () => {
  await server.close();
  await source.close();
});

interface Family {
  parent: Client;
  kid: string;
  phone: Client;
  deviceId: string;
  accountId: string;
}

async function family(email: string, kidName = 'Mia'): Promise<Family> {
  const parent = await signIn(server, email);
  const kid = await createKid(parent, kidName);
  const { device, deviceId } = await pairDevice(server, parent, kid, 'android', `${kidName}'s phone`);
  const accountId = (await parent.get('/api/me')).body.account.id as string;
  return { parent, kid, phone: device, deviceId, accountId };
}

const mapOf = async (parent: Client, query = ''): Promise<Json> => {
  const r = await parent.get(`/api/location${query}`);
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const kidOn = (map: Json, kid: string): Json => map.kids.find((k: Json) => k.id === kid);
const count = async (table: string, kid: string): Promise<number> =>
  (await server.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE kid_id = $1`, [kid])).rows[0].n;
const HOME = { lat: 39.75, lng: -104.98, accuracy: 15 };

describe('who can read where a kid is', () => {
  let a: Family;
  let b: Family;
  let place: string;
  let checkin: string;
  before(async () => {
    a = await family('map-a@example.com');
    b = await family('map-b@example.com', 'Sam');
    await a.phone.post('/api/android/location', { ...HOME, battery: 70 });
    place = (await a.parent.post('/api/places', { name: 'Home', ...HOME, radius: 100 })).body.place.id;
    checkin = (await a.phone.post('/api/android/checkin', { kind: 'pickup', lat: HOME.lat, lng: HOME.lng })).body.id;
  });

  it('the family itself sees the kid, the place and the check-in', async () => {
    const map = await mapOf(a.parent);
    assert.deepEqual(map.kids.map((k: Json) => k.id), [a.kid]);
    assert.equal(kidOn(map, a.kid).last.lat, HOME.lat);
    assert.deepEqual(map.places.map((p: Json) => p.id), [place]);
    assert.deepEqual(map.checkins.map((c: Json) => c.id), [checkin]);
  });

  it('another family sees none of it, and gets "not found" for every id of this family', async () => {
    const map = await mapOf(b.parent, '?live=1');
    assert.deepEqual(map.kids.map((k: Json) => k.id), [b.kid]);
    assert.equal(kidOn(map, b.kid).last, null);
    assert.deepEqual(map.places, []);
    assert.deepEqual(map.checkins, []);
    assert.doesNotMatch(JSON.stringify(map), /39\.75/);
    const calls: Array<[string, string, Json | undefined]> = [
      ['GET', `/api/kids/${a.kid}/location/trail`, undefined],
      ['PUT', `/api/kids/${a.kid}/location/settings`, { sharing: false }],
      ['DELETE', `/api/kids/${a.kid}/location`, undefined],
      ['POST', `/api/kids/${a.kid}/ring`, {}],
      ['PUT', `/api/places/${place}`, { name: 'Mine now', lat: 1, lng: 1, radius: 100 }],
      ['DELETE', `/api/places/${place}`, undefined],
      ['POST', `/api/checkins/${checkin}/answer`, { text: 'On my way' }],
    ];
    for (const [method, url, body] of calls) {
      assert.equal((await b.parent.send(method, url, body)).status, 404, `${method} ${url} from another family`);
      assert.equal((await b.parent.send(method, url.replace(/[0-9a-f-]{36}/, NOBODY), body)).status, 404, `${method} ${url} for nobody`);
    }
    // Nothing of family A changed, and its phone was not made "live" or rung by family B.
    const mine = await mapOf(a.parent);
    assert.equal(kidOn(mine, a.kid).sharing, true);
    assert.equal(kidOn(mine, a.kid).trail.length, 2);
    assert.equal(mine.places[0].name, 'Home');
    assert.equal(mine.checkins[0].answer, null);
    assert.equal((await a.phone.post('/api/warden/sync', {})).body.location.ring, null);
  });

  it('nothing is public: every route needs a signed-in parent, and a phone\'s token opens none of them', async () => {
    const calls: Array<[string, string, Json | undefined]> = [
      ['GET', '/api/location', undefined],
      ['GET', `/api/kids/${a.kid}/location/trail`, undefined],
      ['PUT', `/api/kids/${a.kid}/location/settings`, { sharing: false }],
      ['DELETE', `/api/kids/${a.kid}/location`, undefined],
      ['POST', `/api/kids/${a.kid}/ring`, {}],
      ['GET', '/api/places', undefined],
      ['POST', '/api/places', { name: 'X', lat: 1, lng: 1 }],
      ['PUT', `/api/places/${place}`, { name: 'X', lat: 1, lng: 1 }],
      ['DELETE', `/api/places/${place}`, undefined],
      ['POST', `/api/checkins/${checkin}/answer`, { text: 'x' }],
      ['GET', '/api/map-tiles/1/0/0.png', undefined],
    ];
    for (const [method, url, body] of calls) {
      assert.equal((await new Client(server.url).send(method, url, body)).status, 401, `${method} ${url} signed out`);
      // Even the kid's own phone cannot read the map: a device token is not a parent.
      assert.equal((await a.phone.send(method, url, body)).status, 401, `${method} ${url} with a phone's token`);
    }
  });

  it('a family whose trial ended cannot open the map (like every other parent page)', async () => {
    const f = await family('map-locked@example.com');
    await f.phone.post('/api/android/location', HOME);
    await server.pool.query("UPDATE accounts SET plan = 'locked' WHERE id = $1", [f.accountId]);
    assert.equal((await f.parent.get('/api/location')).status, 402);
    assert.equal((await f.parent.get('/api/map-tiles/1/0/0.png')).status, 402);
  });

  it('the notice email says who and what, never where in numbers, and only goes to the family\'s own address', async () => {
    await new Promise((r) => setTimeout(r, 50));
    const mine = server.notices.filter((n) => /Mia/.test(n.subject));
    assert.ok(mine.length >= 1);
    for (const n of mine) {
      assert.equal(n.email, 'map-a@example.com');
      assert.doesNotMatch(n.subject + n.text, /39\.75|104\.98/);
    }
  });
});

describe('who can write where a kid is', () => {
  it('a phone writes for its own kid only: naming a sibling or another family\'s kid in the body changes nothing', async () => {
    const f = await family('write-a@example.com');
    const sister = await createKid(f.parent, 'Ada');
    await pairDevice(server, f.parent, sister, 'android', "Ada's phone");
    const other = await family('write-b@example.com', 'Sam');
    for (const target of [sister, other.kid]) {
      const sent = await f.phone.post('/api/android/location', { ...HOME, kidId: target, memberId: target, kid_id: target, fixes: [{ ...HOME, kidId: target, memberId: target }] });
      assert.equal(sent.status, 200, sent.text);
      await f.phone.post('/api/android/checkin', { kind: 'ok', kidId: target, memberId: target, lat: 1, lng: 1 });
    }
    assert.equal(await count('kid_locations', sister), 0);
    assert.equal(await count('kid_locations', other.kid), 0);
    assert.equal(await count('kid_checkins', sister), 0);
    assert.equal(await count('kid_checkins', other.kid), 0);
    assert.ok((await count('kid_locations', f.kid)) >= 2);
    const map = await mapOf(f.parent);
    assert.equal(kidOn(map, sister).last, null);
    assert.equal(kidOn(await mapOf(other.parent), other.kid).last, null);
    // Every stored point carries the phone's own family and device.
    const rows = await server.pool.query('SELECT DISTINCT account_id, device_id FROM kid_locations WHERE kid_id = $1', [f.kid]);
    assert.deepEqual(rows.rows, [{ account_id: f.accountId, device_id: f.deviceId }]);
  });

  it('no token, a wrong token or a parent\'s cookie cannot post a position or a check-in', async () => {
    const f = await family('write-c@example.com');
    const stranger = new Client(server.url);
    assert.equal((await stranger.post('/api/android/location', HOME)).status, 401);
    assert.equal((await stranger.post('/api/android/checkin', { kind: 'help' })).status, 401);
    stranger.bearer = 'x'.repeat(43);
    assert.equal((await stranger.post('/api/android/location', HOME)).status, 401);
    assert.equal((await f.parent.post('/api/android/location', HOME)).status, 401);
    assert.equal(await count('kid_locations', f.kid), 0);
  });

  it('a removed phone can no longer write, and a PC has no location routes', async () => {
    const f = await family('write-d@example.com');
    const pc = (await pairDevice(server, f.parent, f.kid, 'windows', 'PC')).device;
    assert.equal((await pc.post('/api/android/location', HOME)).status, 404);
    assert.equal((await pc.post('/api/android/checkin', { kind: 'ok' })).status, 404);
    assert.equal((await pc.post('/api/warden/sync', {})).body.location, undefined);
    await f.parent.del(`/api/devices/${f.deviceId}`);
    assert.equal((await f.phone.post('/api/android/location', HOME)).status, 401);
    assert.equal(await count('kid_locations', f.kid), 0);
  });

  it('positions are checked, and a phone that sends far too often is slowed down', async () => {
    const f = await family('write-e@example.com');
    for (const bad of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: '39', lng: 0 }, { lng: 5 }, { fixes: [] }, { fixes: [HOME, { lat: 'x' }] }, { fixes: 'all' }]) {
      assert.equal((await f.phone.post('/api/android/location', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await f.phone.post('/api/android/location', { fixes: Array.from({ length: 31 }, () => HOME) })).status, 400);
    assert.equal(await count('kid_locations', f.kid), 0);
    // A fix time far from now is not believed (a phone cannot write history).
    await f.phone.post('/api/android/location', { ...HOME, at: '2020-01-01T00:00:00Z' });
    const at = (await server.pool.query('SELECT at FROM kid_locations WHERE kid_id = $1', [f.kid])).rows[0].at as Date;
    assert.ok(Math.abs(at.getTime() - Date.now()) < 60_000);
    let last = 200;
    for (let i = 0; i < 125 && last === 200; i++) last = (await f.phone.post('/api/android/location', HOME)).status;
    assert.equal(last, 429);
  });
});

describe('sharing switched off by a parent', () => {
  it('the phone is told in its sync, and nothing it still sends is kept: no position, no place, no "live"', async () => {
    const f = await family('off-a@example.com');
    await f.parent.post('/api/places', { name: 'Home', ...HOME, radius: 100 });
    assert.deepEqual((await f.phone.post('/api/warden/sync', {})).body.location, { sharing: true, live: false, ring: null });
    const off = await f.parent.send('PUT', `/api/kids/${f.kid}/location/settings`, { sharing: false });
    assert.deepEqual(off.body, { ok: true, sharing: false, alerts: true, keepDays: 30 });
    assert.equal((await f.phone.post('/api/warden/sync', {})).body.location.sharing, false);
    const sent = await f.phone.post('/api/android/location', { fixes: [HOME, HOME] });
    assert.equal(sent.status, 200, 'a plain answer, so the phone does not try again and again');
    assert.deepEqual(sent.body, { sharing: false, live: false });
    // A check-in still reaches the parents (the kid asked for help), but without a position.
    const help = await f.phone.post('/api/android/checkin', { kind: 'help', lat: HOME.lat, lng: HOME.lng, accuracy: 10 });
    assert.equal(help.status, 200);
    const map = await mapOf(f.parent, '?live=1');
    const me = kidOn(map, f.kid);
    assert.deepEqual([me.sharing, me.live, me.last, me.trail, me.events], [false, false, null, [], []]);
    assert.deepEqual(map.checkins.map((c: Json) => [c.kind, c.lat, c.lng]), [['help', null, null]]);
    assert.equal(await count('kid_locations', f.kid), 0);
    assert.equal(await count('kid_place_events', f.kid), 0);
    assert.equal((await f.phone.post('/api/warden/sync', {})).body.location.live, false);
    const row = await server.pool.query('SELECT lat, lng, accuracy FROM kid_checkins WHERE kid_id = $1', [f.kid]);
    assert.deepEqual(row.rows, [{ lat: null, lng: null, accuracy: null }]);
  });

  it('one kid\'s switch does not touch a sibling, and switching back on starts fresh', async () => {
    const f = await family('off-b@example.com');
    const sister = await createKid(f.parent, 'Ada');
    const hers = (await pairDevice(server, f.parent, sister, 'android', "Ada's phone")).device;
    await f.parent.send('PUT', `/api/kids/${f.kid}/location/settings`, { sharing: false });
    assert.equal((await hers.post('/api/android/location', HOME)).body.sharing, true);
    assert.equal((await hers.post('/api/warden/sync', {})).body.location.sharing, true);
    assert.equal(await count('kid_locations', sister), 1);
    await f.parent.send('PUT', `/api/kids/${f.kid}/location/settings`, { sharing: true });
    assert.equal((await f.phone.post('/api/android/location', HOME)).body.sharing, true);
    assert.equal(await count('kid_locations', f.kid), 1);
    for (const bad of [{}, { keepDays: 7 }, { sharing: 'no' }]) {
      assert.equal((await f.parent.send('PUT', `/api/kids/${f.kid}/location/settings`, bad)).status, 400);
    }
  });

  it('"live" lasts only while the map is open, and a pickup or help check-in ends being live once answered', async () => {
    const f = await family('off-c@example.com');
    await mapOf(f.parent, '?live=1');
    let until = (await server.pool.query('SELECT live_until FROM kid_location_settings WHERE kid_id = $1', [f.kid])).rows[0].live_until as Date;
    assert.ok(until.getTime() - Date.now() <= 2 * 60_000 + 1000 && until.getTime() > Date.now());
    const help = await f.phone.post('/api/android/checkin', { kind: 'help', lat: HOME.lat, lng: HOME.lng });
    until = (await server.pool.query('SELECT live_until FROM kid_location_settings WHERE kid_id = $1', [f.kid])).rows[0].live_until as Date;
    assert.ok(until.getTime() - Date.now() > 25 * 60_000);
    await f.parent.post(`/api/checkins/${help.body.id}/answer`, { text: 'On my way' });
    until = (await server.pool.query('SELECT live_until FROM kid_location_settings WHERE kid_id = $1', [f.kid])).rows[0].live_until as Date;
    assert.ok(until.getTime() - Date.now() <= 2 * 60_000 + 1000);
    assert.equal((await f.parent.post(`/api/checkins/${help.body.id}/answer`, { text: '' })).status, 400);
  });
});

describe('how long things are kept, and what deleting removes', () => {
  const addOld = async (f: Family, days: number): Promise<void> => {
    await server.pool.query(
      `INSERT INTO kid_locations (account_id, kid_id, device_id, lat, lng, at) VALUES ($1, $2, $3, 1, 1, now() - make_interval(days => $4))`,
      [f.accountId, f.kid, f.deviceId, days],
    );
    await server.pool.query(
      `INSERT INTO kid_place_events (account_id, kid_id, place_name, kind, at) VALUES ($1, $2, 'School', 'arrive', now() - make_interval(days => $3))`,
      [f.accountId, f.kid, days],
    );
  };
  const ages = async (kid: string): Promise<number[]> =>
    (await server.pool.query("SELECT round(extract(epoch FROM now() - at) / 86400)::int AS d FROM kid_locations WHERE kid_id = $1 ORDER BY at DESC", [kid])).rows.map((r) => r.d);

  it('housekeeping removes positions and arrive / leave after 30 days unless the parent chose 1 or 90', async () => {
    const usual = await family('keep-a@example.com');
    const long = await family('keep-b@example.com');
    const short = await family('keep-c@example.com');
    await long.parent.send('PUT', `/api/kids/${long.kid}/location/settings`, { keepDays: 90 });
    for (const f of [usual, long, short]) for (const days of [0, 2, 29, 31, 89, 91]) await addOld(f, days);
    // A shorter keep time counts at once, before any housekeeping.
    await short.parent.send('PUT', `/api/kids/${short.kid}/location/settings`, { keepDays: 1 });
    assert.deepEqual(await ages(short.kid), [0]);
    assert.equal(await count('kid_place_events', short.kid), 1);
    await purgeExpired(server.pool);
    assert.deepEqual(await ages(usual.kid), [0, 2, 29]);
    assert.deepEqual(await ages(long.kid), [0, 2, 29, 31, 89]);
    assert.deepEqual(await ages(short.kid), [0]);
    assert.equal(await count('kid_place_events', usual.kid), 3);
    assert.equal(await count('kid_place_events', long.kid), 5);
  });

  it('check-ins go after 90 days, and one kid never has more than the cap of positions', async () => {
    const f = await family('keep-d@example.com');
    assert.equal(CHECKIN_KEEP_DAYS, 90);
    await server.pool.query(
      `INSERT INTO kid_checkins (account_id, kid_id, kind, lat, lng, at) VALUES ($1, $2, 'ok', 1, 1, now() - interval '89 days'), ($1, $2, 'help', 1, 1, now() - interval '91 days')`,
      [f.accountId, f.kid],
    );
    await server.pool.query(
      `INSERT INTO kid_locations (account_id, kid_id, device_id, lat, lng, at)
       SELECT $1, $2, $3, 1, 1, now() - make_interval(secs => g) FROM generate_series(1, $4::int) g`,
      [f.accountId, f.kid, f.deviceId, MAX_POINTS_PER_KID + 25],
    );
    await purgeExpired(server.pool);
    assert.deepEqual((await server.pool.query('SELECT kind FROM kid_checkins WHERE kid_id = $1', [f.kid])).rows, [{ kind: 'ok' }]);
    assert.equal(await count('kid_locations', f.kid), MAX_POINTS_PER_KID);
    // The newest ones are the ones that stay.
    const newest = (await server.pool.query('SELECT extract(epoch FROM now() - max(at))::int AS s FROM kid_locations WHERE kid_id = $1', [f.kid])).rows[0].s;
    assert.ok(newest < 60);
  });

  it('a parent clears one kid\'s location history: positions, arrive / leave and check-ins are gone, a sibling\'s stay', async () => {
    const f = await family('clear-a@example.com');
    const sister = await createKid(f.parent, 'Ada');
    const hers = (await pairDevice(server, f.parent, sister, 'android', "Ada's phone")).device;
    await f.parent.post('/api/places', { name: 'Home', ...HOME, radius: 100 });
    for (const phone of [f.phone, hers]) {
      await phone.post('/api/android/location', HOME);
      await phone.post('/api/android/checkin', { kind: 'ok', lat: HOME.lat, lng: HOME.lng });
    }
    const cleared = await f.parent.del(`/api/kids/${f.kid}/location`);
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.body.removed, 2);
    for (const table of ['kid_locations', 'kid_place_events', 'kid_place_state', 'kid_checkins']) {
      assert.equal(await count(table, f.kid), 0, table);
      assert.ok((await count(table, sister)) > 0, `${table} of the sibling`);
    }
    const map = await mapOf(f.parent);
    assert.equal(kidOn(map, f.kid).last, null);
    assert.equal(kidOn(map, sister).last.lat, HOME.lat);
    assert.deepEqual(map.checkins.map((c: Json) => c.kidId), [sister]);
    assert.equal((await f.parent.get(`/api/kids/${f.kid}/location/trail`)).body.trail.length, 0);
  });

  it('removing a kid, a phone or the whole family removes what was kept about where they were', async () => {
    const tables = ['kid_locations', 'kid_place_events', 'kid_place_state', 'kid_checkins', 'kid_location_settings'];
    const fill = async (f: Family): Promise<void> => {
      await f.parent.post('/api/places', { name: 'Home', ...HOME, radius: 100 });
      await f.phone.post('/api/android/location', HOME);
      await f.phone.post('/api/android/checkin', { kind: 'pickup', lat: HOME.lat, lng: HOME.lng });
      for (const t of tables) assert.ok((await count(t, f.kid)) > 0, t);
    };
    // The kid.
    const one = await family('gone-a@example.com');
    await fill(one);
    assert.equal((await one.parent.del(`/api/kids/${one.kid}`)).status, 200);
    for (const t of tables) assert.equal(await count(t, one.kid), 0, t);
    // The phone: its positions go with it (the check-in the parents were sent stays until it is 90 days old).
    const two = await family('gone-b@example.com');
    await fill(two);
    assert.equal((await two.parent.del(`/api/devices/${two.deviceId}`)).status, 200);
    assert.equal(await count('kid_locations', two.kid), 0);
    assert.deepEqual((await mapOf(two.parent)).kids, [], 'no phone, so the kid is not on the map');
    // The family (removed in the database; there is no route for it yet).
    const three = await family('gone-c@example.com');
    await fill(three);
    await server.pool.query('DELETE FROM accounts WHERE id = $1', [three.accountId]);
    for (const t of tables) assert.equal(await count(t, three.kid), 0, t);
    assert.equal((await server.pool.query('SELECT count(*)::int AS n FROM family_places WHERE account_id = $1', [three.accountId])).rows[0].n, 0);
  });

  it('places: at most 50 per family, sizes and positions are checked', async () => {
    const f = await family('places-a@example.com');
    for (const bad of [{ name: '', ...HOME }, { name: 'X', lat: 95, lng: 0 }, { name: 'X', lat: 1 }, { name: 'X', ...HOME, radius: 10 }, { name: 'X', ...HOME, radius: 5000 }]) {
      assert.equal((await f.parent.post('/api/places', bad)).status, 400, JSON.stringify(bad));
    }
    const made = await f.parent.post('/api/places', { name: 'Park', lat: 1.5, lng: 2.5 });
    assert.deepEqual(made.body.place, { id: made.body.place.id, name: 'Park', lat: 1.5, lng: 2.5, radius: 150 });
    const changed = await f.parent.send('PUT', `/api/places/${made.body.place.id}`, { name: 'Big park', lat: 1.5, lng: 2.5, radius: 400 });
    assert.equal(changed.body.place.radius, 400);
    assert.deepEqual((await f.parent.get('/api/places')).body.places.map((p: Json) => p.name), ['Big park']);
    await server.pool.query("INSERT INTO family_places (account_id, name, lat, lng) SELECT $1, 'P' || g, 1, 1 FROM generate_series(1, 49) g", [f.accountId]);
    assert.equal((await f.parent.post('/api/places', { name: 'One too many', ...HOME })).status, 400);
  });

  it('a trail is asked for by day in the family\'s time zone; a wrong day is refused', async () => {
    const f = await family('trail-a@example.com');
    await f.phone.post('/api/android/location', HOME);
    await f.phone.post('/api/android/location', { ...HOME, accuracy: 900 });
    const today = await f.parent.get(`/api/kids/${f.kid}/location/trail`);
    assert.equal(today.body.trail.length, 1, 'a fix that is off by 900 m is kept but not drawn');
    assert.match(today.body.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await f.parent.get(`/api/kids/${f.kid}/location/trail?day=2020-01-01`)).body.trail.length, 0);
    assert.equal((await f.parent.get(`/api/kids/${f.kid}/location/trail?day=today`)).status, 400);
    assert.equal((await f.parent.get(`/api/kids/${f.kid}/location/trail?day=2026-13-45`)).status, 400);
  });

  it('Ring phone: a few times a minute at most', async () => {
    const f = await family('ring-a@example.com');
    let last = 200;
    for (let i = 0; i < 7; i++) last = (await f.parent.post(`/api/kids/${f.kid}/ring`)).status;
    assert.equal(last, 429);
  });
});

describe('map tiles', () => {
  let f: Family;
  const tile = async (client: Client, p: string): Promise<{ status: number; body: Buffer; headers: Headers }> => {
    const res = await fetch(`${server.url}/api/map-tiles/${p}`, { headers: client.cookie ? { cookie: client.cookie } : {} });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
  before(async () => {
    f = await family('tiles-a@example.com');
  });

  it('a signed-in parent gets the tile the server fetched from the configured source, with a User-Agent that says who asks', async () => {
    source.hits.length = 0;
    const got = await tile(f.parent, '12/853/1554.png');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, fakeTile('/t/12/853/1554.png?key=test'));
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal(got.headers.get('cache-control'), 'private, max-age=604800');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(source.hits.map((h) => h.path), ['/t/12/853/1554.png?key=test']);
    const ua = source.hits[0]?.userAgent ?? '';
    assert.equal(ua, tileUserAgent(server.config));
    assert.match(ua, /^FamilyScreenWarden\/[\d.]+ \(.*familyscreenwarden\.com.*http:\/\/console\.test\)$/);
  });

  it('a tile is kept on disk under DATA_DIR and not fetched twice', async () => {
    source.hits.length = 0;
    await tile(f.parent, '12/853/1555.png');
    await tile(f.parent, '12/853/1555.png');
    await tile(f.parent, '12/853/1555.png');
    assert.equal(source.hits.length, 1);
    const file = path.join(server.config.dataDir, 'map-tiles', '12', '853', '1555');
    assert.deepEqual(fs.readFileSync(file), fakeTile('/t/12/853/1555.png?key=test'));
  });

  it('the map answer carries the credit the tile source asks for', async () => {
    const map = await mapOf(f.parent);
    assert.deepEqual(map.tiles, { enabled: true, attribution: '© Example Maps', attributionUrl: 'https://maps.example/credit', maxZoom: 19 });
  });

  it('only tiles that exist are asked for: nothing a browser sends reaches the source or the disk as text', async () => {
    source.hits.length = 0;
    for (const p of ['2/9/1.png', '20/1/1.png', '1/0/0.jpg', '1/0/..%2F..%2Fsecret.png', 'x/0/0.png', '1/-1/0.png', '1/0/0', '3/1.5/2.png', '99999999999/0/0.png']) {
      assert.equal((await tile(f.parent, p)).status, 404, p);
    }
    assert.equal(source.hits.length, 0);
  });

  it('what the source sends is only passed on when it is a picture', async () => {
    source.mode = 'html';
    const got = await tile(f.parent, '5/1/1.png');
    assert.equal(got.status, 503);
    assert.equal(got.headers.get('retry-after'), '2');
    assert.ok(!fs.existsSync(path.join(server.config.dataDir, 'map-tiles', '5', '1', '1')));
    source.mode = 'ok';
  });

  it('when the source is down an old copy is used, and a tile nobody has yet answers "try again"', async () => {
    await tile(f.parent, '6/1/1.png');
    const file = path.join(server.config.dataDir, 'map-tiles', '6', '1', '1');
    const old = new Date(Date.now() - 20 * 86400_000);
    fs.utimesSync(file, old, old);
    source.mode = 'down';
    assert.equal((await tile(f.parent, '6/1/1.png')).status, 200);
    assert.equal((await tile(f.parent, '6/2/2.png')).status, 503);
    source.mode = 'ok';
    // Back up: a tile older than 14 days is fetched again.
    source.hits.length = 0;
    assert.equal((await tile(f.parent, '6/1/1.png')).status, 200);
    assert.equal(source.hits.length, 1);
  });

  it('the kept tiles never take more room than the limit: the ones used longest ago go first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-tiles-'));
    try {
      const config = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, DATA_DIR: dir, MAP_TILE_URL: source.template, MAP_TILE_CACHE_MB: '1' });
      assert.equal(config.mapTileCacheBytes, 1024 * 1024);
      const big = Buffer.concat([fakeTile('big'), Buffer.alloc(300 * 1024)]);
      const store = new TileStore(config, (async () => new Response(big, { status: 200 })) as typeof fetch);
      for (let x = 0; x < 6; x++) {
        assert.ok(await store.get(10, x, 0));
        // Tile 0 was read longest ago, tile 5 last.
        const t = new Date(Date.now() - (60 - x) * 60_000);
        fs.utimesSync(store.file(10, x, 0), t, t);
      }
      await store.prune();
      assert.ok((await store.size()) <= 1024 * 1024);
      const left = [0, 1, 2, 3, 4, 5].filter((x) => fs.existsSync(store.file(10, x, 0)));
      assert.deepEqual(left, [3, 4, 5]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tiles are limited per family, and one family\'s map does not use up another\'s', async () => {
    const small = await startServer({ MAP_TILE_URL: source.template }, { ipLimits: { links: 1000, verify: 1000, pair: 1000, api: 100000, tiles: 5 } });
    try {
      const one = await signIn(small, 'tiles-limit-a@example.com');
      const two = await signIn(small, 'tiles-limit-b@example.com');
      const ask = async (c: Client, y: number): Promise<number> => (await fetch(`${small.url}/api/map-tiles/8/1/${y}.png`, { headers: { cookie: c.cookie } })).status;
      const got = [];
      for (let y = 0; y < 7; y++) got.push(await ask(one, y));
      assert.deepEqual(got, [200, 200, 200, 200, 200, 429, 429]);
      assert.equal(await ask(two, 0), 200);
    } finally {
      await small.close();
    }
  });

  it('MAP_TILE_URL: a template is needed, "off" switches tiles off, and unset is the OpenStreetMap default with its credit', async () => {
    const base = { DATABASE_URL: TEST_DATABASE_URL };
    assert.throws(() => loadConfig({ ...base, MAP_TILE_URL: 'https://tiles.example/{z}/{x}.png' }), /MAP_TILE_URL/);
    assert.throws(() => loadConfig({ ...base, MAP_TILE_URL: 'ftp://tiles.example/{z}/{x}/{y}.png' }), /MAP_TILE_URL/);
    assert.throws(() => loadConfig({ ...base, MAP_TILE_CACHE_MB: 'lots' }), /MAP_TILE_CACHE_MB/);
    assert.throws(() => loadConfig({ ...base, MAP_TILE_ATTRIBUTION_URL: 'javascript:alert(1)' }), /MAP_TILE_ATTRIBUTION_URL/);
    const unset = loadConfig(base);
    assert.deepEqual([unset.mapTileUrl, unset.mapTileDefault, unset.mapTileAttribution, unset.mapTileAttributionUrl],
      ['https://tile.openstreetmap.org/{z}/{x}/{y}.png', true, '© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright']);
    const own = loadConfig({ ...base, MAP_TILE_URL: 'https://tiles.example/{z}/{x}/{y}.png?key=abc' });
    assert.deepEqual([own.mapTileDefault, own.mapTileAttribution], [false, '']);
    const off = await startServer({ MAP_TILE_URL: 'off' });
    try {
      const parent = await signIn(off, 'tiles-off@example.com');
      assert.equal((await parent.get('/api/map-tiles/1/0/0.png')).status, 404);
      assert.equal((await parent.get('/api/location')).body.tiles.enabled, false);
    } finally {
      await off.close();
    }
  });
});
