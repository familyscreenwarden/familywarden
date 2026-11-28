/**
 * The kid-device API: what the kids' Android app (and, later, the Windows app) speaks.
 *
 *   /api/warden    setup/check, sync, launcher, launcher/act, pin, redeem     (shared by phones and PCs)
 *   /api/android   pair, request, friend, apk/:installId, download, get, text-media/:msgId/:mediaId,
 *                  media and media/:phoneId/deleted|link|family-screen (routes/media.ts)
 *
 * Words in the JSON and what they are here: "member" = kid, "computer" = device, setup code = pairing code,
 * app "key" = the id of the app's row, "exes" = its identifier (an Android package name).
 * Family chat goes through the launcher routes (launcher → `chat`, launcher/act → action "chat").
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import {
  KIDS_PACKAGE,
  KIDS_SCHEME,
  appSlug,
  bedtimeInstants,
  choreShown,
  clock12,
  guessCategory,
  isPackageName,
  nextLocalMidnight,
  numKey,
  wireRequest,
  type ChoreMark,
  type ChoreRepeat,
} from '../compat/logic';
import type { Ctx } from '../context';
import { isPairingCode, normalizePairingCode, randomToken, sha256Hex } from '../crypto';
import { withTransaction } from '../db';
import { apkFile, mediaFile, receiveFile, removeFile, sendFile } from '../files';
import { Body, HttpError, isUuid, RateLimiter } from '../http';
import { checkParentPin } from '../pin';
import {
  MAX_TEXT_MEDIA_BYTES,
  TEXT_MEDIA_QUOTA_BYTES,
  TEXT_MEDIA_TYPES,
  declaredType,
  looksLike,
  requireUploadMarker,
} from '../media';
import { onList } from '../levels';
import { downloadRelease, latestRelease } from '../releases';
import { allowedHosts, cleanHost, webFor } from './levels';
import { locationExtras, locationRoutes } from './location';
import { mediaRoutes } from './media';
import { localTime, type RuleKid } from '../rules';
import {
  loadKidStates,
  type AccountRow,
  type AppRow,
  type ContactRow,
  type DeviceRow,
  type KidRow,
  type RequestRow,
} from '../state';
import { normalizeIdentifier } from './parent';

const LAYOUTS = ['bright', 'gamer', 'glass'] as const;
const THEMES = ['galaxy', 'ocean', 'jungle', 'sunset'] as const;
const WARN_MINUTES = [10, 5];
const MAX_PENDING_REQUESTS = 5;
export const TEXT_KEEP_DAYS = 90;
/** Family chat: how long one message may be, and how many a kid may send in a minute. */
export const CHAT_MAX_LENGTH = 300;
export const CHAT_PER_MINUTE = 6;
const PHONE_RE = /^[+0-9 ()\-.]{3,30}$/;

interface Auth {
  device: DeviceRow;
  account: AccountRow;
}

type Db = PoolClient | Ctx['pool'];

function ruleKid(k: KidRow): RuleKid {
  return {
    limitSchoolMinutes: k.limit_school_minutes,
    limitWeekendMinutes: k.limit_weekend_minutes,
    bedSchoolStart: k.bed_school_start,
    bedSchoolEnd: k.bed_school_end,
    bedOtherStart: k.bed_other_start,
    bedOtherEnd: k.bed_other_end,
    bedtimeEnabled: k.bedtime_enabled,
    locked: k.locked,
  };
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Allows an Android app for a kid by package and name. A row the parent allowed by name only (an approved
 * "App: Roblox" request) becomes the row for this package, so the list shows one app, not two.
 */
export async function allowAndroidApp(db: Db, accountId: string, kidId: string, pkg: string, label: string): Promise<void> {
  const name = label || pkg;
  const byName = await db.query<{ id: string; identifier: string; name: string }>(
    `SELECT id, identifier, name FROM apps
      WHERE account_id = $1 AND kid_id = $2 AND kind = 'app' AND platform IN ('android','any') AND identifier <> $3`,
    [accountId, kidId, pkg],
  );
  const slug = appSlug(name);
  const twin = slug ? byName.rows.find((r) => !isPackageName(r.identifier) && (appSlug(r.identifier) === slug || appSlug(r.name) === slug)) : undefined;
  const exists = await db.query('SELECT 1 FROM apps WHERE account_id = $1 AND kid_id = $2 AND kind = $3 AND identifier = $4', [accountId, kidId, 'app', pkg]);
  if (twin && !exists.rowCount) {
    await db.query("UPDATE apps SET identifier = $2, platform = 'android', allowed = true WHERE id = $1", [twin.id, pkg]);
    return;
  }
  await db.query(
    `INSERT INTO apps (account_id, kid_id, kind, platform, identifier, name, allowed, category)
     VALUES ($1, $2, 'app', 'android', $3, $4, true, $5)
     ON CONFLICT (kid_id, kind, identifier) DO UPDATE SET allowed = true`,
    [accountId, kidId, pkg, name.slice(0, 80), guessCategory(name, pkg)],
  );
  if (twin) await db.query('DELETE FROM apps WHERE id = $1', [twin.id]);
}

/** Turns what a compatibility device reported today (seconds) into the minute rows the rules, dashboard and reports read. */
async function rebuildMinutes(db: Db, deviceId: string, kidId: string, day: string): Promise<void> {
  await db.query('DELETE FROM usage WHERE device_id = $1 AND day = $2', [deviceId, day]);
  await db.query(
    `INSERT INTO usage (kid_id, device_id, app_id, day, minutes)
     SELECT $2, $1, a.id, $3, s.seconds / 60
       FROM usage_seconds s JOIN apps a ON a.id::text = s.app_key AND a.kid_id = $2
      WHERE s.device_id = $1 AND s.day = $3 AND s.app_key <> '' AND s.seconds >= 60`,
    [deviceId, kidId, day],
  );
  // The day's counted time can be more than the apps add up to (website tiles, seconds lost to rounding):
  // the rest is kept as time that is not tied to an app.
  await db.query(
    `INSERT INTO usage (kid_id, device_id, app_id, day, minutes)
     SELECT $2, $1, NULL, $3, x.rest
       FROM (SELECT COALESCE((SELECT seconds FROM usage_seconds WHERE device_id = $1 AND day = $3 AND app_key = ''), 0) / 60
                  - COALESCE((SELECT SUM(u.minutes) FROM usage u JOIN apps a ON a.id = u.app_id
                               WHERE u.device_id = $1 AND u.day = $3 AND NOT a.free), 0) AS rest) x
      WHERE x.rest > 0`,
    [deviceId, kidId, day],
  );
}

export interface CompatRouters {
  warden: Router;
  android: Router;
  /** POST /api/android/text-media/:msgId/:mediaId, mounted before the JSON parser (the body is the photo). */
  textMediaUpload: (req: Request, res: Response) => Promise<void>;
  /** POST /api/android/media, mounted before the JSON parser (the body is a photo or video). */
  mediaUpload: (req: Request, res: Response) => Promise<void>;
  /** /m/<token>: what a share link shows. No sign-in. */
  watch: Router;
  /** The parents' side of the kids' photos and videos. */
  mediaParent: Router;
  /** The parents' side of the live map (places, check-ins, Ring phone, map tiles). */
  locationParent: Router;
}

/** Who is calling with a device token: the device and its family. Every kid-device route starts here. */
export async function deviceAuth(pool: Ctx['pool'], req: Request): Promise<Auth> {
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? '');
  if (!match?.[1]) throw new HttpError(401, 'This device is not set up yet.');
  const found = await pool.query<DeviceRow>('SELECT * FROM devices WHERE token_hash = $1', [sha256Hex(match[1])]);
  const device = found.rows[0];
  const owner = device ? await pool.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [device.account_id]) : null;
  const account = owner?.rows[0];
  if (!device || !account) throw new HttpError(401, 'This device was removed. Set it up again from the parent console.');
  return { device, account };
}

export function compatRoutes(ctx: Ctx): CompatRouters {
  const pool = ctx.pool;
  const warden = Router();
  const android = Router();
  const setupPerIp = new RateLimiter(ctx.ipLimits.pair, 15 * 60 * 1000);
  const actsPerDevice = new RateLimiter(60, 15 * 60 * 1000);
  const asksPerDevice = new RateLimiter(20, 15 * 60 * 1000);
  const wrongCodes = new RateLimiter(10, 15 * 60 * 1000);

  // ---------------------------------------------------------------- who is calling

  const auth = (req: Request): Promise<Auth> => deviceAuth(pool, req);
  const media = mediaRoutes(ctx, auth);
  android.use('/media', media.phone);
  // Where the phone is, and check-ins (routes/location.ts).
  const location = locationRoutes(ctx, auth);
  android.use(location.phone);

  // ---------------------------------------------------------------- setup: check the code, pair

  interface CodeRow {
    code: string;
    account_id: string;
    kid_id: string;
    platform: string;
    used_at: Date | null;
    machine_id: string | null;
    minutes_left: number;
  }

  const BAD_CODE = 'That code is wrong or has run out. Ask a parent for a new one in the Family Screen Warden console.';

  async function findCode(db: Db, raw: unknown, lock: boolean): Promise<CodeRow> {
    const code = normalizePairingCode(typeof raw === 'string' ? raw : '');
    if (!isPairingCode(code)) throw new HttpError(400, BAD_CODE);
    const found = await db.query<CodeRow>(
      `SELECT code, account_id, kid_id, platform, used_at, machine_id,
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - now())) / 60))::int AS minutes_left
         FROM pairing_codes WHERE code = $1 AND expires_at > now()${lock ? ' FOR UPDATE' : ''}`,
      [code],
    );
    const row = found.rows[0];
    // A used code only still counts for the phone that used it (it may pair again in place).
    if (!row || (row.used_at && !row.machine_id)) throw new HttpError(400, BAD_CODE);
    return row;
  }

  warden.post('/setup/check', async (req, res) => {
    if (!setupPerIp.take(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many tries. Please wait 15 minutes.');
    const hit = await findCode(pool, new Body(req.body).raw('code'), false);
    const owner = await pool.query<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [hit.account_id]);
    const kid = await pool.query<{ id: string; name: string; color: string }>('SELECT id, name, color FROM kids WHERE id = $1 AND account_id = $2', [
      hit.kid_id,
      hit.account_id,
    ]);
    const k = kid.rows[0];
    if (!k) throw new HttpError(400, BAD_CODE);
    res.json({
      family: owner.rows[0]?.email ?? 'Family Screen Warden',
      name: `${k.name}'s ${hit.platform === 'android' ? 'phone' : 'PC'}`,
      oneKid: true,
      minutesLeft: hit.minutes_left,
      kids: [{ id: k.id, name: k.name, color: k.color, avatar: null }],
    });
  });

  android.post('/pair', async (req, res) => {
    if (!setupPerIp.take(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many tries. Please wait 15 minutes.');
    const body = new Body(req.body);
    const memberId = body.raw('memberId');
    const machineId = body.string('deviceId', 'The phone id', { max: 80 });
    if (machineId.length < 8) throw new HttpError(400, 'The phone id is too short.');
    const model = body.nullableString('model', 'The model', 80);
    const version = body.nullableString('version', 'The app version', 40);
    const token = randomToken();
    const secret = crypto.randomBytes(32).toString('base64');

    const result = await withTransaction(pool, async (db) => {
      const hit = await findCode(db, body.raw('code'), true);
      if (hit.platform !== 'android') throw new HttpError(400, 'That code was made for a Windows PC. Ask a parent for a phone code.');
      if (hit.used_at && hit.machine_id !== machineId) throw new HttpError(409, 'That code was already used on another phone. Ask a parent for a new one.');
      if (!isUuid(memberId) || memberId.toLowerCase() !== hit.kid_id) throw new HttpError(400, 'That code is for another kid.');
      const kid = await db.query<{ id: string; name: string }>('SELECT id, name FROM kids WHERE id = $1 AND account_id = $2', [hit.kid_id, hit.account_id]);
      const k = kid.rows[0];
      if (!k) throw new HttpError(400, BAD_CODE);
      const name = `${k.name.split(' ')[0] ?? k.name}'s phone`.slice(0, 60);
      // The same phone pairs its own row again (after "Set up again"), so its history stays in one place.
      const again = await db.query<{ id: string }>(
        "SELECT id FROM devices WHERE account_id = $1 AND kid_id = $2 AND machine_id = $3 AND platform = 'android' ORDER BY created_at LIMIT 1",
        [hit.account_id, k.id, machineId],
      );
      let deviceId = again.rows[0]?.id;
      if (deviceId) {
        await db.query(
          `UPDATE devices SET token_hash = $2, unlock_secret = $3, unlock_counter = 0, paired_at = now(), last_seen_at = now(),
                  model = COALESCE($4, model), app_version = COALESCE($5, app_version)
            WHERE id = $1`,
          [deviceId, sha256Hex(token), secret, model, version],
        );
      } else {
        const made = await db.query<{ id: string }>(
          `INSERT INTO devices (account_id, kid_id, name, platform, model, app_version, token_hash, last_seen_at, machine_id, unlock_secret, paired_at)
           VALUES ($1, $2, $3, 'android', $4, $5, $6, now(), $7, $8, now()) RETURNING id`,
          [hit.account_id, k.id, name, model, version, sha256Hex(token), machineId, secret],
        );
        deviceId = made.rows[0]?.id;
      }
      if (!deviceId) throw new Error('Insert returned no row');
      await db.query('UPDATE pairing_codes SET used_at = COALESCE(used_at, now()), machine_id = $2, device_id = $3 WHERE code = $1', [hit.code, machineId, deviceId]);
      return { deviceId, name, kid: k };
    });
    res.json({
      token,
      secret,
      computerId: result.deviceId,
      name: result.name,
      member: { id: result.kid.id, name: result.kid.name },
      // The family's day runs from midnight to midnight in their time zone.
      resetHour: 0,
      warnMinutes: WARN_MINUTES,
    });
  });

  // ---------------------------------------------------------------- the sync answer

  async function snapshot(a: Auth): Promise<Record<string, unknown>> {
    const { device } = a;
    const fresh = await pool.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [a.account.id]);
    const account = fresh.rows[0] ?? a.account;
    const now = ctx.now();
    const state = (await loadKidStates(pool, account, now, device.kid_id))[0];
    if (!state) throw new HttpError(401, 'This device was removed. Set it up again from the parent console.');
    const { kid, apps, rules } = state;
    const day = rules.day;
    const phone = device.platform === 'android';

    const [seconds, minutes, requests, voids, contacts, installs, drops, blockedNums, release] = await Promise.all([
      pool.query<{ app_key: string; seconds: number }>(
        'SELECT app_key, SUM(seconds)::int AS seconds FROM usage_seconds WHERE kid_id = $1 AND day = $2 GROUP BY app_key',
        [kid.id, day],
      ),
      // Devices that report minutes (the simple /api/device API, or a device that was removed) count too: time is the kid's.
      pool.query<{ app_id: string | null; minutes: number; free: boolean }>(
        `SELECT u.app_id, SUM(u.minutes)::int AS minutes, COALESCE(bool_or(ap.free), false) AS free
           FROM usage u LEFT JOIN apps ap ON ap.id = u.app_id
          WHERE u.kid_id = $1 AND u.day = $2
            AND (u.device_id IS NULL OR u.device_id NOT IN (SELECT device_id FROM usage_seconds WHERE kid_id = $1 AND day = $2))
          GROUP BY u.app_id`,
        [kid.id, day],
      ),
      pool.query<RequestRow>(
        `SELECT * FROM requests WHERE account_id = $1 AND kid_id = $2 AND kind <> 'contact' AND created_at > now() - interval '1 day'
          ORDER BY created_at DESC LIMIT 30`,
        [account.id, kid.id],
      ),
      pool.query<{ counter: number }>(
        `SELECT counter FROM unlock_codes
          WHERE device_id = $1 AND used_at IS NULL AND (cancelled_at IS NOT NULL OR expires_at < now())
            AND ($2::timestamptz IS NULL OR created_at >= $2)
          ORDER BY counter DESC LIMIT 100`,
        [device.id, device.paired_at],
      ),
      pool.query<ContactRow>('SELECT * FROM contacts WHERE account_id = $1 AND kid_id = $2 ORDER BY lower(name), id', [account.id, kid.id]),
      pool.query<{ id: string; name: string; sha256: string; size: number; recent: boolean }>(
        `SELECT i.id, i.name, k.sha256, k.size, (i.created_at > now() - interval '15 minutes') AS recent
           FROM apk_installs i JOIN apks k ON k.id = i.apk_id
          WHERE i.device_id = $1 AND i.status IN ('waiting','installing') AND i.created_at > now() - interval '7 days'
          ORDER BY i.created_at`,
        [device.id],
      ),
      pool.query<{ phone_id: string }>(
        "SELECT phone_id FROM texts WHERE device_id = $1 AND status = 'deleted' AND created_at > now() - interval '30 days' LIMIT 500",
        [device.id],
      ),
      pool.query<{ num: string }>('SELECT num FROM blocked_numbers WHERE kid_id = $1', [kid.id]),
      phone ? latestRelease(pool) : Promise.resolve(null),
    ]);

    let general = 0;
    const appSeconds: Record<string, number> = {};
    for (const s of seconds.rows) {
      if (s.app_key === '') general += s.seconds;
      else appSeconds[s.app_key] = (appSeconds[s.app_key] ?? 0) + s.seconds;
    }
    for (const m of minutes.rows) {
      if (!m.free) general += m.minutes * 60;
      if (m.app_id) appSeconds[m.app_id] = (appSeconds[m.app_id] ?? 0) + m.minutes * 60;
    }

    const base = rules.schoolDay ? kid.limit_school_minutes : kid.limit_weekend_minutes;
    const bed = bedtimeInstants(ruleKid(kid), now, account.timezone);
    const asked = await pool.query<{ detail: string; identifier: string | null; status: string }>(
      `SELECT detail, identifier, status FROM requests
        WHERE account_id = $1 AND kid_id = $2 AND kind = 'contact'
          AND (status = 'pending' OR (status = 'denied' AND decided_at > now() - interval '7 days'))
        ORDER BY created_at DESC LIMIT 30`,
      [account.id, kid.id],
    );

    const answer: Record<string, unknown> = {
      serverTime: new Date().toISOString(),
      day,
      dayEndsAt: nextLocalMidnight(now, account.timezone).toISOString(),
      // In the app's words "paused" means the rules are off for a while. Warden's "pause all screens" is a lock instead.
      paused: false,
      kid: { id: kid.id, name: kid.name },
      allowance: { generalMinutes: rules.limitMinutes, baseMinutes: base, extraMinutes: Math.max(0, rules.limitMinutes - base), appMinutes: {} },
      used: { generalSeconds: general, appSeconds },
      apps: apps
        .filter((x: AppRow) => x.kind === 'app' && x.allowed && (x.platform === 'any' || x.platform === device.platform))
        .map((x: AppRow) => ({
          key: x.id,
          name: x.name,
          category: x.category,
          exes: [x.identifier],
          allowed: true,
          budgeted: false,
          limitMinutes: x.limit_minutes,
          free: x.free,
        })),
      sites: apps
        .filter((x: AppRow) => x.kind === 'site' && x.allowed)
        .map((x: AppRow) => ({ host: x.identifier, tile: x.name, folder: null, from: null, to: null })),
      warnMinutes: WARN_MINUTES,
      requests: requests.rows.map(wireRequest),
      locked: account.paused_all || kid.locked,
      shutdown: null,
      shutdownCancel: null,
      voidUnlocks: voids.rows.map((v) => v.counter),
      watchOnly: null,
      bedtime: bed ? { at: bed.at.toISOString(), until: bed.until.toISOString(), warnMinutes: WARN_MINUTES } : null,
      fastSync: installs.rows.some((i) => i.recent),
      safeSearch: { search: kid.safe_search, youTube: kid.youtube_restricted },
      // Safe browsing, the same for phones and PCs: only the kid's sites, a filtered web or an open web (levels.ts).
      web: webFor(kid, apps),
      launcher: { enabled: true, layout: kid.launcher_layout, theme: kid.launcher_theme, lookLocked: kid.launcher_look_locked },
      update: null,
    };
    if (phone) {
      answer.phone = {
        rules: {
          blockSettings: kid.phone_block_settings,
          blockReset: kid.phone_block_reset,
          blockSafeBoot: kid.phone_block_safe_boot,
          blockInstalls: kid.phone_block_installs,
          blockAccounts: kid.phone_block_accounts,
          blockUsb: kid.phone_block_usb,
          emergencyNumber: kid.phone_emergency_number,
          playMinutes: kid.phone_play_minutes,
        },
        // People the kid can call. `always`: also when the phone is locked (time is up, bedtime, a parent's lock).
        contacts: contacts.rows
          .filter((c) => c.can_call)
          .map((c) => ({ id: c.id, name: c.name, phone: c.phone, always: c.always, canCall: c.can_call, canText: c.can_text })),
      };
      answer.texting = {
        // People the kid can text but not call.
        friends: contacts.rows.filter((c) => c.can_text && !c.can_call).map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
        asked: asked.rows.map((r) => ({ name: r.detail, phone: r.identifier ?? '', status: r.status })),
        blocked: blockedNums.rows.map((b) => b.num),
        drop: drops.rows.map((d) => d.phone_id),
        // Who the kid can text: family only, family and approved friends, or anyone (the kid's level).
        who: kid.texting_who,
      };
      // Location sharing on or off, "live" while a parent has the map open, and Ring phone.
      Object.assign(answer, await locationExtras(pool, device));
      answer.apkInstalls = installs.rows.map((i) => ({ id: i.id, name: i.name, url: `/api/android/apk/${i.id}`, sha256: i.sha256, size: i.size }));
      answer.update = release
        ? { version: release.version, url: `/api/android/download?v=${encodeURIComponent(release.version)}`, sha256: release.sha256, size: release.size }
        : null;
    }
    return answer;
  }

  // ---------------------------------------------------------------- sync

  function readTexts(raw: unknown): Array<{
    id: string; parts: string[]; dir: 'in' | 'out'; from: string | null; body: string; at: number; status: string; media: Array<{ id: string; type: string }>;
  }> {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > 100) throw new HttpError(400, 'Texts must be a list of at most 100.');
    const out = [];
    for (const item of raw) {
      const t = obj(item);
      const id = clean(t?.id, 64);
      const dir = t?.dir;
      const thread = Array.isArray(t?.thread) ? t.thread : [];
      const at = t?.at;
      if (!t || !id || (dir !== 'in' && dir !== 'out') || typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
        throw new HttpError(400, 'Each text needs id, thread, dir and at.');
      }
      const parts = [...new Set(thread.slice(0, 20).map((p) => numKey(typeof p === 'string' ? p : '')).filter(Boolean))].sort();
      if (parts.length === 0) continue;
      const status = t.status === 'held' || t.status === 'waiting' ? t.status : 'shown';
      const media = (Array.isArray(t.media) ? t.media : [])
        .slice(0, 10)
        .map((m) => ({ id: clean(obj(m)?.id, 64), type: clean(obj(m)?.type, 80) }))
        .filter((m) => m.id);
      const fromRaw = typeof t.from === 'string' ? numKey(t.from) : '';
      out.push({
        id,
        parts,
        dir: dir as 'in' | 'out',
        from: dir === 'in' ? fromRaw || parts[0] || null : null,
        body: typeof t.body === 'string' ? t.body.slice(0, 5000) : '',
        at: Math.min(at, Date.now() + 24 * 3600_000),
        status,
        media,
      });
    }
    return out;
  }

  warden.post('/sync', async (req, res) => {
    const a = await auth(req);
    const { device, account } = a;
    const body = new Body(req.body);
    const now = ctx.now();
    const today = localTime(now, account.timezone).day;
    const phone = device.platform === 'android';

    const version = body.nullableString('version', 'The app version', 40);

    // -- usage: seconds so far in the day the app thinks it is. Only today's count (a late report from yesterday is dropped).
    const usage = obj(body.raw('usage'));
    const usageRows: Array<[string, number]> = [];
    if (usage && usage.day === today) {
      const cap = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(86400, Math.floor(v)) : null);
      const general = cap(usage.generalSeconds);
      if (general === null) throw new HttpError(400, 'Usage needs generalSeconds.');
      usageRows.push(['', general]);
      const perApp = obj(usage.appSeconds) ?? {};
      const keys = Object.keys(perApp);
      if (keys.length > 500) throw new HttpError(400, 'Usage has too many apps.');
      for (const key of keys) {
        const s = cap(perApp[key]);
        if (!key || key.length > 80 || s === null) throw new HttpError(400, 'Each app in usage needs a key and seconds.');
        usageRows.push([key, s]);
      }
    }

    // -- apps found on the device ("exe" is the Android package), and apps the kid tried that were closed.
    const found = new Map<string, string>();
    for (const list of [body.array('installed', 'Installed apps', 1000), body.array('blocked', 'Blocked apps', 60)]) {
      for (const raw of list) {
        const item = obj(raw);
        const exe = clean(item?.exe, 200);
        if (!exe) continue;
        const identifier = phone ? exe : exe.toLowerCase();
        if (phone && !isPackageName(identifier)) continue;
        if (!found.has(identifier)) found.set(identifier, clean(item?.name, 80) || identifier);
      }
    }

    // -- websites it refused.
    const blockedSites: Array<{ host: string; at: Date }> = [];
    for (const raw of body.array('blockedSites', 'Blocked sites', 60)) {
      const item = obj(raw);
      const host = typeof item?.host === 'string' ? normalizeIdentifier('site', 'any', item.host).slice(0, 255) : '';
      if (!host) continue;
      let at = typeof item?.at === 'string' ? new Date(item.at) : new Date(now.getTime());
      if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() || at.getTime() < now.getTime() - 7 * 24 * 3600_000) at = new Date(now.getTime());
      blockedSites.push({ host, at });
    }

    const unlocksUsed = body.array('unlocksUsed', 'Used codes', 20).filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1);
    const live = obj(body.raw('live'));
    const info = phone ? obj(body.raw('device')) : null;
    const installResults = phone ? body.array('installResults', 'Install results', 50) : [];
    const playInstalled = phone ? body.array('playInstalled', 'Play Store installs', 10) : [];
    const texts = phone ? readTexts(body.raw('texts')) : [];

    await withTransaction(pool, async (db) => {
      const front = live ? clean(live.foregroundName, 120) || null : null;
      const battery = typeof info?.battery === 'number' && info.battery >= 0 && info.battery <= 100 ? Math.round(info.battery) : null;
      const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
      await db.query(
        `UPDATE devices SET last_seen_at = now(),
                app_version = COALESCE($3, app_version),
                front_app = CASE WHEN $4 THEN $5 ELSE front_app END,
                model = COALESCE($6, model),
                os_version = COALESCE($7, os_version),
                info = COALESCE($8::jsonb, info)
          WHERE id = $1 AND account_id = $2`,
        [
          device.id,
          account.id,
          version,
          live !== null,
          front,
          info ? clean(info.model, 80) || null : null,
          info && clean(info.android, 20) ? `Android ${clean(info.android, 20)}` : null,
          info ? JSON.stringify({ battery, charging: bool(info.charging), deviceOwner: bool(info.deviceOwner), usageAccess: bool(info.usageAccess) }) : null,
        ],
      );

      if (usageRows.length > 0) {
        await db.query(
          `INSERT INTO usage_seconds (device_id, kid_id, day, app_key, seconds)
           SELECT $1, $2, $3, t.app_key, t.seconds FROM unnest($4::text[], $5::int[]) AS t(app_key, seconds)
           ON CONFLICT (device_id, day, app_key)
           DO UPDATE SET seconds = GREATEST(usage_seconds.seconds, EXCLUDED.seconds), kid_id = EXCLUDED.kid_id`,
          [device.id, device.kid_id, today, usageRows.map((u) => u[0]), usageRows.map((u) => u[1])],
        );
        await rebuildMinutes(db, device.id, device.kid_id, today);
      }

      if (found.size > 0) {
        const known = await db.query<{ id: string; identifier: string; name: string; platform: string }>(
          "SELECT id, identifier, name, platform FROM apps WHERE account_id = $1 AND kid_id = $2 AND kind = 'app'",
          [account.id, device.kid_id],
        );
        const have = new Set(known.rows.map((r) => r.identifier));
        // Apps a parent allowed by name before the phone had them ("App: Roblox"): they become the row for the package.
        const byName = new Map<string, string>();
        if (phone) {
          for (const r of known.rows) {
            if (isPackageName(r.identifier) || (r.platform !== 'android' && r.platform !== 'any')) continue;
            for (const slug of [appSlug(r.identifier), appSlug(r.name)]) if (slug && !byName.has(slug)) byName.set(slug, r.id);
          }
        }
        const fresh: Array<[string, string]> = [];
        for (const [identifier, name] of found) {
          if (have.has(identifier)) continue;
          const twin = byName.get(appSlug(name));
          if (twin) {
            await db.query("UPDATE apps SET identifier = $2, platform = 'android' WHERE id = $1", [twin, identifier]);
            for (const [slug, id] of byName) if (id === twin) byName.delete(slug);
          } else fresh.push([identifier, name]);
        }
        if (fresh.length > 0) {
          await db.query(
            `INSERT INTO apps (account_id, kid_id, kind, platform, identifier, name, allowed, category)
             SELECT $1, $2, 'app', $3, t.identifier, t.name, false, t.category
               FROM unnest($4::text[], $5::text[], $6::text[]) AS t(identifier, name, category)
             ON CONFLICT (kid_id, kind, identifier) DO NOTHING`,
            [account.id, device.kid_id, device.platform, fresh.map((f) => f[0]), fresh.map((f) => f[1]), fresh.map((f) => guessCategory(f[1], f[0]))],
          );
        }
      }

      if (blockedSites.length > 0) {
        await db.query(
          // The app sends its whole list of the last day with every sync: only what is not here yet is added.
          `INSERT INTO blocked_events (account_id, kid_id, device_id, host, at)
           SELECT DISTINCT $1::uuid, $2::uuid, $3::uuid, t.host, t.at FROM unnest($4::text[], $5::timestamptz[]) AS t(host, at)
            WHERE NOT EXISTS (SELECT 1 FROM blocked_events b WHERE b.device_id = $3 AND b.host = t.host AND b.at = t.at)`,
          [account.id, device.kid_id, device.id, blockedSites.map((b) => b.host), blockedSites.map((b) => b.at.toISOString())],
        );
      }

      if (unlocksUsed.length > 0) {
        await db.query(
          `UPDATE unlock_codes SET used_at = COALESCE(used_at, now())
            WHERE device_id = $1 AND counter = ANY($2::int[]) AND ($3::timestamptz IS NULL OR created_at >= $3)`,
          [device.id, unlocksUsed, device.paired_at],
        );
      }

      // An app the kid installed while a parent had the Play Store open: the parent said yes to it.
      for (const raw of playInstalled) {
        const item = obj(raw);
        const pkg = clean(item?.package, 200);
        if (isPackageName(pkg)) await allowAndroidApp(db, account.id, device.kid_id, pkg, clean(item?.label, 80));
      }

      // How pushed APKs went. Installed: the app is allowed for the kid, under the name the phone read from it.
      for (const raw of installResults) {
        const item = obj(raw);
        const id = item?.id;
        const status = item?.status;
        if (!isUuid(id) || (status !== 'installing' && status !== 'done' && status !== 'failed')) continue;
        const updated = await db.query<{ apk_id: string; name: string }>(
          `UPDATE apk_installs SET status = $3, message = $4, updated_at = now()
            WHERE id = $1 AND device_id = $2 AND status <> 'done' RETURNING apk_id, name`,
          [id, device.id, status, clean(item?.message, 400) || null],
        );
        const row = updated.rows[0];
        const pkg = clean(item?.package, 200);
        if (row && status === 'done' && isPackageName(pkg)) {
          await allowAndroidApp(db, account.id, device.kid_id, pkg, clean(item?.label, 80) || row.name);
          await db.query('UPDATE apks SET package = COALESCE(package, $2) WHERE id = $1 AND account_id = $3', [row.apk_id, pkg, account.id]);
        }
      }

      // Texts on the phone, copied here for the parents to read. A repeat only updates where the text stands.
      for (const t of texts) {
        await db.query(
          `INSERT INTO texts (account_id, kid_id, device_id, phone_id, thread, participants, dir, from_num, body, media, status, at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, to_timestamp($12 / 1000.0))
           ON CONFLICT (device_id, phone_id) DO UPDATE SET status = EXCLUDED.status WHERE texts.status <> 'deleted'`,
          [account.id, device.kid_id, device.id, t.id, t.parts.join(','), t.parts, t.dir, t.from, t.body, JSON.stringify(t.media), t.status, t.at],
        );
      }
    });

    res.json(await snapshot(a));
  });

  // ---------------------------------------------------------------- "Ask a grown-up"

  interface Asked {
    status: 'sent' | 'pending' | 'denied' | 'allowed';
    id?: string;
    message: string;
  }

  /** One request from a kid. The same thing is not asked twice, a fresh "no" stands for 12 hours, and 5 can wait at a time. */
  async function ask(
    a: Auth,
    r: { kind: 'time' | 'app' | 'site' | 'contact'; minutes: number | null; detail: string; identifier: string | null; note?: string | null; phone?: string | null },
  ): Promise<Asked> {
    const { device, account } = a;
    return withTransaction(pool, async (db) => {
      await db.query('SELECT 1 FROM kids WHERE id = $1 AND account_id = $2 FOR UPDATE', [device.kid_id, account.id]);
      const same = await db.query<{ id: string; status: string; fresh_no: boolean }>(
        `SELECT id, status, (status = 'denied' AND decided_at > now() - interval '12 hours') AS fresh_no
           FROM requests
          WHERE account_id = $1 AND kid_id = $2 AND kind = $3
            AND (($3 = 'time' AND status = 'pending') OR ($3 <> 'time' AND lower(identifier) = lower($4)))
            AND (status = 'pending' OR (status = 'denied' AND decided_at > now() - interval '12 hours'))
          ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 1`,
        [account.id, device.kid_id, r.kind, r.identifier ?? ''],
      );
      const before = same.rows[0];
      if (before?.status === 'pending') return { status: 'pending', id: before.id, message: 'Already asked. Waiting for a parent.' };
      if (before?.fresh_no) return { status: 'denied', message: 'A parent already said no to this today.' };
      const made = await db.query<{ id: string }>(
        `INSERT INTO requests (account_id, kid_id, device_id, kind, minutes, detail, identifier, note, phone)
         SELECT $1, $2, $3, $4, $5, $6, $7, $9, $10
          WHERE (SELECT count(*) FROM requests WHERE account_id = $1 AND kid_id = $2 AND status = 'pending') < $8
         RETURNING id`,
        [account.id, device.kid_id, device.id, r.kind, r.minutes, r.detail, r.identifier, MAX_PENDING_REQUESTS, r.note ?? null, r.phone ?? null],
      );
      const row = made.rows[0];
      if (!row) return { status: 'pending', message: 'Lots of questions are waiting already. Ask a parent in person.' };
      return { status: 'sent', id: row.id, message: 'Sent to a parent. The answer shows up here.' };
    });
  }

  function takeAsk(device: DeviceRow): void {
    if (!asksPerDevice.take(device.id)) throw new HttpError(429, 'Lots of questions already. Wait a little, or ask a parent in person.');
  }

  /** The kid tapped "Ask a grown-up" on an app that is not allowed (by its package name). */
  android.post('/request', async (req, res) => {
    const a = await auth(req);
    takeAsk(a.device);
    const body = new Body(req.body);
    // A blocked website ("Ask a grown-up" on the "This site is blocked" screen): yes puts it on the kid's list.
    const site = clean(body.raw('site'), 255);
    if (site) {
      const host = cleanHost(site);
      if (!host) throw new HttpError(400, 'That is not a website.');
      const listed = await pool.query<{ kind: 'site'; allowed: boolean; identifier: string }>(
        "SELECT kind, allowed, identifier FROM apps WHERE account_id = $1 AND kid_id = $2 AND kind = 'site' AND allowed",
        [a.account.id, a.device.kid_id],
      );
      if (onList(host, allowedHosts(listed.rows))) {
        res.json({ status: 'allowed', message: 'That website is allowed already. Give it a moment.' } satisfies Asked);
        return;
      }
      res.json(await ask(a, { kind: 'site', minutes: null, detail: host, identifier: host }));
      return;
    }
    const pkg = clean(body.raw('package'), 200);
    if (!isPackageName(pkg)) throw new HttpError(400, 'That is not an app.');
    const name = clean(body.raw('name'), 120) || pkg;
    const allowed = await pool.query(
      "SELECT 1 FROM apps WHERE account_id = $1 AND kid_id = $2 AND kind = 'app' AND identifier = $3 AND allowed",
      [a.account.id, a.device.kid_id, pkg],
    );
    if (allowed.rowCount) {
      res.json({ status: 'allowed', message: 'That app is allowed already. Give it a moment.' } satisfies Asked);
      return;
    }
    res.json(await ask(a, { kind: 'app', minutes: null, detail: name, identifier: pkg }));
  });

  /** "Ask to add a friend" in the texting app: a parent answers it like any other request; yes makes a text-only contact. */
  android.post('/friend', async (req, res) => {
    const a = await auth(req);
    takeAsk(a.device);
    const body = new Body(req.body);
    const name = body.string('name', 'Their name', { max: 60 });
    const phone = body.string('phone', 'Their phone number', { max: 30 });
    // How the kid knows them ("In my class"): shown to the parent with the question.
    const note = body.nullableString('note', 'The note', 200);
    const num = numKey(phone);
    if (!PHONE_RE.test(phone) || num.length < 3) throw new HttpError(400, 'Enter their phone number.');
    const contacts = await pool.query<{ name: string; phone: string; can_call: boolean; can_text: boolean }>(
      'SELECT name, phone, can_call, can_text FROM contacts WHERE account_id = $1 AND kid_id = $2',
      [a.account.id, a.device.kid_id],
    );
    const known = contacts.rows.find((c) => numKey(c.phone) === num);
    if (known && (known.can_call || known.can_text)) {
      res.json({ status: 'approved', message: known.can_call ? 'That number is already in your family list.' : `You can already text ${name}.` });
      return;
    }
    const asked = await ask(a, { kind: 'contact', minutes: null, detail: name, identifier: num, note, phone });
    res.json(asked.status === 'sent' ? { ...asked, message: 'Sent to a parent. Once they say yes, you can text your friend.' } : asked);
  });

  // ---------------------------------------------------------------- the launcher

  /**
   * What the launcher page shows besides the rules: the kid, today's chores, and two short lines of text.
   * The page reads kid, chores, choreMinutes, bedtimeText, dayText and chat.
   */
  warden.post('/launcher', async (req, res) => {
    const { device, account } = await auth(req);
    const now = ctx.now();
    const today = localTime(now, account.timezone).day;
    const kid = await pool.query<KidRow>('SELECT * FROM kids WHERE id = $1 AND account_id = $2', [device.kid_id, account.id]);
    const me = kid.rows[0];
    if (!me) throw new HttpError(401, 'This device was removed. Set it up again from the parent console.');

    const [chores, marks, chat, kids] = await Promise.all([
      pool.query<{ id: string; name: string; minutes: number; repeat: ChoreRepeat }>(
        'SELECT id, name, minutes, repeat FROM chores WHERE account_id = $1 AND kid_id = $2 AND active ORDER BY created_at, id',
        [account.id, me.id],
      ),
      pool.query<{ chore_id: string; day: string; status: ChoreMark['status']; decided_day: string | null }>(
        `SELECT chore_id, day, status, decided_day FROM chore_completions
          WHERE account_id = $1 AND kid_id = $2 AND (status = 'pending' OR day > $3::date - 8 OR decided_day = $3::date)`,
        [account.id, me.id, today],
      ),
      // Family chat: the last 40 messages of the last 7 days, oldest first.
      pool.query<{ id: string; kid_id: string | null; text: string; created_at: Date }>(
        `SELECT * FROM (SELECT id, kid_id, text, created_at FROM family_chat
                         WHERE account_id = $1 AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 40) x
          ORDER BY created_at`,
        [account.id],
      ),
      pool.query<{ id: string; name: string; color: string }>('SELECT id, name, color FROM kids WHERE account_id = $1', [account.id]),
    ]);
    const bed = bedtimeInstants(ruleKid(me), now, account.timezone);
    const byId = new Map(kids.rows.map((k) => [k.id, k]));
    const first = (n: string): string => n.split(' ')[0] ?? n;

    res.json({
      kid: { id: me.id, name: me.name.split(' ')[0] ?? me.name, emoji: null, color: me.color },
      chores: chores.rows
        .map((c) => ({
          id: c.id,
          title: c.name,
          status: choreShown(
            c.repeat,
            today,
            marks.rows.filter((m) => m.chore_id === c.id).map((m) => ({ day: m.day, status: m.status, decidedDay: m.decided_day })),
          ),
          minutes: c.minutes,
          timer: false,
        }))
        .filter((c) => c.status !== 'hidden'),
      // Each chore carries its own minutes, so there is no "each" number to show.
      choreMinutes: 0,
      dayText: new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: account.timezone }).format(now),
      bedtimeText: bed ? `Bedtime at ${clock12(localClock(bed.at, account.timezone))}` : '',
      // Family chat, as the launcher draws it: who wrote it, the text, and whether it is this kid's own.
      chat: chat.rows.map((m) => {
        const k = m.kid_id ? byId.get(m.kid_id) : undefined;
        return {
          id: m.id,
          who: m.kid_id ? first(k?.name ?? 'Someone') : 'Parent',
          emoji: null,
          color: k?.color ?? '#4f61b8',
          text: m.text,
          at: m.created_at.toISOString(),
          mine: m.kid_id === me.id,
        };
      }),
    });
  });

  function localClock(at: Date, timeZone: string): string {
    const m = localTime(at, timeZone).minutes;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  warden.post('/launcher/act', async (req, res) => {
    const a = await auth(req);
    const { device, account } = a;
    if (!actsPerDevice.take(device.id)) throw new HttpError(429, 'Too many taps. Wait a little.');
    const body = new Body(req.body);
    const action = body.string('action', 'The action', { max: 20 });
    const what = clean(body.raw('what'), 20);
    const minutesRaw = body.raw('minutes');
    const minutes = typeof minutesRaw === 'number' && Number.isInteger(minutesRaw) && minutesRaw >= 1 && minutesRaw <= 240 ? minutesRaw : null;
    const today = localTime(ctx.now(), account.timezone).day;
    const reply = (ok: boolean, message: string): void => {
      res.json({ ok, message });
    };

    switch (action) {
      case 'chore': {
        const id = body.raw('id');
        if (!isUuid(id)) throw new HttpError(404, 'That chore is not yours.');
        const done = await withTransaction(pool, async (db) => {
          const found = await db.query<{ id: string; minutes: number; repeat: ChoreRepeat }>(
            'SELECT id, minutes, repeat FROM chores WHERE id = $1 AND account_id = $2 AND kid_id = $3 AND active FOR UPDATE',
            [id, account.id, device.kid_id],
          );
          const chore = found.rows[0];
          if (!chore) throw new HttpError(404, 'That chore is not yours.');
          const marks = await db.query<{ day: string; status: ChoreMark['status']; decided_day: string | null }>(
            'SELECT day, status, decided_day FROM chore_completions WHERE chore_id = $1',
            [chore.id],
          );
          const shown = choreShown(chore.repeat, today, marks.rows.map((m) => ({ day: m.day, status: m.status, decidedDay: m.decided_day })));
          if (shown !== 'todo') return false;
          await db.query(
            'INSERT INTO chore_completions (account_id, chore_id, kid_id, device_id, day, minutes) VALUES ($1, $2, $3, $4, $5, $6)',
            [account.id, chore.id, device.kid_id, device.id, today, chore.minutes],
          );
          return true;
        });
        reply(true, done ? 'Sent! A parent will check it.' : 'Already done.');
        return;
      }
      case 'chat': {
        // A message to the family chat: every kid's launcher and the parent console show it.
        const text = clean(body.raw('text'), CHAT_MAX_LENGTH + 1);
        if (!text) return reply(false, 'Type a message first.');
        if (text.length > CHAT_MAX_LENGTH) return reply(false, `That message is too long (at most ${CHAT_MAX_LENGTH} characters).`);
        const recent = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM family_chat WHERE account_id = $1 AND kid_id = $2 AND created_at > now() - interval '1 minute'",
          [account.id, device.kid_id],
        );
        if ((recent.rows[0]?.n ?? 0) >= CHAT_PER_MINUTE) return reply(false, 'Slow down a little!');
        await pool.query('INSERT INTO family_chat (account_id, kid_id, text) VALUES ($1, $2, $3)', [account.id, device.kid_id, text]);
        return reply(true, '');
      }
      case 'look': {
        // The page sends a layout and a colour theme. Names this server does not know are left as they were,
        // never refused (the page has one layout now and may grow new colours).
        const pick = <T extends string>(key: string, known: readonly T[]): T | null => {
          const v = body.raw(key);
          return typeof v === 'string' && (known as readonly string[]).includes(v) ? (v as T) : null;
        };
        // A parent from the PIN menu ("grownup", the device checked the PIN) can change a locked look.
        const updated = await pool.query(
          `UPDATE kids SET launcher_layout = COALESCE($3, launcher_layout), launcher_theme = COALESCE($4, launcher_theme)
            WHERE id = $1 AND account_id = $2 AND (NOT launcher_look_locked OR $5)`,
          [device.kid_id, account.id, pick('layout', LAYOUTS), pick('theme', THEMES), what === 'grownup'],
        );
        return updated.rowCount ? reply(true, '') : reply(false, 'A parent picked these colours.');
      }
      case 'ask': {
        takeAsk(device);
        let asked: Asked;
        if (what === 'time') {
          asked = await ask(a, { kind: 'time', minutes: minutes ?? 15, detail: '', identifier: null });
        } else if (what === 'app' || what === 'site') {
          const text = clean(body.raw('text'), 100);
          if (!text) return reply(false, 'Type what you want first.');
          if (what === 'site') {
            const host = normalizeIdentifier('site', 'any', text).slice(0, 255);
            if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return reply(false, 'Type the website address, like khanacademy.org.');
            asked = await ask(a, { kind: 'site', minutes: null, detail: host, identifier: host });
          } else {
            asked = await ask(a, { kind: 'app', minutes: null, detail: text, identifier: isPackageName(text) ? text : text.toLowerCase() });
          }
        } else {
          throw new HttpError(400, 'Ask for what?');
        }
        return reply(asked.status === 'sent' || asked.status === 'pending', asked.message);
      }
      case 'parent': {
        // From the launcher's PIN menu. The device checked the PIN (through /pin) before it sends this.
        if (what === 'time') {
          const m = minutes ?? 15;
          await pool.query("INSERT INTO time_grants (kid_id, day, minutes, reason) VALUES ($1, $2, $3, 'device')", [device.kid_id, today, m]);
          return reply(true, `Added ${m} minutes.`);
        }
        if (what === 'lock') {
          await pool.query('UPDATE kids SET locked = true WHERE id = $1 AND account_id = $2', [device.kid_id, account.id]);
          return reply(true, 'Locked. Unlock it from the parent console.');
        }
        throw new HttpError(400, 'That parent action is not known.');
      }
      default:
        // An action this server does not know (a newer or older app): a plain "no", not an error.
        return reply(false, 'That is not available here.');
    }
  });

  // ---------------------------------------------------------------- parent PIN and codes

  /** A parent's PIN typed on the launcher. 409 when no PIN is set (the app then takes an emergency code instead). */
  warden.post('/pin', async (req, res) => {
    const { account } = await auth(req);
    const pin = clean(new Body(req.body).raw('pin'), 20);
    if (!/^\d{4,8}$/.test(pin)) {
      res.json({ ok: false, message: 'That PIN is not right.' });
      return;
    }
    const checked = await checkParentPin(pool, account.id, pin);
    switch (checked.result) {
      case 'ok':
        res.json({ ok: true, message: '' });
        return;
      case 'no-pin':
        throw new HttpError(409, 'No parent PIN is set yet. Set one in the parent console under Settings, or use an emergency code.');
      case 'locked-out':
        res.setHeader('Retry-After', String(checked.retryAfterSeconds));
        throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil(checked.retryAfterSeconds / 60)} minutes.`);
      default:
        res.json({ ok: false, message: 'That PIN is not right.' });
    }
  });

  /** A bonus-time code from a parent. It adds minutes to today, works once, and lifts a parent's lock. */
  warden.post('/redeem', async (req, res) => {
    const a = await auth(req);
    const { device, account } = a;
    if (!wrongCodes.peek(device.id)) throw new HttpError(429, 'Too many wrong codes. Try again in a few minutes.');
    const code = normalizePairingCode(clean(new Body(req.body).raw('code'), 20));
    const today = localTime(ctx.now(), account.timezone).day;
    const minutes = await withTransaction(pool, async (db) => {
      const used = await db.query<{ minutes: number }>(
        `UPDATE time_codes SET used_at = now(), used_by_device = $4
          WHERE code = $1 AND account_id = $2 AND kid_id = $3 AND used_at IS NULL AND expires_at > now()
          RETURNING minutes`,
        [code, account.id, device.kid_id, device.id],
      );
      const row = used.rows[0];
      if (!row) return null;
      await db.query("INSERT INTO time_grants (kid_id, day, minutes, reason) VALUES ($1, $2, $3, 'code')", [device.kid_id, today, row.minutes]);
      await db.query('UPDATE kids SET locked = false WHERE id = $1 AND account_id = $2', [device.kid_id, account.id]);
      return row.minutes;
    });
    if (minutes === null) {
      wrongCodes.take(device.id);
      throw new HttpError(400, 'That code is not right, was already used, or has run out. Codes work once and last 24 hours.');
    }
    res.json({ ...(await snapshot(a)), minutes, appKey: null });
  });

  // ---------------------------------------------------------------- files for the phone

  /** An APK a parent pushed to this phone. */
  android.get('/apk/:installId', async (req, res) => {
    const { device, account } = await auth(req);
    if (!isUuid(req.params.installId)) throw new HttpError(404, 'That install is gone.');
    const found = await pool.query<{ apk_id: string }>('SELECT apk_id FROM apk_installs WHERE id = $1 AND device_id = $2 AND account_id = $3', [
      req.params.installId,
      device.id,
      account.id,
    ]);
    const row = found.rows[0];
    if (!row) throw new HttpError(404, 'That install is gone.');
    sendFile(res, apkFile(ctx.config.dataDir, row.apk_id), 'application/vnd.android.package-archive');
  });

  android.get('/download', downloadRelease(ctx));

  /**
   * The quick-install page (any phone camera opens it from the second QR code): download the app, install it, then
   * "Open" hands the server address and the setup code to the app. No sign-in: the code is the key.
   */
  android.get('/get', async (req, res) => {
    const code = normalizePairingCode(typeof req.query.c === 'string' ? req.query.c : '').replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const server = ctx.config.publicUrl;
    const release = await latestRelease(pool);
    const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const query = `server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;
    const intent = `intent://setup?${query}#Intent;scheme=${KIDS_SCHEME};package=${KIDS_PACKAGE};end`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Get the Family Screen Warden kids app</title><style>
body{margin:0;min-height:100vh;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#eef1fb;background:#0c1a2e;display:flex;justify-content:center}
main{max-width:440px;width:100%;padding:32px 20px;box-sizing:border-box}
h1{font-size:26px;font-weight:400;margin:0 0 8px}p{color:#8e9ac0;line-height:1.5;margin:0 0 14px}b{color:#eef1fb}
ol{padding-left:22px;color:#8e9ac0;line-height:1.6;margin:0 0 18px}
a.btn{display:flex;align-items:center;justify-content:center;min-height:48px;text-decoration:none;font-weight:600;font-size:16px;border-radius:8px;margin:10px 0;color:#06281c;background:#34d399}
a.btn.b{background:transparent;color:#eef1fb;border:1px solid #2a3468}
.code{font-weight:600;font-size:28px;letter-spacing:.14em;color:#34d399;background:#080c22;border:1px solid #141b3f;border-radius:10px;padding:12px;text-align:center;margin:6px 0 14px}
small{color:#8e9ac0;display:block;line-height:1.5;margin-top:14px}
</style></head><body><main>
<h1>Family Screen Warden</h1>
<p>The kids' phone app${release ? ` (version ${esc(release.version)})` : ''}.</p>
${release ? '' : '<p><b>The app is not published yet.</b> Try again a little later.</p>'}
<ol><li>Tap <b>Download</b>, then open the file. If Android asks, allow installing apps from your browser.</li>
<li>Tap <b>Install</b>.</li><li>Come back here and tap <b>Open the app</b>. The server address and the code are filled in.</li></ol>
<a class="btn" href="/api/android/download">Download the app</a>
<a class="btn b" href="${esc(intent)}">Open the app</a>
${code ? `<p style="margin-top:18px">If the app asks, your setup code is:</p><div class="code">${esc(code)}</div><p>Server address: <b>${esc(server)}</b></p>` : ''}
<small>Installed this way, the app counts time and shows the kid's launcher, but it cannot lock the phone down. For full lock-down (only allowed apps open, no factory reset), set the phone up with the setup QR code after a factory reset.</small>
</main></body></html>`);
  });

  /**
   * A picture, clip or sound from a text on the phone (raw body). Only what a picture text can carry is taken, the
   * first bytes must be what the type says, and it is only ever sent back as data (see sendMedia).
   */
  async function textMediaUpload(req: Request, res: Response): Promise<void> {
    requireUploadMarker(req);
    const { device, account } = await auth(req);
    const msgId = clean(req.params.msgId, 64);
    const mediaId = clean(req.params.mediaId, 64);
    if (!msgId || !mediaId) throw new HttpError(400, 'The photo needs the ids of its text.');
    const type = declaredType(req);
    if (!(TEXT_MEDIA_TYPES as readonly string[]).includes(type)) throw new HttpError(415, 'Only photos, videos and sound.');
    const have = await pool.query<{ id: string }>('SELECT id FROM text_media WHERE device_id = $1 AND phone_media_id = $2', [device.id, mediaId]);
    if (have.rows[0]) {
      req.resume();
      res.json({ ok: true, id: have.rows[0].id });
      return;
    }
    const used = await pool.query<{ bytes: string }>('SELECT COALESCE(SUM(size), 0)::text AS bytes FROM text_media WHERE account_id = $1 AND kid_id = $2', [
      account.id,
      device.kid_id,
    ]);
    if (Number(used.rows[0]?.bytes ?? 0) >= TEXT_MEDIA_QUOTA_BYTES) throw new HttpError(507, 'There is no room left for more photos from texts.');
    const id = crypto.randomUUID();
    const file = mediaFile(ctx.config.dataDir, id);
    const got = await receiveFile(req, file, MAX_TEXT_MEDIA_BYTES, 'That photo is too big (8 MB at most).');
    if (got.size === 0) {
      removeFile(file);
      throw new HttpError(400, 'The photo is empty.');
    }
    if (looksLike(type, got.head) === false) {
      removeFile(file);
      throw new HttpError(415, 'That file is not the photo, video or sound it says it is.');
    }
    const made = await pool.query<{ id: string }>(
      `INSERT INTO text_media (id, account_id, kid_id, device_id, phone_msg_id, phone_media_id, type, size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (device_id, phone_media_id) DO NOTHING RETURNING id`,
      [id, account.id, device.kid_id, device.id, msgId, mediaId, type, got.size],
    );
    if (!made.rows[0]) removeFile(file);
    res.status(201).json({ ok: true, id: made.rows[0]?.id ?? id });
  }

  return { warden, android, textMediaUpload, mediaUpload: media.upload, watch: media.watch, mediaParent: media.parent, locationParent: location.parent };
}
