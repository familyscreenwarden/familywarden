/**
 * Kids' photos, videos and texts against the real server and a real Postgres: what is kept and where, the limits,
 * and above all who can reach what. Children's photos and messages must never cross from one family to another,
 * from one kid's phone to another's, or out through a link further than the one item the link is for.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { purgeExpired, sweepOrphanFiles } from '../src/state';
import { Client, createKid, resetDatabase, signIn, startServer, TEST_DATA_DIR, type Json, type Reply, type TestServer } from './helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOBODY = '00000000-0000-4000-8000-000000000000';
const SECRET = 'a-session-secret-for-the-media-tests';

const jpeg = (bytes = 20_000): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(bytes)]);
const png = (bytes = 2000): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(bytes)]);
const webm = (bytes = 50_000): Buffer => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), crypto.randomBytes(bytes)]);
const mp4 = (bytes = 50_000): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), crypto.randomBytes(bytes)]);
const b64 = (t: string): string => Buffer.from(t, 'utf8').toString('base64');

let server: TestServer;

before(async () => {
  await resetDatabase();
  server = await startServer({ BILLING_ENABLED: '', SESSION_SECRET: SECRET });
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

async function raw(method: string, url: string, body: Buffer | undefined, plain: Record<string, string>, base = server.url): Promise<Reply & { bytes: Buffer }> {
  const headers = withMarker(method, url, plain);
  const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = {};
  }
  return { status: res.status, body: json, headers: res.headers, text, bytes };
}

interface Fam {
  parent: Client;
  accountId: string;
  kid: string;
  phone: Client;
  deviceId: string;
}

/** A phone for a kid, paired through a setup code like the app does. */
async function pairPhone(s: TestServer, parent: Client, kid: string, machine: string): Promise<{ phone: Client; deviceId: string }> {
  const code = await parent.post('/api/devices/pairing-code', { kidId: kid, platform: 'android' });
  assert.equal(code.status, 201, code.text);
  const phone = new Client(s.url);
  const paired = await phone.post('/api/android/pair', { code: code.body.code, memberId: kid, deviceId: machine, model: 'Test phone', version: '1.1.0' });
  assert.equal(paired.status, 200, paired.text);
  phone.bearer = paired.body.token as string;
  return { phone, deviceId: paired.body.computerId as string };
}

async function family(email: string, kidName: string, machine: string, s: TestServer = server): Promise<Fam> {
  const parent = await signIn(s, email);
  const kid = await createKid(parent, kidName);
  const accountId = (await parent.get('/api/me')).body.account.id as string;
  return { parent, accountId, kid, ...(await pairPhone(s, parent, kid, machine)) };
}

function upload(phone: Client, body: Buffer, h: Record<string, string>, base = server.url): Promise<Reply> {
  return raw('POST', '/api/android/media', body, { Authorization: `Bearer ${phone.bearer}`, 'X-Media-At': String(Date.now() - 1000), 'X-Media-Duration': '0', ...h }, base);
}
const photoHeaders = (id: string, title = ''): Record<string, string> => ({ 'Content-Type': 'image/jpeg', 'X-Media-Id': id, 'X-Media-Kind': 'photo', 'X-Media-Title': b64(title) });
const videoHeaders = (id: string, title = '', seconds = 12): Record<string, string> => ({
  'Content-Type': 'video/webm', 'X-Media-Id': id, 'X-Media-Kind': 'video', 'X-Media-Title': b64(title), 'X-Media-Duration': String(seconds),
});

const kidDir = (f: Fam): string => path.join(TEST_DATA_DIR, 'kid-media', f.accountId, f.kid);
const filesOf = (f: Fam): string[] => (fs.existsSync(kidDir(f)) ? fs.readdirSync(kidDir(f)) : []);
const items = async (f: Fam): Promise<Json[]> => (await f.parent.get(`/api/kids/${f.kid}/media`)).body.items as Json[];

describe('what a phone may upload', () => {
  let f: Fam;
  before(async () => {
    f = await family('upload@example.com', 'Una', 'machine-upload-0001');
  });

  it('keeps JPEG and PNG photos and WebM and MP4 videos, each in the folder of its family and kid, under a name the server chose', async () => {
    const sent: Array<[Buffer, Record<string, string>]> = [
      [jpeg(), photoHeaders('a-jpeg', 'Photo one')],
      [png(), { ...photoHeaders('a-png'), 'Content-Type': 'image/png' }],
      [webm(), videoHeaders('a-webm', 'Clip')],
      [mp4(), { ...videoHeaders('a-mp4', 'Movie', 61), 'Content-Type': 'video/mp4', 'X-Media-Kind': 'movie' }],
    ];
    for (const [body, h] of sent) {
      const r = await upload(f.phone, body, h);
      assert.equal(r.status, 201, r.text);
      assert.match(r.body.id, UUID);
      assert.ok(fs.readFileSync(path.join(kidDir(f), r.body.id)).equals(body));
    }
    const names = filesOf(f);
    assert.equal(names.length, 4);
    for (const n of names) assert.match(n, UUID);
    const list = await items(f);
    assert.deepEqual(list.map((i) => i.kind).sort(), ['movie', 'photo', 'photo', 'video']);
    assert.equal(list.find((i) => i.kind === 'movie')?.durationSec, 61);
    // A photo has no length, whatever the header says.
    const odd = await upload(f.phone, jpeg(100), { ...photoHeaders('a-long-photo'), 'X-Media-Duration': '99' });
    assert.equal((await items(f)).find((i) => i.id === odd.body.id)?.durationSec, 0);
  });

  it('refuses other types, and files that are not what their type says (nothing stays on disk)', async () => {
    const before = filesOf(f).length;
    const page = Buffer.from('<html><script>alert(1)</script></html>');
    const tries: Array<[string, Buffer, Record<string, string>, number]> = [
      ['a page', page, { ...photoHeaders('h1'), 'Content-Type': 'text/html' }, 415],
      ['a drawing with scripts', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { ...photoHeaders('h2'), 'Content-Type': 'image/svg+xml' }, 415],
      ['a gif', Buffer.from('GIF89a....'), { ...photoHeaders('h3'), 'Content-Type': 'image/gif' }, 415],
      ['a program', Buffer.from('MZ......'), { ...photoHeaders('h4'), 'Content-Type': 'application/octet-stream' }, 415],
      ['a page dressed as a JPEG', page, photoHeaders('h5'), 415],
      ['a page dressed as an MP4', page, { ...videoHeaders('h6'), 'Content-Type': 'video/mp4' }, 415],
      ['a PNG sent as a JPEG', png(), photoHeaders('h7'), 415],
      ['a video sent as a photo', webm(), { ...videoHeaders('h8'), 'X-Media-Kind': 'photo' }, 400],
      ['a photo sent as a movie', jpeg(), { ...photoHeaders('h9'), 'X-Media-Kind': 'movie' }, 400],
      ['an unknown kind', jpeg(), { ...photoHeaders('h10'), 'X-Media-Kind': 'selfie' }, 400],
      ['no id', jpeg(), { 'Content-Type': 'image/jpeg', 'X-Media-Kind': 'photo' }, 400],
      ['an id that is too long', jpeg(), photoHeaders('x'.repeat(65)), 400],
      ['nothing at all', Buffer.alloc(0), photoHeaders('h11'), 400],
    ];
    for (const [name, body, h, status] of tries) assert.equal((await upload(f.phone, body, h)).status, status, name);
    assert.equal(filesOf(f).length, before);
    assert.equal(filesOf(f).some((n) => n.endsWith('.part')), false);
  });

  it('an id from the phone never becomes a path: it is kept as text, the file name stays the server\'s own', async () => {
    const before = new Set(filesOf(f));
    for (const id of ['../../../../etc/passwd', '..%2f..%2fescape', 'C:\\Windows\\win.ini', '/etc/shadow', '....//....//x']) {
      const r = await upload(f.phone, jpeg(300), photoHeaders(id, '../../title'));
      assert.equal(r.status, 201, id);
      assert.match(r.body.id, UUID);
    }
    const fresh = filesOf(f).filter((n) => !before.has(n));
    assert.equal(fresh.length, 5);
    for (const n of fresh) assert.match(n, UUID);
    // Nothing appeared anywhere else under the data folder.
    const all = fs.readdirSync(TEST_DATA_DIR, { recursive: true }) as string[];
    assert.equal(all.some((p) => /passwd|shadow|escape|win\.ini/.test(p)), false);
    assert.equal(fs.existsSync(path.join(TEST_DATA_DIR, '..', 'etc')), false);
    // The follow-up routes take the same odd ids as plain text too (or do not find them).
    assert.equal((await f.phone.post(`/api/android/media/${encodeURIComponent('../../../../etc/passwd')}/deleted`, {})).status, 200);
    assert.equal((await f.phone.post('/api/android/media/..%2F..%2Fnothing/link', {})).status, 404);
  });

  it('titles are plain text: decoded, one line, at most 120 characters, and escaped wherever they are shown', async () => {
    const r = await upload(f.phone, webm(500), videoHeaders('titled', `<script>alert("x")</script>\n${'z'.repeat(300)}`));
    const item = (await items(f)).find((i) => i.id === r.body.id);
    assert.equal([...(item?.title as string)].length, 120);
    assert.equal(/[\n\r]/.test(item?.title as string), false);
    const link = (await f.phone.post('/api/android/media/titled/link', {})).body.link as string;
    const html = await (await fetch(server.url + new URL(link).pathname)).text();
    assert.equal(html.includes('<script>'), false);
    assert.ok(html.includes('&#60;script&#62;'));
    // A header that is not base64 gives an empty title, not an error.
    const junk = await upload(f.phone, jpeg(200), { ...photoHeaders('junk-title'), 'X-Media-Title': '%%%not base64%%%' });
    assert.equal(junk.status, 201);
    assert.equal((await items(f)).find((i) => i.id === junk.body.id)?.title, '');
  });

  it('a raw upload without the X-FSW-Upload marker is refused, for photos and videos and for pictures in texts', async () => {
    const before = filesOf(f).length;
    for (const marker of ['', '0', 'yes']) {
      const r = await upload(f.phone, jpeg(), { ...photoHeaders(`no-marker-${marker}`), 'X-FSW-Upload': marker });
      assert.equal(r.status, 400, marker);
      assert.match(r.body.error, /X-FSW-Upload/);
      const t = await raw('POST', '/api/android/text-media/m1/nm1', png(), { Authorization: `Bearer ${f.phone.bearer}`, 'Content-Type': 'image/png', 'X-FSW-Upload': marker });
      assert.equal(t.status, 400, marker);
    }
    assert.equal(filesOf(f).length, before);
    assert.equal((await server.pool.query("SELECT 1 FROM text_media WHERE phone_media_id = 'nm1'")).rowCount, 0);
    // With the marker, exactly as the app sends it (WardenApi.sendFile): accepted.
    const ok = await raw('POST', '/api/android/media', jpeg(), { Authorization: `Bearer ${f.phone.bearer}`, Accept: 'application/json', 'X-FSW-Upload': '1',
      'Content-Type': 'image/jpeg', 'X-Media-Id': crypto.randomUUID(), 'X-Media-Kind': 'photo', 'X-Media-Title': '', 'X-Media-At': String(Date.now()), 'X-Media-Duration': '0' });
    assert.equal(ok.status, 201, ok.text);
    const pic = await raw('POST', `/api/android/text-media/${crypto.randomUUID()}/${crypto.randomUUID()}`, jpeg(), { Authorization: `Bearer ${f.phone.bearer}`, 'X-FSW-Upload': '1', 'Content-Type': 'image/jpeg' });
    assert.equal(pic.status, 201, pic.text);
  });

  it('the family-screen ask and the friend answer carry words for the kid, as the app reads them', async () => {
    const fam = await f.phone.post('/api/android/media/a-webm/family-screen', {});
    assert.equal(fam.status, 200);
    assert.ok(typeof fam.body.message === 'string' && fam.body.message.length > 10);
    const asked = await f.phone.post('/api/android/friend', { name: 'Ava', phone: '(555) 014-2290', note: "She's in my class" });
    assert.ok(['sent', 'pending', 'approved', 'denied'].includes(asked.body.status) && typeof asked.body.message === 'string');
    // Without a note, as the app sends it when the box is empty.
    assert.equal((await f.phone.post('/api/android/friend', { name: 'Bo', phone: '555 014 2291' })).status, 200);
  });

  it('a file over 200 MB is refused before it is read', async () => {
    // Only the announced size is sent; the server answers from the header.
    const res = await new Promise<number>((resolve, reject) => {
      const url = new URL(server.url);
      import('node:http').then(({ request }) => {
        const req = request(
          { host: url.hostname, port: url.port, path: '/api/android/media', method: 'POST',
            headers: { Authorization: `Bearer ${f.phone.bearer}`, 'X-FSW-Upload': '1', ...photoHeaders('huge'), 'Content-Length': String(200 * 1024 * 1024 + 1) } },
          (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
            req.destroy();
          },
        );
        req.on('error', reject);
        req.write(Buffer.from([0xff, 0xd8, 0xff]));
      }, reject);
    });
    assert.equal(res, 413);
    assert.equal((await items(f)).some((i) => i.title === 'huge'), false);
  });

  it('files sent back are data, never pages: fixed types, no sniffing, nothing may run, Range works', async () => {
    const list = await items(f);
    const video = list.find((i) => i.type === 'video/webm' && i.title === 'Clip') as Json;
    const size = video.size as number;
    const get = (h: Record<string, string> = {}, q = ''): Promise<Reply & { bytes: Buffer }> => raw('GET', `${video.url}${q}`, undefined, { cookie: f.parent.cookie, ...h });
    const whole = await get();
    assert.deepEqual(
      [whole.status, whole.headers.get('content-type'), whole.headers.get('x-content-type-options'), whole.headers.get('content-security-policy'), whole.headers.get('content-disposition')],
      [200, 'video/webm', 'nosniff', "default-src 'none'; sandbox", 'inline'],
    );
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(whole.bytes.length, size);
    const mid = await get({ Range: 'bytes=10-19' });
    assert.deepEqual([mid.status, mid.headers.get('content-range'), mid.bytes.length], [206, `bytes 10-19/${size}`, 10]);
    assert.ok(mid.bytes.equals(whole.bytes.subarray(10, 20)));
    const tail = await get({ Range: 'bytes=-5' });
    assert.deepEqual([tail.status, tail.headers.get('content-range')], [206, `bytes ${size - 5}-${size - 1}/${size}`]);
    const open = await get({ Range: `bytes=${size - 3}-` });
    assert.equal(open.bytes.length, 3);
    const past = await get({ Range: `bytes=${size}-` });
    assert.deepEqual([past.status, past.headers.get('content-range')], [416, `bytes */${size}`]);
    // Several ranges at once are not read: the whole file goes out.
    assert.equal((await get({ Range: 'bytes=0-1,5-6' })).status, 200);
    const saved = await get({}, '?download=1');
    assert.equal(saved.headers.get('content-disposition'), 'attachment; filename="Clip.webm"');
    const head = await raw('HEAD', video.url as string, undefined, { cookie: f.parent.cookie });
    assert.deepEqual([head.status, head.headers.get('content-length'), head.bytes.length], [200, String(size), 0]);
  });
});

describe('room per kid', () => {
  it('a kid\'s photos and videos stop at the quota (507, to try again later) and go on once a parent made room', async () => {
    const small = await startServer({ BILLING_ENABLED: '', SESSION_SECRET: SECRET, KID_MEDIA_QUOTA_MB: '1' });
    try {
      const f = await family('quota@example.com', 'Quinn', 'machine-quota-0001', small);
      const sib = await createKid(f.parent, 'Sibling');
      const sibPhone = await pairPhone(small, f.parent, sib, 'machine-quota-0002');
      const up = (phone: Client, id: string, bytes: number): Promise<Reply> => upload(phone, jpeg(bytes), photoHeaders(id), small.url);
      const first = await up(f.phone, 'q1', 600_000);
      assert.equal(first.status, 201, first.text);
      const second = await up(f.phone, 'q2', 600_000);
      assert.equal(second.status, 507);
      assert.match(second.body.error, /no room/i);
      // The other kid of the same family has their own room.
      assert.equal((await up(sibPhone.phone, 'q1', 600_000)).status, 201);
      let md = (await f.parent.get(`/api/kids/${f.kid}/media`)).body;
      assert.deepEqual([md.items.length, md.quotaBytes, md.usedBytes], [1, 1024 * 1024, 600_004]);
      assert.equal(fs.readdirSync(path.join(TEST_DATA_DIR, 'kid-media', f.accountId, f.kid)).length, 1);
      // A small one still fits; then it is full to the last byte.
      assert.equal((await up(f.phone, 'q3', 400_000)).status, 201);
      assert.equal((await up(f.phone, 'q4', 100_000)).status, 507);
      // The copy that is there is answered as before (the phone asks again after a lost answer).
      assert.equal((await up(f.phone, 'q1', 600_000)).status, 200);
      await f.parent.del(`/api/media/${first.body.id}`);
      assert.equal((await up(f.phone, 'q2', 600_000)).status, 201);
      md = (await f.parent.get(`/api/kids/${f.kid}/media`)).body;
      assert.equal(md.usedBytes, 400_004 + 600_004);
    } finally {
      await small.close();
    }
  });

  it('KID_MEDIA_QUOTA_MB must be a sensible number', async () => {
    const { loadConfig } = await import('../src/config');
    assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x/y', KID_MEDIA_QUOTA_MB: 'lots' }), /KID_MEDIA_QUOTA_MB/);
    assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x/y', KID_MEDIA_QUOTA_MB: '0' }), /KID_MEDIA_QUOTA_MB/);
    assert.equal(loadConfig({ DATABASE_URL: 'postgres://x/y' }).kidMediaQuotaBytes, 5 * 1024 * 1024 * 1024);
  });
});

describe('walls: photos and videos', () => {
  let a: Fam;
  let b: Fam;
  let sibling: { kid: string; phone: Client; deviceId: string };
  let photoId = '';
  let videoId = '';
  let link = '';
  let token = '';

  before(async () => {
    a = await family('media-a@example.com', 'Ann', 'machine-media-a-01');
    b = await family('media-b@example.com', 'Ben', 'machine-media-b-01');
    const kid = await createKid(a.parent, 'Abe');
    sibling = { kid, ...(await pairPhone(server, a.parent, kid, 'machine-media-a-02')) };
    photoId = (await upload(a.phone, jpeg(), photoHeaders('p1', 'Private photo'))).body.id;
    videoId = (await upload(a.phone, webm(), videoHeaders('v1', 'Private video'))).body.id;
    link = (await a.phone.post('/api/android/media/v1/link', {})).body.link;
    token = link.split('/m/')[1] ?? '';
  });

  it('another family gets "not found" on every gallery route, a signed-out visitor "please sign in"', async () => {
    const P = b.parent;
    const tries: Array<[string, Promise<Reply>]> = [
      ['list', P.get(`/api/kids/${a.kid}/media`)],
      ['photo file', P.get(`/api/media/${photoId}/file`)],
      ['video file', P.get(`/api/media/${videoId}/file`)],
      ['download', P.get(`/api/media/${videoId}/file?download=1`)],
      ['end link', P.del(`/api/media/${videoId}/link`)],
      ['delete', P.del(`/api/media/${photoId}`)],
      ['nobody', P.get(`/api/media/${NOBODY}/file`)],
      ['not an id', P.get('/api/media/..%2F..%2Fetc/file')],
    ];
    for (const [what, p] of tries) assert.equal((await p).status, 404, what);
    const anon = new Client(server.url);
    for (const p of [`/api/kids/${a.kid}/media`, `/api/media/${photoId}/file`, `/api/media/${videoId}/file`]) assert.equal((await anon.get(p)).status, 401, p);
    assert.equal((await anon.del(`/api/media/${photoId}`)).status, 401);
    assert.equal((await anon.del(`/api/media/${videoId}/link`)).status, 401);
    // A device token is not a parent: it opens no gallery route.
    const asDevice = new Client(server.url);
    asDevice.bearer = a.phone.bearer;
    assert.equal((await asDevice.get(`/api/kids/${a.kid}/media`)).status, 401);
    assert.equal((await asDevice.get(`/api/media/${photoId}/file`)).status, 401);
    // Family B's own list is its own, and nothing of A changed.
    assert.deepEqual(await items(b), []);
    assert.deepEqual((await items(a)).map((i) => [i.title, i.linkShared]).sort(), [['Private photo', false], ['Private video', true]]);
  });

  it('the list of one kid never holds a brother\'s or sister\'s things', async () => {
    await upload(sibling.phone, jpeg(500), photoHeaders('p1', 'Abe took this'));
    const ann = (await a.parent.get(`/api/kids/${a.kid}/media`)).body.items as Json[];
    const abe = (await a.parent.get(`/api/kids/${sibling.kid}/media`)).body.items as Json[];
    assert.deepEqual(ann.map((i) => i.title).sort(), ['Private photo', 'Private video']);
    assert.deepEqual(abe.map((i) => i.title), ['Abe took this']);
    // On disk too: one folder per kid.
    assert.equal(fs.readdirSync(kidDir(a)).length, 2);
    assert.equal(fs.readdirSync(path.join(TEST_DATA_DIR, 'kid-media', a.accountId, sibling.kid)).length, 1);
  });

  it('a phone only reaches what it uploaded itself: not another family\'s, not a sibling\'s, by the phone\'s id or the server\'s', async () => {
    for (const [who, phone] of [['other family', b.phone], ['sibling', sibling.phone]] as Array<[string, Client]>) {
      for (const id of ['v1', videoId, photoId]) {
        assert.equal((await phone.post(`/api/android/media/${id}/link`, {})).status, 404, `${who} link ${id}`);
      }
      assert.equal((await phone.post(`/api/android/media/${videoId}/deleted`, {})).status, 404, `${who} deleted`);
    }
    // The sibling's own "p1" is another item than Ann's "p1": marking it changes only the sibling's.
    assert.equal((await sibling.phone.post('/api/android/media/p1/deleted', {})).status, 200);
    assert.equal((await items(a)).find((i) => i.id === photoId)?.deletedOnPhone, false);
    // The same phone id uploaded by another phone is a new item for that phone's own kid, never an overwrite.
    const other = await upload(b.phone, jpeg(300), photoHeaders('p1', 'Ben\'s own'));
    assert.equal(other.status, 201);
    assert.notEqual(other.body.id, photoId);
    assert.deepEqual((await items(b)).map((i) => i.title), ['Ben\'s own']);
    assert.equal(fs.readdirSync(kidDir(b)).length, 1);
    // There is nothing for a phone to read back: no list, no file route.
    assert.equal((await b.phone.get('/api/android/media')).status, 404);
    assert.equal((await a.phone.get('/api/android/media')).status, 404);
    assert.equal((await a.phone.get(`/api/android/media/${videoId}`)).status, 404);
    assert.equal((await a.phone.get(`/api/media/${videoId}/file`)).status, 401);
    // No token, or a made-up one: nothing.
    const nobody = new Client(server.url);
    assert.equal((await upload(nobody, jpeg(100), photoHeaders('n1'))).status, 401);
    nobody.bearer = 'x'.repeat(43);
    assert.equal((await upload(nobody, jpeg(100), photoHeaders('n1'))).status, 401);
    assert.equal((await nobody.post('/api/android/media/v1/link', {})).status, 401);
    assert.equal((await nobody.post('/api/android/media/v1/deleted', {})).status, 401);
    assert.equal((await nobody.post('/api/android/media/v1/family-screen', {})).status, 401);
  });

  it('a link shows exactly one item, to anyone who has it, and nothing can be listed or guessed from it', async () => {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const page = await raw('GET', `/m/${token}`, undefined, {});
    assert.equal(page.status, 200);
    assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(page.text.includes('Private video') && page.text.includes('Ann'));
    // In the product's own look, by name.
    assert.ok(page.text.includes('Family Screen Warden') && page.text.includes('#0c1a2e') && page.text.includes('#34d399'));
    // The page names nothing else of the kid's: no other title, no ids, no address but its own file.
    assert.equal(page.text.includes('Private photo'), false);
    for (const secret of [photoId, videoId, a.kid, a.accountId, 'media-a@example.com']) assert.equal(page.text.includes(secret), false, secret);
    assert.deepEqual([...page.text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]), [`/m/${token}/file`]);
    const file = await raw('GET', `/m/${token}/file`, undefined, {});
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'video/webm');
    assert.ok(file.bytes.equals(fs.readFileSync(path.join(kidDir(a), videoId))));

    // Nothing is listed, and ids are not keys.
    const misses = ['/m', '/m/', `/m/${videoId}`, `/m/${videoId}/file`, `/m/${photoId}`, `/m/${photoId}/file`, `/m/${a.kid}`, `/m/${token}/list`,
      `/m/${token}/../${photoId}`, `/m/${token}/file/${photoId}`, `/m/${token.slice(0, -1)}`, `/m/${token}x`, `/m/${token.toLowerCase()}`, '/m/..%2Fapi%2Fkids', `/m/${'A'.repeat(43)}`];
    for (const p of misses) {
      const r = await raw('GET', p, undefined, {});
      assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
      assert.equal(r.text.includes('Private'), false, p);
    }
    // Only reading: a link cannot change or remove anything.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await raw(method, `/m/${token}`, undefined, {})).status, 404, method);
    // The link is no key to the console or the phone API.
    assert.equal((await raw('GET', `/api/media/${videoId}/file`, undefined, { Authorization: `Bearer ${token}` })).status, 401);
    assert.equal((await raw('GET', `/api/kids/${a.kid}/media`, undefined, { cookie: `fsw_session=${token}` })).status, 401);
  });

  it('the token is not in the database: only its hash, so a copy of the database opens no link', async () => {
    const row = (await server.pool.query('SELECT * FROM kid_media WHERE id = $1', [videoId])).rows[0] as Record<string, unknown>;
    for (const [column, value] of Object.entries(row)) assert.notEqual(String(value), token, column);
    assert.equal(JSON.stringify(row).includes(token), false);
    assert.match(String(row.share_token_hash), /^[0-9a-f]{64}$/);
    // The hash and the nonce do not open the link either.
    assert.equal((await raw('GET', `/m/${String(row.share_token_hash)}`, undefined, {})).status, 404);
    assert.equal((await raw('GET', `/m/${String(row.share_nonce)}`, undefined, {})).status, 404);
  });

  it('a photo can have a link too, and each link is for its own item only', async () => {
    const photoLink = (await a.phone.post('/api/android/media/p1/link', {})).body.link as string;
    const photoToken = photoLink.split('/m/')[1] ?? '';
    assert.notEqual(photoToken, token);
    const page = await raw('GET', `/m/${photoToken}`, undefined, {});
    assert.ok(page.text.includes('<img src="') && page.text.includes('Private photo'));
    assert.equal(page.text.includes('Private video'), false);
    const file = await raw('GET', `/m/${photoToken}/file`, undefined, {});
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.ok(file.bytes.equals(fs.readFileSync(path.join(kidDir(a), photoId))));
    await a.parent.del(`/api/media/${photoId}/link`);
    assert.equal((await raw('GET', `/m/${photoToken}`, undefined, {})).status, 404);
    // The video's link is untouched by the photo's ending.
    assert.equal((await raw('GET', `/m/${token}`, undefined, {})).status, 200);
  });

  it('a link ends after 30 days, or when a parent ends it; the kid asking again gets a new one', async () => {
    const before = (await items(a)).find((i) => i.id === videoId) as Json;
    assert.equal(before.linkShared, true);
    const days = (new Date(before.linkExpiresAt as string).getTime() - Date.now()) / 86400_000;
    assert.ok(days > 29.9 && days < 30.1, String(days));
    assert.equal((await a.phone.post('/api/android/media/v1/link', {})).body.link, link);

    // Past its date: gone for everyone, shown as not shared.
    await server.pool.query("UPDATE kid_media SET share_expires_at = now() - interval '1 minute' WHERE id = $1", [videoId]);
    assert.equal((await raw('GET', `/m/${token}`, undefined, {})).status, 404);
    assert.equal((await raw('GET', `/m/${token}/file`, undefined, {})).status, 404);
    assert.deepEqual([(await items(a)).find((i) => i.id === videoId)?.linkShared, (await items(a)).find((i) => i.id === videoId)?.linkExpiresAt], [false, null]);
    const second = (await a.phone.post('/api/android/media/v1/link', {})).body.link as string;
    assert.notEqual(second, link);
    assert.equal((await raw('GET', `/m/${token}`, undefined, {})).status, 404);
    assert.equal((await raw('GET', new URL(second).pathname, undefined, {})).status, 200);

    // A parent ends it.
    assert.deepEqual((await a.parent.del(`/api/media/${videoId}/link`)).body, { ok: true });
    assert.equal((await raw('GET', new URL(second).pathname, undefined, {})).status, 404);
    assert.equal((await raw('GET', `${new URL(second).pathname}/file`, undefined, {})).status, 404);
    assert.equal((await items(a)).find((i) => i.id === videoId)?.linkShared, false);
    // The copy itself is still there for the parents.
    assert.equal((await a.parent.get(`/api/media/${videoId}/file`)).status, 200);
    const third = (await a.phone.post('/api/android/media/v1/link', {})).body.link as string;
    assert.ok(third !== second && third !== link);
  });

  it('removing the phone keeps the copies for the parents but ends what the phone could do', async () => {
    const f = await family('media-gone@example.com', 'Gus', 'machine-media-g-01');
    const up = await upload(f.phone, webm(900), videoHeaders('g1', 'Before removal'));
    const l = (await f.phone.post('/api/android/media/g1/link', {})).body.link as string;
    assert.equal((await f.parent.del(`/api/devices/${f.deviceId}`)).status, 200);
    assert.equal((await upload(f.phone, jpeg(100), photoHeaders('g2'))).status, 401);
    assert.equal((await f.phone.post('/api/android/media/g1/link', {})).status, 401);
    const list = await items(f);
    assert.deepEqual(list.map((i) => [i.id, i.deviceName]), [[up.body.id, null]]);
    assert.equal((await f.parent.get(`/api/media/${up.body.id}/file`)).status, 200);
    // The link the kid already sent still works until a parent ends it or it runs out.
    assert.equal((await raw('GET', new URL(l).pathname, undefined, {})).status, 200);
    // The same phone set up again is a phone with nothing uploaded yet: it cannot reach the old copies.
    const again = await pairPhone(server, f.parent, f.kid, 'machine-media-g-01');
    assert.equal((await again.phone.post('/api/android/media/g1/link', {})).status, 404);
  });
});

describe('when things are deleted', () => {
  it('a parent deletes one item: row, file and link are gone, the rest stays', async () => {
    const f = await family('del-one@example.com', 'Dee', 'machine-del-000001');
    const one = (await upload(f.phone, jpeg(), photoHeaders('d1'))).body.id as string;
    const two = (await upload(f.phone, webm(), videoHeaders('d2'))).body.id as string;
    const l = (await f.phone.post('/api/android/media/d2/link', {})).body.link as string;
    assert.equal((await f.parent.del(`/api/media/${two}`)).status, 200);
    assert.deepEqual(filesOf(f), [one]);
    assert.equal((await raw('GET', new URL(l).pathname, undefined, {})).status, 404);
    assert.equal((await f.parent.del(`/api/media/${two}`)).status, 404);
    assert.equal((await f.parent.get(`/api/media/${one}/file`)).status, 200);
  });

  it('removing a kid removes that kid\'s photos, videos, links and files, and nobody else\'s', async () => {
    const f = await family('del-kid@example.com', 'Kim', 'machine-del-000002');
    const other = await createKid(f.parent, 'Kit');
    const otherPhone = await pairPhone(server, f.parent, other, 'machine-del-000003');
    await upload(f.phone, jpeg(), photoHeaders('k1'));
    await upload(f.phone, webm(), videoHeaders('k2'));
    const l = (await f.phone.post('/api/android/media/k2/link', {})).body.link as string;
    const kept = (await upload(otherPhone.phone, jpeg(), photoHeaders('k1'))).body.id as string;
    assert.equal(filesOf(f).length, 2);
    assert.equal((await f.parent.del(`/api/kids/${f.kid}`)).status, 200);
    assert.equal(fs.existsSync(kidDir(f)), false);
    assert.equal((await server.pool.query('SELECT 1 FROM kid_media WHERE kid_id = $1', [f.kid])).rowCount, 0);
    assert.equal((await raw('GET', new URL(l).pathname, undefined, {})).status, 404);
    assert.equal((await f.parent.get(`/api/kids/${f.kid}/media`)).status, 404);
    assert.deepEqual(fs.readdirSync(path.join(TEST_DATA_DIR, 'kid-media', f.accountId, other)), [kept]);
  });

  it('a family that is removed leaves no files behind: housekeeping sweeps the folders nobody owns', async () => {
    const f = await family('del-family@example.com', 'Fay', 'machine-del-000004');
    const stay = await family('stay@example.com', 'Sam', 'machine-del-000005');
    await upload(f.phone, jpeg(), photoHeaders('f1'));
    await upload(f.phone, webm(), videoHeaders('f2'));
    const l = (await f.phone.post('/api/android/media/f2/link', {})).body.link as string;
    const kept = (await upload(stay.phone, jpeg(), photoHeaders('s1'))).body.id as string;
    // A picture in a text of the same family.
    await f.phone.post('/api/warden/sync', { texts: [{ id: 't1', thread: ['5550003333'], dir: 'out', body: 'pic', at: Date.now(), media: [{ id: 'm1', type: 'image/png' }] }] });
    const pic = await raw('POST', '/api/android/text-media/t1/m1', png(), { Authorization: `Bearer ${f.phone.bearer}`, 'Content-Type': 'image/png' });
    const picFile = path.join(TEST_DATA_DIR, 'text-media', pic.body.id as string);
    assert.equal(fs.existsSync(picFile), true);

    // There is no "delete my family" button yet; however a family goes, its rows go with it...
    await server.pool.query('DELETE FROM accounts WHERE id = $1', [f.accountId]);
    assert.equal((await server.pool.query('SELECT 1 FROM kid_media WHERE account_id = $1', [f.accountId])).rowCount, 0);
    assert.equal((await raw('GET', new URL(l).pathname, undefined, {})).status, 404);
    assert.equal((await f.parent.get(`/api/kids/${f.kid}/media`)).status, 401);
    // ...and the sweep takes the files. Fresh files are left alone for an hour (an upload may be under way), so the
    // sweep is asked as if it were two hours later.
    assert.equal(await sweepOrphanFiles(server.pool, TEST_DATA_DIR), 0);
    assert.equal(fs.existsSync(kidDir(f)), true);
    const removed = await sweepOrphanFiles(server.pool, TEST_DATA_DIR, Date.now() + 2 * 3600_000);
    assert.ok(removed >= 2, String(removed));
    assert.equal(fs.existsSync(kidDir(f)), false);
    assert.equal(fs.existsSync(path.join(TEST_DATA_DIR, 'kid-media', f.accountId)), false);
    assert.equal(fs.existsSync(picFile), false);
    // The other family's files are where they were.
    assert.deepEqual(filesOf(stay), [kept]);
    assert.equal((await stay.parent.get(`/api/media/${kept}/file`)).status, 200);
  });

  it('the sweep also takes files without a row and uploads that stopped half way, and nothing that is owned', async () => {
    const f = await family('sweep@example.com', 'Sue', 'machine-del-000006');
    const kept = (await upload(f.phone, jpeg(), photoHeaders('w1'))).body.id as string;
    const stray = path.join(kidDir(f), crypto.randomUUID());
    const half = path.join(kidDir(f), `${crypto.randomUUID()}.abcdef.part`);
    fs.writeFileSync(stray, 'left over');
    fs.writeFileSync(half, 'half an upload');
    await sweepOrphanFiles(server.pool, TEST_DATA_DIR, Date.now() + 2 * 3600_000);
    assert.deepEqual(filesOf(f), [kept]);
  });

  it('copies are kept 90 days, then housekeeping removes row and file', async () => {
    const f = await family('old-media@example.com', 'Olly', 'machine-del-000007');
    const old = (await upload(f.phone, jpeg(), photoHeaders('o1'))).body.id as string;
    const young = (await upload(f.phone, jpeg(), photoHeaders('o2'))).body.id as string;
    await server.pool.query("UPDATE kid_media SET created_at = now() - interval '89 days' WHERE id = $1", [old]);
    await purgeExpired(server.pool, TEST_DATA_DIR);
    assert.equal(filesOf(f).length, 2);
    await server.pool.query("UPDATE kid_media SET created_at = now() - interval '91 days' WHERE id = $1", [old]);
    await purgeExpired(server.pool, TEST_DATA_DIR);
    assert.deepEqual(filesOf(f), [young]);
    assert.deepEqual((await items(f)).map((i) => i.id), [young]);
    assert.equal((await f.parent.get(`/api/media/${old}/file`)).status, 404);
  });
});

describe('walls: texts', () => {
  let a: Fam;
  let b: Fam;
  let sibling: { kid: string; phone: Client; deviceId: string };
  const now = Date.now();

  before(async () => {
    a = await family('texts-a@example.com', 'Ann', 'machine-texts-a-01');
    b = await family('texts-b@example.com', 'Ben', 'machine-texts-b-01');
    const kid = await createKid(a.parent, 'Abe');
    sibling = { kid, ...(await pairPhone(server, a.parent, kid, 'machine-texts-a-02')) };
    await a.parent.post(`/api/kids/${a.kid}/contacts`, { name: 'Mom', phone: '(555) 010-2231', always: true });
    await a.phone.post('/api/warden/sync', {
      texts: [
        { id: 'm1', thread: ['5550102231'], dir: 'in', from: '5550102231', body: 'Ann\'s private words', at: now - 2000, media: [{ id: 'p1', type: 'image/png' }] },
        { id: 'm2', thread: ['5550102231'], dir: 'out', body: 'Ann answers', at: now - 1000 },
        { id: 'm3', thread: ['5550198888'], dir: 'in', from: '5550198888', body: 'a stranger to Ann', at: now, status: 'held' },
      ],
    });
  });

  it('copies of texts are kept per kid: a sister\'s or brother\'s page and phone show none of them', async () => {
    const ann = (await a.parent.get(`/api/kids/${a.kid}/texts`)).body;
    assert.deepEqual([ann.threads.length, ann.held.length], [1, 1]);
    const abe = (await a.parent.get(`/api/kids/${sibling.kid}/texts`)).body;
    assert.deepEqual([abe.threads, abe.held, abe.blocked], [[], [], []]);
    assert.deepEqual((await a.parent.get(`/api/kids/${sibling.kid}/texts/thread?t=5550102231`)).body.texts, []);
    // The same text ids from the sibling's phone are the sibling's own texts.
    await sibling.phone.post('/api/warden/sync', { texts: [{ id: 'm1', thread: ['5550107777'], dir: 'out', body: 'Abe writes', at: now }] });
    const thread = (await a.parent.get(`/api/kids/${a.kid}/texts/thread?t=5550102231`)).body;
    assert.deepEqual(thread.texts.map((t: Json) => t.body), ['Ann\'s private words', 'Ann answers']);
    assert.deepEqual((await a.parent.get(`/api/kids/${sibling.kid}/texts`)).body.threads.map((t: Json) => t.last.body), ['Abe writes']);
  });

  it('another family cannot read the chats, the held texts or a photo, nor block, unblock or delete anything', async () => {
    const pic = await raw('POST', '/api/android/text-media/m1/p1', png(), { Authorization: `Bearer ${a.phone.bearer}`, 'Content-Type': 'image/png' });
    assert.equal(pic.status, 201, pic.text);
    const held = (await a.parent.get(`/api/kids/${a.kid}/texts`)).body.held[0];
    await a.parent.post(`/api/kids/${a.kid}/blocked-numbers`, { phone: '555 019 0000' });
    const P = b.parent;
    const tries: Array<[string, Promise<Reply>]> = [
      ['texts', P.get(`/api/kids/${a.kid}/texts`)],
      ['thread', P.get(`/api/kids/${a.kid}/texts/thread?t=5550102231`)],
      ['photo', P.get(`/api/text-media/${pic.body.id}`)],
      ['delete held', P.post(`/api/texts/${held.id}/delete`)],
      ['block', P.post(`/api/kids/${a.kid}/blocked-numbers`, { phone: '5550102231' })],
      ['unblock', P.del(`/api/kids/${a.kid}/blocked-numbers/5550190000`)],
    ];
    for (const [what, p] of tries) assert.equal((await p).status, 404, what);
    const anon = new Client(server.url);
    for (const p of [`/api/kids/${a.kid}/texts`, `/api/kids/${a.kid}/texts/thread?t=5550102231`, `/api/text-media/${pic.body.id}`]) assert.equal((await anon.get(p)).status, 401, p);
    // Family B, asking for its own kid with family A's thread name, gets its own (empty) chat.
    assert.deepEqual((await P.get(`/api/kids/${b.kid}/texts/thread?t=5550102231`)).body.texts, []);
    // Nothing of A changed.
    const still = (await a.parent.get(`/api/kids/${a.kid}/texts`)).body;
    assert.deepEqual([still.held.length, still.blocked.map((x: Json) => x.num)], [1, ['5550190000']]);
    // The photo: the family's own parent sees it, as a picture and nothing else.
    const mine = await raw('GET', `/api/text-media/${pic.body.id}`, undefined, { cookie: a.parent.cookie });
    assert.deepEqual(
      [mine.status, mine.headers.get('content-type'), mine.headers.get('x-content-type-options'), mine.headers.get('content-security-policy')],
      [200, 'image/png', 'nosniff', "default-src 'none'; sandbox"],
    );
  });

  it('a phone only gets its own kid\'s texting rules and cannot touch another phone\'s texts', async () => {
    await a.phone.post('/api/android/friend', { name: 'Ava', phone: '555-014-2290', note: 'In my class' });
    const held = (await a.parent.get(`/api/kids/${a.kid}/texts`)).body.held[0];
    await a.parent.post(`/api/texts/${held.id}/delete`);
    const mine = (await a.phone.post('/api/warden/sync', {})).body.texting;
    assert.deepEqual([mine.asked, mine.blocked, mine.drop], [[{ name: 'Ava', phone: '5550142290', status: 'pending' }], ['5550190000'], ['m3']]);
    for (const [who, phone] of [['sibling', sibling.phone], ['other family', b.phone]] as Array<[string, Client]>) {
      const t = (await phone.post('/api/warden/sync', {})).body;
      assert.deepEqual(t.texting, { friends: [], asked: [], blocked: [], drop: [], who: 'friends' }, who);
      assert.deepEqual(t.phone.contacts, [], who);
      // Sending Ann's text ids with other words changes nothing of Ann's.
      await phone.post('/api/warden/sync', { texts: [{ id: 'm2', thread: ['5550102231'], dir: 'out', body: 'overwritten?', at: now, status: 'held' }] });
      // A photo sent for Ann's text id from another phone is that phone's own photo, never shown in Ann's chat.
      const up = await raw('POST', '/api/android/text-media/m1/p1', png(64), { Authorization: `Bearer ${phone.bearer}`, 'Content-Type': 'image/png' });
      assert.equal(up.status, 201, who);
    }
    const thread = (await a.parent.get(`/api/kids/${a.kid}/texts/thread?t=5550102231`)).body;
    assert.deepEqual(thread.texts.map((t: Json) => [t.body, t.status]), [['Ann\'s private words', 'shown'], ['Ann answers', 'shown']]);
    const shown = await raw('GET', thread.texts[0].media[0].url, undefined, { cookie: a.parent.cookie });
    assert.equal(shown.bytes.length, 2008);
    // There is nothing a phone can read back about texts: the routes are for parents.
    assert.equal((await a.phone.get(`/api/kids/${a.kid}/texts`)).status, 401);
    assert.equal((await a.phone.get(`/api/text-media/${thread.texts[0].media[0].id}`)).status, 401);
  });

  it('a friend request shows the parent what the kid wrote; yes makes a friend the phone hears about, for that kid only', async () => {
    const req = (await a.parent.get('/api/requests')).body.requests.find((r: Json) => r.kind === 'contact');
    assert.deepEqual([req.detail, req.identifier, req.phone, req.note, req.kidId], ['Ava', '5550142290', '555-014-2290', 'In my class', a.kid]);
    assert.deepEqual((await b.parent.get('/api/requests?status=all')).body.requests, []);
    assert.equal((await b.parent.post(`/api/requests/${req.id}/decide`, { approve: true })).status, 404);
    assert.equal((await a.parent.post(`/api/requests/${req.id}/decide`, { approve: true })).status, 200);
    assert.deepEqual((await a.phone.post('/api/warden/sync', {})).body.texting.friends.map((x: Json) => [x.name, x.phone]), [['Ava', '5550142290']]);
    assert.deepEqual((await sibling.phone.post('/api/warden/sync', {})).body.texting.friends, []);
    assert.deepEqual((await b.phone.post('/api/warden/sync', {})).body.texting.friends, []);
    // Asking again says so; a number of the family list says so too.
    assert.equal((await a.phone.post('/api/android/friend', { name: 'Ava', phone: '(555) 014-2290' })).body.status, 'approved');
    assert.equal((await a.phone.post('/api/android/friend', { name: 'Mum', phone: '+1 555 010 2231' })).body.status, 'approved');
    // A note that is too long is refused, not cut silently into something else.
    assert.equal((await a.phone.post('/api/android/friend', { name: 'Zed', phone: '5550110000', note: 'x'.repeat(201) })).status, 400);
  });

  it('pictures in texts: only what a picture text can carry, checked by its first bytes, never sent back as a page', async () => {
    const send = (id: string, body: Buffer, type: string): Promise<Reply> =>
      raw('POST', `/api/android/text-media/m9/${id}`, body, { Authorization: `Bearer ${a.phone.bearer}`, 'Content-Type': type });
    const page = Buffer.from('<html><script>alert(1)</script></html>');
    assert.equal((await send('x1', page, 'text/html')).status, 415);
    assert.equal((await send('x2', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'image/svg+xml')).status, 415);
    assert.equal((await send('x3', page, 'image/png')).status, 415);
    assert.equal((await send('x4', page, 'image/jpeg')).status, 415);
    assert.equal((await send('x5', page, 'video/mp4')).status, 415);
    assert.equal((await send('x6', page, 'application/pdf')).status, 415);
    assert.equal((await send('x7', Buffer.alloc(0), 'image/png')).status, 400);
    assert.equal((await send('x8', Buffer.concat([png(), Buffer.alloc(8 * 1024 * 1024)]), 'image/png')).status, 413);
    assert.equal((await server.pool.query("SELECT 1 FROM text_media WHERE phone_msg_id = 'm9'")).rowCount, 0);
    // A sound clip is kept, and only ever handed out as a download.
    const amr = Buffer.concat([Buffer.from('#!AMR\n'), crypto.randomBytes(300)]);
    const sound = await send('s1', amr, 'audio/amr');
    assert.equal(sound.status, 201, sound.text);
    const got = await raw('GET', `/api/text-media/${sound.body.id}`, undefined, { cookie: a.parent.cookie });
    assert.deepEqual([got.status, got.headers.get('content-type'), got.headers.get('content-disposition')], [200, 'application/octet-stream', 'attachment; filename="file.bin"']);
    // Odd ids in the address are text, not paths.
    const odd = await raw('POST', '/api/android/text-media/..%2F..%2Fx/..%2F..%2Fy', png(), { Authorization: `Bearer ${a.phone.bearer}`, 'Content-Type': 'image/png' });
    assert.equal(odd.status, 201);
    assert.match(odd.body.id, UUID);
    assert.equal(fs.existsSync(path.join(TEST_DATA_DIR, 'text-media', odd.body.id)), true);
  });

  it('removing a kid removes the texts and their pictures', async () => {
    const f = await family('texts-del@example.com', 'Tia', 'machine-texts-d-01');
    await f.phone.post('/api/warden/sync', { texts: [{ id: 'd1', thread: ['5550004444'], dir: 'out', body: 'bye', at: now, media: [{ id: 'dp1', type: 'image/png' }] }] });
    const pic = await raw('POST', '/api/android/text-media/d1/dp1', png(), { Authorization: `Bearer ${f.phone.bearer}`, 'Content-Type': 'image/png' });
    const file = path.join(TEST_DATA_DIR, 'text-media', pic.body.id as string);
    assert.equal(fs.existsSync(file), true);
    assert.equal((await f.parent.del(`/api/kids/${f.kid}`)).status, 200);
    assert.equal(fs.existsSync(file), false);
    assert.equal((await server.pool.query('SELECT 1 FROM texts WHERE kid_id = $1', [f.kid])).rowCount, 0);
    assert.equal((await server.pool.query('SELECT 1 FROM text_media WHERE kid_id = $1', [f.kid])).rowCount, 0);
  });
});

describe('the built console and share links', () => {
  it('with the console served, /m/<token> is still the watch page (never the console) and a wrong link is a plain 404', async () => {
    const dist = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'web-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<html><body>the console</body></html>');
    const withWeb = await startServer({ BILLING_ENABLED: '', SESSION_SECRET: SECRET, WEB_DIST: dist });
    try {
      const f = await family('web@example.com', 'Wes', 'machine-web-000001', withWeb);
      await upload(f.phone, webm(), videoHeaders('w1', 'On the web'), withWeb.url);
      const l = (await f.phone.post('/api/android/media/w1/link', {})).body.link as string;
      const page = await raw('GET', new URL(l).pathname, undefined, {}, withWeb.url);
      assert.ok(page.status === 200 && page.text.includes('On the web') && !page.text.includes('the console'));
      const miss = await raw('GET', '/m/nothing-here', undefined, {}, withWeb.url);
      assert.ok(miss.status === 404 && !miss.text.includes('the console'));
      assert.equal((await raw('GET', '/m', undefined, {}, withWeb.url)).status, 404);
      // The console's own pages are still served.
      assert.ok((await raw('GET', `/kids/${f.kid}/photos`, undefined, {}, withWeb.url)).text.includes('the console'));
    } finally {
      await withWeb.close();
    }
  });
});
