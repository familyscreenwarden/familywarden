/**
 * Demo data: one family (demo@example.com) with two kids, three devices, apps, contacts,
 * a week of usage, waiting requests, a few blocked sites, chores, family chat, and, for the kid with a phone,
 * texts, photos and videos (only when a data folder is given, because they need files).
 * Safe to run again: it removes the demo family first and builds it fresh.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { PoolClient } from 'pg';
import { loadConfig } from './config';
import { sha256Hex, randomToken } from './crypto';
import { createPool, migrate, withTransaction } from './db';
import { mediaFile } from './files';
import { kidMediaFile, shareToken, shareTokenHash } from './media';
import { addDays, localTime } from './rules';
import { DEMO_WEBM_BASE64 } from './seed-media';

export const DEMO_EMAIL = 'demo@example.com';
const TIMEZONE = 'America/Denver';

async function one(db: PoolClient, sql: string, params: unknown[]): Promise<string> {
  const res = await db.query<{ id: string }>(sql, params);
  const id = res.rows[0]?.id;
  if (!id) throw new Error('Insert returned no id');
  return id;
}

interface SeedApp {
  kind: 'app' | 'site';
  platform: 'windows' | 'android' | 'any';
  identifier: string;
  name: string;
  allowed?: boolean;
  free?: boolean;
  limit?: number;
}

/** A small picture for the demo: two colours fading into each other with a lighter disc, as a real PNG file. */
export function demoPng(width: number, height: number, from: [number, number, number], to: [number, number, number]): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  const cx = width * 0.7;
  const cy = height * 0.3;
  const radius = Math.min(width, height) * 0.16;
  for (let y = 0; y < height; y++) {
    const line = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const disc = Math.hypot(x - cx, y - cy) < radius ? 60 : 0;
      for (let c = 0; c < 3; c++) rows[line + 1 + x * 3 + c] = Math.min(255, Math.round((from[c] ?? 0) * (1 - t) + (to[c] ?? 0) * t) + disc);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export interface SeedFiles {
  /** DATA_DIR: where the demo photos and videos are written. */
  dataDir: string;
  /** SESSION_SECRET of the server that will serve the demo, so the demo share link works there. */
  sessionSecret: string;
  publicUrl: string;
}

export async function seed(databaseUrl: string, files?: SeedFiles): Promise<void> {
  const pool = createPool(databaseUrl);
  const toWrite: Array<{ file: string; data: Buffer }> = [];
  let demoLink = '';
  try {
    await migrate(pool);
    await withTransaction(pool, async (db) => {
      await db.query('DELETE FROM login_tokens WHERE email = $1', [DEMO_EMAIL]);
      const before = await db.query<{ id: string }>('SELECT id FROM accounts WHERE email = $1', [DEMO_EMAIL]);
      const oldPics = await db.query<{ id: string }>('SELECT m.id FROM text_media m JOIN accounts a ON a.id = m.account_id WHERE a.email = $1', [DEMO_EMAIL]);
      if (files) {
        for (const a of before.rows) fs.rmSync(path.join(files.dataDir, 'kid-media', a.id), { recursive: true, force: true });
        for (const m of oldPics.rows) fs.rmSync(mediaFile(files.dataDir, m.id), { force: true });
      }
      await db.query('DELETE FROM accounts WHERE email = $1', [DEMO_EMAIL]); // cascades to everything the family owns

      const accountId = await one(
        db,
        "INSERT INTO accounts (email, timezone, plan, trial_ends_at) VALUES ($1, $2, 'trial', now() + interval '30 days') RETURNING id",
        [DEMO_EMAIL, TIMEZONE],
      );
      const today = localTime(new Date(), TIMEZONE).day;

      const max = await one(
        db,
        "INSERT INTO kids (account_id, name, color, limit_school_minutes, limit_weekend_minutes, created_at) VALUES ($1, 'Max', '#34d399', 120, 180, now() - interval '20 days') RETURNING id",
        [accountId],
      );
      const ava = await one(
        db,
        "INSERT INTO kids (account_id, name, color, limit_school_minutes, limit_weekend_minutes, bed_school_start, created_at) VALUES ($1, 'Ava', '#6f82de', 90, 150, '20:00', now() - interval '19 days') RETURNING id",
        [accountId],
      );

      const device = (kid: string, name: string, platform: string, model: string, os: string, seenAgo: string, front: string | null, addedAgo: string): Promise<string> =>
        one(
          db,
          `INSERT INTO devices (account_id, kid_id, name, platform, model, os_version, app_version, token_hash, last_seen_at, front_app, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, '1.0.0', $7, now() - $8::interval, $9, now() - $10::interval) RETURNING id`,
          [accountId, kid, name, platform, model, os, sha256Hex(randomToken()), seenAgo, front, addedAgo],
        );
      const maxPc = await device(max, "Max's PC", 'windows', 'Dell Inspiron 15', 'Windows 11', '20 seconds', 'Minecraft', '18 days');
      const avaPhone = await device(ava, "Ava's phone", 'android', 'Samsung Galaxy A15', 'Android 14', '50 seconds', null, '17 days');
      const laptop = await device(max, 'Family laptop', 'windows', 'Lenovo IdeaPad 3', 'Windows 10', '2 days', null, '10 days');

      const addApps = async (kid: string, apps: SeedApp[]): Promise<Record<string, string>> => {
        const ids: Record<string, string> = {};
        for (const a of apps) {
          ids[a.name] = await one(
            db,
            `INSERT INTO apps (account_id, kid_id, kind, platform, identifier, name, allowed, free, limit_minutes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [accountId, kid, a.kind, a.platform, a.identifier, a.name, a.allowed ?? true, a.free ?? false, a.limit ?? null],
          );
        }
        return ids;
      };
      const maxApps = await addApps(max, [
        { kind: 'app', platform: 'windows', identifier: 'minecraft.exe', name: 'Minecraft', limit: 60 },
        { kind: 'app', platform: 'windows', identifier: 'scratch 3.exe', name: 'Scratch', free: true },
        { kind: 'site', platform: 'any', identifier: 'khanacademy.org', name: 'Khan Academy', free: true },
        { kind: 'site', platform: 'any', identifier: 'youtube.com', name: 'YouTube', limit: 30 },
        { kind: 'site', platform: 'any', identifier: 'wikipedia.org', name: 'Wikipedia' },
        { kind: 'app', platform: 'windows', identifier: 'steam.exe', name: 'Steam', allowed: false },
      ]);
      const avaApps = await addApps(ava, [
        { kind: 'app', platform: 'android', identifier: 'com.google.android.apps.youtube.kids', name: 'YouTube Kids', limit: 30 },
        { kind: 'app', platform: 'android', identifier: 'com.android.chrome', name: 'Chrome' },
        { kind: 'app', platform: 'android', identifier: 'org.khanacademy.android', name: 'Khan Academy Kids', free: true },
        { kind: 'app', platform: 'android', identifier: 'com.toca.life.world', name: 'Toca Life World' },
        { kind: 'site', platform: 'any', identifier: 'pbskids.org', name: 'PBS Kids' },
        { kind: 'app', platform: 'android', identifier: 'com.zhiliaoapp.musically', name: 'TikTok', allowed: false },
      ]);

      const contact = (kid: string, name: string, phone: string, canText: boolean): Promise<unknown> =>
        db.query('INSERT INTO contacts (account_id, kid_id, name, phone, can_call, can_text) VALUES ($1, $2, $3, $4, true, $5)', [
          accountId,
          kid,
          name,
          phone,
          canText,
        ]);
      for (const kid of [max, ava]) {
        await contact(kid, 'Mom', '+1 555 010 0101', true);
        await contact(kid, 'Dad', '+1 555 010 0102', true);
        await contact(kid, 'Grandma', '+1 555 010 0103', false);
      }

      // A week of usage: index 0 is six days ago, index 6 is today. Fixed numbers, so the charts look the same every run.
      const usage = async (kid: string, dev: string, app: string | undefined, perDay: number[]): Promise<void> => {
        if (!app) throw new Error('Seed app is missing');
        for (let i = 0; i < perDay.length; i++) {
          const minutes = perDay[i] ?? 0;
          if (minutes <= 0) continue;
          await db.query('INSERT INTO usage (kid_id, device_id, app_id, day, minutes) VALUES ($1, $2, $3, $4, $5)', [
            kid,
            dev,
            app,
            addDays(today, i - (perDay.length - 1)),
            minutes,
          ]);
        }
      };
      await usage(max, maxPc, maxApps['Minecraft'], [55, 60, 40, 60, 58, 45, 48]);
      await usage(max, maxPc, maxApps['YouTube'], [20, 0, 30, 25, 30, 10, 12]);
      await usage(max, maxPc, maxApps['Wikipedia'], [10, 25, 0, 15, 40, 30, 18]);
      await usage(max, maxPc, maxApps['Scratch'], [0, 30, 15, 0, 25, 0, 20]);
      await usage(max, maxPc, maxApps['Khan Academy'], [15, 0, 20, 10, 0, 0, 10]);
      await usage(max, laptop, maxApps['Wikipedia'], [0, 0, 12, 0, 20, 0, 0]);
      await usage(ava, avaPhone, avaApps['YouTube Kids'], [30, 25, 30, 20, 30, 28, 30]);
      await usage(ava, avaPhone, avaApps['Chrome'], [15, 20, 10, 25, 35, 20, 25]);
      await usage(ava, avaPhone, avaApps['Toca Life World'], [25, 30, 35, 20, 60, 40, 35]);
      await usage(ava, avaPhone, avaApps['Khan Academy Kids'], [10, 0, 15, 0, 10, 0, 12]);

      await db.query(
        `INSERT INTO requests (account_id, kid_id, device_id, kind, minutes, detail, identifier, created_at) VALUES
           ($1, $2, $3, 'time', 15, '', NULL, now() - interval '2 minutes'),
           ($1, $4, $5, 'app', NULL, 'Duolingo', 'com.duolingo', now() - interval '40 minutes')`,
        [accountId, max, maxPc, ava, avaPhone],
      );
      await db.query(
        `INSERT INTO requests (account_id, kid_id, device_id, kind, minutes, detail, status, created_at, decided_at)
         VALUES ($1, $2, $3, 'time', 30, '', 'denied', now() - interval '2 days', now() - interval '2 days' + interval '5 minutes')`,
        [accountId, max, maxPc],
      );

      // ---- what phones add: battery, chores, family chat ----
      await db.query(
        `UPDATE devices SET machine_id = 'demo-phone-0001', unlock_secret = $2, paired_at = now() - interval '17 days',
                info = '{"battery": 72, "charging": false, "deviceOwner": true, "usageAccess": true}'::jsonb
          WHERE id = $1`,
        [avaPhone, crypto.randomBytes(32).toString('base64')],
      );
      await db.query("UPDATE contacts SET always = false WHERE account_id = $1 AND name = 'Grandma'", [accountId]);
      const chore = (kid: string, name: string, minutes: number, repeat: string): Promise<string> =>
        one(db, 'INSERT INTO chores (account_id, kid_id, name, minutes, repeat) VALUES ($1, $2, $3, $4, $5) RETURNING id', [accountId, kid, name, minutes, repeat]);
      const dishes = await chore(ava, 'Empty the dishwasher', 15, 'daily');
      const room = await chore(ava, 'Tidy your room', 20, 'weekly');
      await chore(ava, 'Help wash the car', 30, 'once');
      const trash = await chore(max, 'Take out the trash', 10, 'daily');
      await db.query(
        `INSERT INTO chore_completions (account_id, chore_id, kid_id, device_id, day, minutes, status, created_at, decided_at, decided_day) VALUES
           ($1, $2, $3, $4, $5, 15, 'pending', now() - interval '12 minutes', NULL, NULL),
           ($1, $6, $3, $4, $7, 20, 'approved', now() - interval '1 day', now() - interval '23 hours', $7),
           ($1, $8, $9, NULL, $5, 10, 'pending', now() - interval '50 minutes', NULL, NULL)`,
        [accountId, dishes, ava, avaPhone, today, room, addDays(today, -1), trash, max],
      );
      await db.query(
        `INSERT INTO family_chat (account_id, kid_id, text, created_at) VALUES
           ($1, $2, 'Can we have tacos tonight?', now() - interval '3 hours'),
           ($1, NULL, 'Yes. Dinner is at six.', now() - interval '2 hours 50 minutes'),
           ($1, $3, 'I finished my homework', now() - interval '40 minutes')`,
        [accountId, ava, max],
      );
      // ---- texts on Ava's phone: family, a friend, a number that is not on the list, a friend she asks for ----
      // (With the photos and videos below, these need files: they are only made when a data folder is given.)
      if (files) {
        await db.query("INSERT INTO contacts (account_id, kid_id, name, phone, can_call, can_text, always) VALUES ($1, $2, 'Zoe', '555 014 0164', false, true, false)", [accountId, ava]);
        await db.query(
          `INSERT INTO requests (account_id, kid_id, device_id, kind, detail, identifier, phone, note, created_at)
           VALUES ($1, $2, $3, 'contact', 'Lily', '5550142290', '555-014-2290', 'She is in my class', now() - interval '25 minutes')`,
          [accountId, ava, avaPhone],
        );
        const MOM = '5550100101';
        const DAD = '5550100102';
        const ZOE = '5550140164';
        const STRANGER = '5550197733';
        const text = (phoneId: string, parts: string[], dir: 'in' | 'out', from: string | null, body: string, ago: string, status = 'shown', media: Array<{ id: string; type: string }> = []): Promise<unknown> =>
          db.query(
            `INSERT INTO texts (account_id, kid_id, device_id, phone_id, thread, participants, dir, from_num, body, media, status, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, now() - $12::interval)`,
            [accountId, ava, avaPhone, phoneId, [...parts].sort().join(','), [...parts].sort(), dir, from, body, JSON.stringify(media), status, ago],
          );
        await text('t1', [MOM], 'in', MOM, 'Pick you up at 3 today', '5 hours');
        await text('t2', [MOM], 'out', null, 'Ok! Can Zoe come over after?', '4 hours 58 minutes');
        await text('t3', [MOM], 'in', MOM, 'Sure, if her mom says yes.', '4 hours 55 minutes');
        await text('t4', [MOM], 'out', null, 'Look what I drew', '2 hours', 'shown', [{ id: 'p1', type: 'image/png' }]);
        await text('t5', [MOM], 'in', MOM, 'I love it! Put it on the fridge.', '1 hour 55 minutes');
        await text('t6', [MOM, DAD], 'in', DAD, 'Who wants tacos tonight?', '3 hours');
        await text('t7', [MOM, DAD], 'out', null, 'Me!!', '2 hours 59 minutes');
        await text('t8', [MOM, DAD], 'in', MOM, 'Tacos it is. Dinner at six.', '2 hours 50 minutes');
        await text('t9', [ZOE], 'in', ZOE, 'Did you finish the math sheet?', '1 day 2 hours');
        await text('t10', [ZOE], 'out', null, 'Almost. Number 7 is hard', '1 day 1 hour');
        await text('t11', [ZOE], 'in', ZOE, 'Good night!', '20 hours', 'waiting');
        await text('t12', [STRANGER], 'in', STRANGER, 'hey is this ava? its jake from the bus', '35 minutes', 'held');
        const picId = await one(
          db,
          `INSERT INTO text_media (account_id, kid_id, device_id, phone_msg_id, phone_media_id, type, size) VALUES ($1, $2, $3, 't4', 'p1', 'image/png', $4) RETURNING id`,
          [accountId, ava, avaPhone, 1],
        );
        const drawing = demoPng(360, 270, [251, 191, 36], [248, 113, 113]);
        await db.query('UPDATE text_media SET size = $2 WHERE id = $1', [picId, drawing.length]);
        toWrite.push({ file: mediaFile(files.dataDir, picId), data: drawing });
        await db.query("INSERT INTO blocked_numbers (account_id, kid_id, num, phone) VALUES ($1, $2, '5550199000', '(555) 019-9000')", [accountId, ava]);

        // ---- photos, videos and a movie from Ava's phone ----
        const clip = Buffer.from(DEMO_WEBM_BASE64, 'base64');
        const shots: Array<{ phoneId: string; kind: 'photo' | 'video' | 'movie'; title: string; ago: string; data: Buffer; type: string; seconds: number; deleted?: boolean; shared?: boolean }> = [
          { phoneId: 'mov-1', kind: 'movie', title: 'Lego heist', ago: '3 hours', data: clip, type: 'video/webm', seconds: 3, shared: true },
          { phoneId: 'cam-7', kind: 'photo', title: 'Our dog Pickles', ago: '5 hours', data: demoPng(480, 360, [52, 211, 153], [79, 97, 184]), type: 'image/png', seconds: 0 },
          { phoneId: 'cam-6', kind: 'photo', title: '', ago: '1 day 3 hours', data: demoPng(360, 480, [111, 130, 222], [251, 113, 133]), type: 'image/png', seconds: 0 },
          { phoneId: 'vid-2', kind: 'video', title: 'Trampoline flip', ago: '1 day 6 hours', data: clip, type: 'video/webm', seconds: 3 },
          { phoneId: 'cam-5', kind: 'photo', title: 'Sunset at the lake', ago: '2 days', data: demoPng(480, 320, [251, 191, 36], [31, 111, 86]), type: 'image/png', seconds: 0 },
          { phoneId: 'cam-4', kind: 'photo', title: '', ago: '3 days 4 hours', data: demoPng(400, 400, [45, 212, 191], [20, 27, 63]), type: 'image/png', seconds: 0, deleted: true },
          { phoneId: 'cam-3', kind: 'photo', title: 'My Lego city', ago: '6 days', data: demoPng(480, 360, [248, 113, 113], [79, 97, 184]), type: 'image/png', seconds: 0 },
        ];
        for (const shot of shots) {
          const id = crypto.randomUUID();
          const nonce = shot.shared ? crypto.randomBytes(18).toString('base64url') : null;
          const token = nonce ? shareToken(files.sessionSecret, id, nonce) : null;
          await db.query(
            `INSERT INTO kid_media (id, account_id, kid_id, device_id, phone_id, kind, title, type, size, duration_sec, at, created_at, deleted_on_phone_at,
                                    share_token_hash, share_nonce, share_expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - $11::interval, now() - $11::interval,
                     CASE WHEN $12 THEN now() - interval '1 day' END, $13, $14, CASE WHEN $13::text IS NOT NULL THEN now() + interval '29 days' END)`,
            [id, accountId, ava, avaPhone, shot.phoneId, shot.kind, shot.title, shot.type, shot.data.length, shot.seconds, shot.ago, shot.deleted === true,
              token ? shareTokenHash(token) : null, token ? nonce : null],
          );
          toWrite.push({ file: kidMediaFile(files.dataDir, accountId, ava, id), data: shot.data });
          if (token) demoLink = `${files.publicUrl}/m/${token}`;
        }
      }

      const blocked: Array<[string, string, string, string]> = [
        [max, maxPc, 'coolmathgames.com', '3 hours'],
        [max, maxPc, 'twitch.tv', '1 day 2 hours'],
        [max, maxPc, 'twitch.tv', '1 day 3 hours'],
        [max, maxPc, 'reddit.com', '3 days 5 hours'],
        [ava, avaPhone, 'tiktok.com', '2 days 1 hour'],
        [ava, avaPhone, 'roblox.com', '4 days 4 hours'],
      ];
      for (const [kid, dev, host, ago] of blocked) {
        await db.query('INSERT INTO blocked_events (account_id, kid_id, device_id, host, at) VALUES ($1, $2, $3, $4, now() - $5::interval)', [
          accountId,
          kid,
          dev,
          host,
          ago,
        ]);
      }

      // ---- levels and safe browsing: Ava is on "Big kid" with her own time limits; Max keeps his sites-only list ----
      await db.query(
        `UPDATE kids SET level = 'big', birthday = (current_date - interval '10 years 2 months')::date, web_mode = 'filtered', only_allowed_sites = false,
                web_categories = '{adult,gambling,violence,proxies,social,chat}', web_blocked = '{omegle.com}', texting_who = 'friends'
          WHERE id = $1`,
        [ava],
      );
      for (const [host, ago] of [['tiktok.com', '40 minutes'], ['discord.com', '2 hours'], ['poki.com', '5 hours']] as const) {
        await db.query('INSERT INTO blocked_events (account_id, kid_id, device_id, host, at) VALUES ($1, $2, $3, $4, now() - $5::interval)', [accountId, ava, avaPhone, host, ago]);
      }

      // ---- the live map: two places, Ava's way home from school this afternoon, a check-in ----
      const school = { lat: 39.7392, lng: -104.9903 };
      const home = { lat: 39.7508, lng: -104.9767 };
      const places = await db.query<{ id: string; name: string }>(
        `INSERT INTO family_places (account_id, name, lat, lng, radius_m) VALUES ($1, 'School', $2, $3, 150), ($1, 'Home', $4, $5, 100) RETURNING id, name`,
        [accountId, school.lat, school.lng, home.lat, home.lng],
      );
      const placeId = (name: string): string | null => places.rows.find((p) => p.name === name)?.id ?? null;
      await db.query("INSERT INTO kid_location_settings (kid_id, account_id) VALUES ($1, $2)", [ava, accountId]);
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // A slightly bent line from school to home, the newest point a minute ago.
        const lat = school.lat + (home.lat - school.lat) * t + Math.sin(t * Math.PI) * 0.0012;
        const lng = school.lng + (home.lng - school.lng) * t - Math.sin(t * Math.PI) * 0.0015;
        await db.query(
          `INSERT INTO kid_locations (account_id, kid_id, device_id, lat, lng, accuracy, battery, charging, at, place_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false, now() - make_interval(mins => $8), $9)`,
          [accountId, ava, avaPhone, lat, lng, i === steps ? 18 : 12, 71 - Math.floor(i / 5), (steps - i) * 3 + 1, i === 0 ? placeId('School') : i === steps ? placeId('Home') : null],
        );
      }
      await db.query(
        `INSERT INTO kid_place_events (account_id, kid_id, place_id, place_name, kind, at) VALUES
           ($1, $2, $3, 'School', 'leave', now() - interval '40 minutes'), ($1, $2, $4, 'Home', 'arrive', now() - interval '2 minutes')`,
        [accountId, ava, placeId('School'), placeId('Home')],
      );
      await db.query("INSERT INTO kid_place_state (kid_id, place_id, inside, since) VALUES ($1, $2, true, now() - interval '2 minutes')", [ava, placeId('Home')]);
      await db.query("INSERT INTO kid_checkins (account_id, kid_id, device_id, kind, lat, lng, at) VALUES ($1, $2, $3, 'ok', $4, $5, now() - interval '1 minute')", [
        accountId, ava, avaPhone, home.lat, home.lng,
      ]);
    });
    // The rows are in: now the files they point at.
    for (const f of toWrite) {
      fs.mkdirSync(path.dirname(f.file), { recursive: true });
      fs.writeFileSync(f.file, f.data);
    }
    if (demoLink) console.log(`Demo share link (works on a server with the same SESSION_SECRET): ${demoLink}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const config = loadConfig();
  seed(config.databaseUrl, { dataDir: config.dataDir, sessionSecret: config.sessionSecret, publicUrl: config.publicUrl })
    .then(() => {
      console.log(`Demo family ready. Sign in as ${DEMO_EMAIL} (start the server with DEV_LINKS=1 to get the link in the response).`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
