/**
 * Demo data: one family (demo@example.com) with two kids, three devices, apps, contacts,
 * a week of usage, two waiting requests, a few blocked sites, chores and family chat.
 * Safe to run again: it removes the demo family first and builds it fresh.
 */
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { loadConfig } from './config';
import { sha256Hex, randomToken } from './crypto';
import { createPool, migrate, withTransaction } from './db';
import { addDays, localTime } from './rules';

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

export async function seed(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await migrate(pool);
    await withTransaction(pool, async (db) => {
      await db.query('DELETE FROM login_tokens WHERE email = $1', [DEMO_EMAIL]);
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
    });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  seed(loadConfig().databaseUrl)
    .then(() => {
      console.log(`Demo family ready. Sign in as ${DEMO_EMAIL} (start the server with DEV_LINKS=1 to get the link in the response).`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
