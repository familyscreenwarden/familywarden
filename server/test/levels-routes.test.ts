/**
 * Kids' levels and safe browsing against the real server and a real Postgres: the migration of the settings
 * families already had, what a level changes, what reaches the devices, and the walls between families.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createPool } from '../src/db';
import { migrations } from '../src/migrations';
import { Client, createKid, pairDevice, resetDatabase, signIn, startServer, TEST_DATABASE_URL, type Json, type TestServer } from './helpers';

let server: TestServer;
/** Kids made before the levels migration ran: [only allowed websites on, off with two sites switched off]. */
let oldKids: { listOnly: string; open: string; account: string };

before(async () => {
  await resetDatabase();
  // The database as it was before this update: the first three migrations, a family, two kids with their settings.
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await pool.query('CREATE TABLE migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const m of migrations.slice(0, 3)) {
      await pool.query(m.sql);
      await pool.query('INSERT INTO migrations (id) VALUES ($1)', [m.id]);
    }
    const acc = await pool.query("INSERT INTO accounts (email, trial_ends_at) VALUES ('old@example.com', now() + interval '30 days') RETURNING id");
    const account = acc.rows[0].id as string;
    const a = await pool.query(
      "INSERT INTO kids (account_id, name, only_allowed_sites, safe_search, youtube_restricted, block_private) VALUES ($1, 'Ada', true, true, false, true) RETURNING id",
      [account],
    );
    const b = await pool.query(
      "INSERT INTO kids (account_id, name, only_allowed_sites, safe_search, youtube_restricted, block_private) VALUES ($1, 'Ben', false, false, true, false) RETURNING id",
      [account],
    );
    oldKids = { listOnly: a.rows[0].id, open: b.rows[0].id, account };
    for (const kid of [oldKids.listOnly, oldKids.open]) {
      await pool.query(
        `INSERT INTO apps (account_id, kid_id, kind, platform, identifier, name, allowed) VALUES
           ($1, $2, 'site', 'any', 'khanacademy.org', 'Khan Academy', true),
           ($1, $2, 'site', 'any', 'tiktok.com', 'TikTok', false),
           ($1, $2, 'site', 'any', 'badsite.example', 'Bad site', false),
           ($1, $2, 'app', 'android', 'com.example.off', 'Some app', false)`,
        [account, kid],
      );
    }
  } finally {
    await pool.end();
  }
  server = await startServer();
});

after(async () => {
  await server.close();
});

const safety = async (parent: Client, kid: string): Promise<Json> => {
  const r = await parent.get(`/api/kids/${kid}/safety`);
  assert.equal(r.status, 200, r.text);
  return r.body;
};

describe('settings families already had', () => {
  let parent: Client;
  before(async () => {
    parent = await signIn(server, 'old@example.com');
  });

  it('"Only allowed websites" on stays exactly that: only the kid\'s sites, every switch as it was', async () => {
    const s = await safety(parent, oldKids.listOnly);
    assert.equal(s.level, null);
    assert.deepEqual(s.web, { mode: 'sites', categories: [], blocked: [], allowed: ['khanacademy.org'] });
    assert.equal(s.settings.safeSearch, true);
    assert.equal(s.settings.youTube, false);
    assert.equal(s.blockPrivate, true);
    assert.equal(s.settings.texting, 'friends');
    assert.deepEqual(s.changes, []);
    const kid = (await parent.get(`/api/kids/${oldKids.listOnly}`)).body.kid;
    assert.deepEqual([kid.onlyAllowedSites, kid.safeSearch, kid.youtubeRestricted, kid.blockPrivate], [true, true, false, true]);
  });

  it('"Only allowed websites" off becomes the open web, and the websites the parent had switched off stay blocked', async () => {
    const s = await safety(parent, oldKids.open);
    assert.deepEqual(s.web, { mode: 'open', categories: [], blocked: ['badsite.example', 'tiktok.com'], allowed: ['khanacademy.org'] });
    assert.equal(s.settings.safeSearch, false);
    assert.equal(s.settings.youTube, true);
    assert.equal(s.blockPrivate, false);
    const kid = (await parent.get(`/api/kids/${oldKids.open}`)).body;
    assert.equal(kid.kid.onlyAllowedSites, false);
    // The lists of apps and websites are untouched.
    assert.deepEqual(kid.apps.map((a: Json) => [a.identifier, a.allowed]).sort(), [['badsite.example', false], ['com.example.off', false], ['khanacademy.org', true], ['tiktok.com', false]]);
  });

  it('time limits and bedtimes are not touched by the migration', async () => {
    const kid = (await parent.get(`/api/kids/${oldKids.open}`)).body.kid;
    assert.deepEqual([kid.limitSchoolMinutes, kid.limitWeekendMinutes, kid.bedSchoolStart, kid.bedOtherStart, kid.bedtimeEnabled], [120, 180, '20:30', '21:30', true]);
  });
});

describe('levels', () => {
  let parent: Client;
  let kid: string;
  before(async () => {
    parent = await signIn(server, 'levels@example.com');
    kid = await createKid(parent, 'Mia');
  });

  it('a new kid has no level and only the kid\'s sites, as before', async () => {
    const s = await safety(parent, kid);
    assert.equal(s.level, null);
    assert.equal(s.web.mode, 'sites');
    assert.deepEqual(s.levels.map((l: Json) => l.id), ['little', 'big', 'teen']);
    assert.equal(s.categories.length, 8);
    assert.deepEqual(s.devices, []);
    assert.deepEqual(s.blockedToday, []);
  });

  it('a level sets time, bedtime, websites, SafeSearch and texting in one go, and the older fields say the same', async () => {
    assert.equal((await parent.post(`/api/kids/${kid}/safety/level`, { level: 'teen' })).status, 200);
    const s = await safety(parent, kid);
    assert.equal(s.level, 'teen');
    assert.deepEqual(s.changes, []);
    assert.deepEqual(s.settings, { schoolMinutes: 240, offMinutes: 300, schoolBedtime: '22:30', otherBedtime: '23:00', webMode: 'filtered', categories: ['adult', 'gambling', 'proxies'], safeSearch: true, youTube: true, texting: 'anyone' });
    const row = (await parent.get(`/api/kids/${kid}`)).body.kid;
    assert.deepEqual([row.limitSchoolMinutes, row.limitWeekendMinutes, row.bedSchoolStart, row.bedOtherStart, row.bedtimeEnabled, row.onlyAllowedSites],
      [240, 300, '22:30', '23:00', true, false]);
    // Wake-up times are the parent's own: a level leaves them alone.
    assert.deepEqual([row.bedSchoolEnd, row.bedOtherEnd], ['06:00', '07:00']);

    await parent.post(`/api/kids/${kid}/safety/level`, { level: 'little' });
    const little = (await parent.get(`/api/kids/${kid}`)).body.kid;
    assert.equal(little.onlyAllowedSites, true);
    assert.equal((await safety(parent, kid)).web.mode, 'sites');
  });

  it('changes made by hand show against the level and can be put back one by one', async () => {
    await parent.post(`/api/kids/${kid}/safety/level`, { level: 'big' });
    await parent.patch(`/api/kids/${kid}`, { limitSchoolMinutes: 150, bedtimeEnabled: false });
    let s = await safety(parent, kid);
    assert.deepEqual(s.changes.map((c: Json) => [c.key, c.level, c.now]), [
      ['schoolMinutes', '2 h', '2 h 30 m'],
      ['schoolBedtime', '8:30 pm', 'Off'],
      ['otherBedtime', '9:00 pm', 'Off'],
    ]);
    await parent.post(`/api/kids/${kid}/safety/level`, { level: 'big', only: 'schoolBedtime' });
    s = await safety(parent, kid);
    assert.deepEqual(s.changes.map((c: Json) => c.key), ['schoolMinutes']);
    assert.equal((await parent.post(`/api/kids/${kid}/safety/level`, { level: 'big', only: 'nonsense' })).status, 400);
    assert.equal((await parent.post(`/api/kids/${kid}/safety/level`, { level: 'giant' })).status, 400);
    await parent.post(`/api/kids/${kid}/safety/level`, { level: 'big' });
    assert.deepEqual((await safety(parent, kid)).changes, []);
  });

  it('the older "Only allowed websites" switch and the website rule are one setting', async () => {
    await parent.patch(`/api/kids/${kid}`, { onlyAllowedSites: true });
    assert.equal((await safety(parent, kid)).web.mode, 'sites');
    await parent.patch(`/api/kids/${kid}`, { onlyAllowedSites: false });
    assert.equal((await safety(parent, kid)).web.mode, 'open');
    await parent.send('PUT', `/api/kids/${kid}/safety/web`, { mode: 'filtered' });
    // Switching "only allowed" off again does not throw a filter away.
    await parent.patch(`/api/kids/${kid}`, { onlyAllowedSites: false });
    assert.equal((await safety(parent, kid)).web.mode, 'filtered');
    assert.equal((await parent.get(`/api/kids/${kid}`)).body.kid.onlyAllowedSites, false);
  });

  it('a birthday suggests a level and never changes one; a wrong date is refused', async () => {
    const put = (birthday: unknown) => parent.send('PUT', `/api/kids/${kid}/safety/birthday`, { birthday });
    // The test clock says 11 March 2026.
    assert.equal((await put('2016-03-12')).status, 200);
    let s = await safety(parent, kid);
    assert.equal(s.birthday, '2016-03-12');
    assert.equal(s.level, 'big');
    assert.equal(s.suggested, null, 'nine years old: Big kid is the level in use');
    assert.deepEqual([s.next.level.id, s.next.on], ['teen', '2029-03-12']);
    assert.equal((await put('2012-02-03')).status, 200);
    s = await safety(parent, kid);
    assert.equal(s.suggested, 'teen');
    assert.equal(s.level, 'big');
    for (const bad of ['2030-01-01', '1980-01-01', '2016-02-31', 'yesterday', 20160312]) assert.equal((await put(bad)).status, 400, String(bad));
    assert.equal((await put(null)).status, 200);
    assert.equal((await safety(parent, kid)).birthday, null);
  });

  it('website rules are checked: modes, kinds of sites, hosts, and at most 500 blocked by name', async () => {
    const web = (body: Json) => parent.send('PUT', `/api/kids/${kid}/safety/web`, body);
    assert.equal((await web({ mode: 'everything' })).status, 400);
    assert.equal((await web({ categories: ['adult', 'unicorns'] })).status, 400);
    assert.equal((await web({})).status, 400);
    assert.equal((await web({ mode: 'filtered', categories: ['games', 'adult'], safeSearch: false, youTube: false, blockPrivate: false })).status, 200);
    const s = await safety(parent, kid);
    assert.deepEqual([s.web.mode, s.web.categories, s.settings.safeSearch, s.settings.youTube, s.blockPrivate], ['filtered', ['games', 'adult'], false, false, false]);
    const site = (body: Json) => parent.post(`/api/kids/${kid}/safety/site`, body);
    assert.equal((await site({ host: 'not a site', allow: true })).status, 400);
    assert.equal((await site({ host: 'example.com' })).status, 400);
    assert.equal((await parent.send('PUT', `/api/kids/${kid}/safety/texting`, { who: 'everyone' })).status, 400);
    await server.pool.query('UPDATE kids SET web_blocked = (SELECT array_agg(\'n\' || g || \'.example\') FROM generate_series(1, 500) g) WHERE id = $1', [kid]);
    const full = await site({ host: 'one-more.example', allow: false });
    assert.equal(full.status, 400);
    assert.match(full.body.error, /500/);
    await server.pool.query("UPDATE kids SET web_blocked = '{}' WHERE id = $1", [kid]);
  });

  it('allow, block and take off: a website is on one list at most, and its row is never lost', async () => {
    const site = (body: Json) => parent.post(`/api/kids/${kid}/safety/site`, body);
    await site({ host: 'HTTPS://www.Roblox.com/games', allow: true });
    let s = await safety(parent, kid);
    assert.deepEqual([s.web.allowed, s.web.blocked], [['roblox.com'], []]);
    await site({ host: 'roblox.com', allow: false });
    s = await safety(parent, kid);
    assert.deepEqual([s.web.allowed, s.web.blocked], [[], ['roblox.com']]);
    const apps = (await parent.get(`/api/kids/${kid}`)).body.apps;
    assert.deepEqual(apps.map((a: Json) => [a.identifier, a.allowed]), [['roblox.com', false]]);
    await site({ host: 'roblox.com', allow: false, remove: true });
    s = await safety(parent, kid);
    assert.deepEqual([s.web.allowed, s.web.blocked], [[], []]);
  });

  it('every device of the kid gets the same web rules, and the kid\'s list wins over a blocked kind', async () => {
    await parent.send('PUT', `/api/kids/${kid}/safety/web`, { mode: 'filtered', categories: ['games', 'adult'] });
    await parent.post(`/api/kids/${kid}/safety/site`, { host: 'roblox.com', allow: true });
    await parent.post(`/api/kids/${kid}/safety/site`, { host: 'blocked-by-mom.example', allow: false });
    const one = (await pairDevice(server, parent, kid, 'android', 'Phone')).device;
    const two = (await pairDevice(server, parent, kid, 'windows', 'PC')).device;
    const a = (await one.post('/api/warden/sync', {})).body;
    const b = (await two.post('/api/warden/sync', {})).body;
    assert.deepEqual(a.web, b.web);
    assert.equal(a.web.mode, 'filtered');
    assert.ok(a.web.block.includes('poki.com'));
    assert.ok(a.web.block.includes('pornhub.com'));
    assert.ok(a.web.block.includes('blocked-by-mom.example'));
    assert.ok(!a.web.block.includes('roblox.com'), 'on the kid\'s list, so not blocked although games are');
    assert.ok(!a.web.block.includes('tiktok.com'), 'social media is not a blocked kind here');
    assert.ok(a.web.words.includes('porn'));
    // Open web: only what a parent blocked, no words.
    await parent.send('PUT', `/api/kids/${kid}/safety/web`, { mode: 'open' });
    const open = (await one.post('/api/warden/sync', {})).body.web;
    assert.deepEqual(open, { mode: 'open', block: ['blocked-by-mom.example'], words: [] });
    // Texting by level reaches the phone; a PC has no texting at all.
    await parent.send('PUT', `/api/kids/${kid}/safety/texting`, { who: 'anyone' });
    assert.equal((await one.post('/api/warden/sync', {})).body.texting.who, 'anyone');
    assert.equal((await two.post('/api/warden/sync', {})).body.texting, undefined);
    const s = await safety(parent, kid);
    assert.deepEqual(s.devices.map((d: Json) => [d.name, d.platform]), [['PC', 'windows'], ['Phone', 'android']]);
  });

  it('a website the kid asks for from the blocked screen: yes puts it on the list and off the blocked list', async () => {
    const phone = (await pairDevice(server, parent, kid, 'android', 'Phone 2')).device;
    const asked = await phone.post('/api/android/request', { site: 'www.Blocked-By-Mom.example' });
    assert.equal(asked.body.status, 'sent', asked.text);
    assert.equal((await phone.post('/api/android/request', { site: 'blocked-by-mom.example' })).body.status, 'pending');
    assert.equal((await phone.post('/api/android/request', { site: 'games.roblox.com' })).body.status, 'allowed');
    assert.equal((await phone.post('/api/android/request', {})).status, 400);
    const pending = (await parent.get('/api/requests')).body.requests.find((r: Json) => r.id === asked.body.id);
    assert.deepEqual([pending.kind, pending.detail, pending.identifier], ['site', 'blocked-by-mom.example', 'blocked-by-mom.example']);
    await parent.post(`/api/requests/${asked.body.id}/decide`, { approve: true });
    const s = await safety(parent, kid);
    assert.ok(s.web.allowed.includes('blocked-by-mom.example'));
    assert.deepEqual(s.web.blocked, []);
  });
});

describe('walls: levels and safe browsing', () => {
  it('another family gets "not found" on every route, a signed-out visitor "please sign in", a phone nothing', async () => {
    const mine = await signIn(server, 'walls-a@example.com');
    const kid = await createKid(mine, 'Zoe');
    await mine.post(`/api/kids/${kid}/safety/level`, { level: 'little' });
    const other = await signIn(server, 'walls-b@example.com');
    const otherKid = await createKid(other, 'Sam');
    const phone = (await pairDevice(server, other, otherKid, 'android', 'Phone')).device;
    const calls: Array<[string, string, Json | undefined]> = [
      ['GET', `/api/kids/${kid}/safety`, undefined],
      ['POST', `/api/kids/${kid}/safety/level`, { level: 'teen' }],
      ['PUT', `/api/kids/${kid}/safety/birthday`, { birthday: '2015-01-01' }],
      ['PUT', `/api/kids/${kid}/safety/web`, { mode: 'open' }],
      ['POST', `/api/kids/${kid}/safety/site`, { host: 'evil.example', allow: true }],
      ['PUT', `/api/kids/${kid}/safety/texting`, { who: 'anyone' }],
    ];
    for (const [method, path, body] of calls) {
      assert.equal((await other.send(method, path, body)).status, 404, `${method} ${path} from another family`);
      assert.equal((await new Client(server.url).send(method, path, body)).status, 401, `${method} ${path} signed out`);
      assert.equal((await phone.send(method, path, body)).status, 401, `${method} ${path} with a phone's token`);
    }
    assert.equal((await other.get('/api/kids/not-an-id/safety')).status, 404);
    const s = await safety(mine, kid);
    assert.equal(s.level, 'little');
    assert.equal(s.birthday, null);
    assert.equal(s.web.mode, 'sites');
    assert.deepEqual(s.web.allowed, []);
    assert.equal(s.settings.texting, 'family');
  });
});
