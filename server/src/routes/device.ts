import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Ctx } from '../context';
import { isPairingCode, normalizePairingCode, randomToken, sha256Hex } from '../crypto';
import { withTransaction } from '../db';
import { Body, HttpError, isUuid, notFound, RateLimiter } from '../http';
import { checkParentPin, PIN_LOCK_MINUTES } from '../pin';
import { localTime } from '../rules';
import { loadKidStates, type AccountRow, type ContactRow, type DeviceRow } from '../state';
import { normalizeIdentifier } from './parent';

const PLATFORMS = ['windows', 'android'] as const;
const MAX_USAGE_ITEMS = 1000;
const MAX_INSTALLED_ITEMS = 3000;
const MAX_BLOCKED_ITEMS = 200;
const MAX_PENDING_REQUESTS = 5;

interface DeviceAuth {
  device: DeviceRow;
  account: AccountRow;
}

function deviceAuth(res: Response): DeviceAuth {
  const auth = res.locals.deviceAuth as DeviceAuth | undefined;
  if (!auth) throw new HttpError(401, 'This device is not paired.');
  return auth;
}

interface AppItem {
  kind: 'app' | 'site';
  identifier: string;
  name: string;
  platform: string;
}

function readAppItem(raw: unknown, devicePlatform: string): AppItem | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const kind = item.kind;
  if (kind !== 'app' && kind !== 'site') return null;
  if (typeof item.identifier !== 'string') return null;
  const platform = kind === 'site' ? 'any' : devicePlatform;
  const identifier = normalizeIdentifier(kind, platform, item.identifier).slice(0, 255);
  if (!identifier) return null;
  // eslint-disable-next-line no-control-regex
  const name = (typeof item.name === 'string' ? item.name : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return { kind, identifier, name: name || identifier, platform };
}

export function deviceRoutes(ctx: Ctx): Router {
  const r = Router();
  const pool = ctx.pool;
  const pairPerIp = new RateLimiter(ctx.ipLimits.pair, 15 * 60 * 1000);

  // ---------- pair (no auth) ----------

  r.post('/pair', async (req, res) => {
    if (!pairPerIp.take(req.ip ?? 'unknown')) {
      throw new HttpError(429, 'Too many pairing tries. Please wait 15 minutes.');
    }
    const body = new Body(req.body);
    const code = normalizePairingCode(body.string('code', 'The pairing code', { max: 32 }));
    const name = body.string('name', 'The device name', { max: 60 });
    const platform = body.oneOf('platform', 'The platform', PLATFORMS);
    const model = body.nullableString('model', 'The model', 80);
    const osVersion = body.nullableString('osVersion', 'The system version', 40);
    const appVersion = body.nullableString('appVersion', 'The app version', 40);
    const badCode = new HttpError(404, 'That pairing code is not right or has run out. Ask a parent for a new one.');
    if (!isPairingCode(code)) throw badCode;

    const token = randomToken();
    const result = await withTransaction(pool, async (db) => {
      const found = await db.query<{ account_id: string; kid_id: string; platform: string }>(
        'SELECT account_id, kid_id, platform FROM pairing_codes WHERE code = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE',
        [code],
      );
      const pairing = found.rows[0];
      if (!pairing) throw badCode;
      if (pairing.platform !== platform) {
        throw new HttpError(400, `That pairing code was made for ${pairing.platform === 'windows' ? 'a Windows PC' : 'an Android phone'}. Ask a parent for a new one.`);
      }
      await db.query('UPDATE pairing_codes SET used_at = now() WHERE code = $1', [code]);
      const kid = await db.query<{ id: string; name: string; color: string }>(
        'SELECT id, name, color FROM kids WHERE id = $1 AND account_id = $2',
        [pairing.kid_id, pairing.account_id],
      );
      const kidRow = kid.rows[0];
      if (!kidRow) throw badCode;
      const device = await db.query<{ id: string }>(
        `INSERT INTO devices (account_id, kid_id, name, platform, model, os_version, app_version, token_hash, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id`,
        [pairing.account_id, kidRow.id, name, platform, model, osVersion, appVersion, sha256Hex(token)],
      );
      const deviceId = device.rows[0]?.id;
      if (!deviceId) throw new Error('Insert returned no row');
      return { deviceId, kid: kidRow };
    });
    res.status(201).json({ deviceToken: token, deviceId: result.deviceId, kid: result.kid });
  });

  // ---------- bearer auth for everything below ----------

  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header);
    if (!match?.[1]) throw new HttpError(401, 'This device is not paired.');
    const found = await pool.query<DeviceRow>('SELECT * FROM devices WHERE token_hash = $1', [sha256Hex(match[1])]);
    const device = found.rows[0];
    const owner = device ? await pool.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [device.account_id]) : null;
    const acc = owner?.rows[0];
    if (!device || !acc) throw new HttpError(401, 'This device is not paired any more. Pair it again from the parent console.');
    res.locals.deviceAuth = { device, account: acc } satisfies DeviceAuth;
    next();
  });

  // ---------- sync ----------

  r.post('/sync', async (req, res) => {
    const { device, account } = deviceAuth(res);
    const body = new Body(req.body);
    const now = ctx.now();
    const today = localTime(now, account.timezone).day;

    const appVersion = body.nullableString('appVersion', 'The app version', 40);
    const hasFront = body.has('frontApp');
    const frontApp = body.nullableString('frontApp', 'The front app', 120);

    const usageRaw = body.array('usage', 'Usage', MAX_USAGE_ITEMS);
    const installedRaw = body.array('installed', 'Installed apps', MAX_INSTALLED_ITEMS);
    const blockedRaw = body.array('blocked', 'Blocked sites', MAX_BLOCKED_ITEMS);

    // Apps to make known, and usage totals, both keyed by kind + identifier (highest minutes wins on repeats).
    const known = new Map<string, AppItem>();
    const usage = new Map<string, { item: AppItem; minutes: number }>();
    for (const raw of usageRaw) {
      const item = readAppItem(raw, device.platform);
      const minutes = (raw as { minutes?: unknown } | null)?.minutes;
      if (!item || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
        throw new HttpError(400, 'Each usage entry needs kind, identifier and minutes.');
      }
      const key = `${item.kind}\n${item.identifier}`;
      const whole = Math.min(1440, Math.floor(minutes));
      const before = usage.get(key);
      if (!before || whole > before.minutes) usage.set(key, { item, minutes: whole });
      if (!known.has(key)) known.set(key, item);
    }
    for (const raw of installedRaw) {
      const item = readAppItem(raw, device.platform);
      if (!item) throw new HttpError(400, 'Each installed entry needs kind and identifier.');
      const key = `${item.kind}\n${item.identifier}`;
      if (!known.has(key)) known.set(key, item);
    }
    const blocked: Array<{ host: string; at: Date }> = [];
    for (const raw of blockedRaw) {
      const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const host = typeof item.host === 'string' ? normalizeIdentifier('site', 'any', item.host).slice(0, 255) : '';
      if (!host) throw new HttpError(400, 'Each blocked entry needs a host.');
      // A device clock can be wrong: never store a time in the future or older than a week.
      const nowMs = now.getTime();
      let at = typeof item.at === 'string' || typeof item.at === 'number' ? new Date(item.at) : new Date(nowMs);
      if (Number.isNaN(at.getTime()) || at.getTime() > nowMs || at.getTime() < nowMs - 7 * 24 * 60 * 60 * 1000) at = new Date(nowMs);
      blocked.push({ host, at });
    }

    await withTransaction(pool, async (db) => {
      await db.query(
        `UPDATE devices SET last_seen_at = now(),
                app_version = COALESCE($3, app_version),
                front_app = CASE WHEN $4 THEN $5 ELSE front_app END
          WHERE id = $1 AND account_id = $2`,
        [device.id, account.id, appVersion, hasFront, frontApp],
      );
      if (known.size > 0) {
        const items = [...known.values()];
        await db.query(
          `INSERT INTO apps (account_id, kid_id, kind, platform, identifier, name, allowed)
           SELECT $1, $2, t.kind, t.platform, t.identifier, t.name, false
             FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) AS t(kind, platform, identifier, name)
           ON CONFLICT (kid_id, kind, identifier) DO NOTHING`,
          [
            account.id,
            device.kid_id,
            items.map((i) => i.kind),
            items.map((i) => i.platform),
            items.map((i) => i.identifier),
            items.map((i) => i.name),
          ],
        );
      }
      if (usage.size > 0) {
        const rows = [...usage.values()];
        // Device reports are totals for the day, so keep the highest number seen.
        await db.query(
          `INSERT INTO usage (kid_id, device_id, app_id, day, minutes)
           SELECT $1, $2, a.id, $3, t.minutes
             FROM unnest($4::text[], $5::text[], $6::int[]) AS t(kind, identifier, minutes)
             JOIN apps a ON a.account_id = $7 AND a.kid_id = $1 AND a.kind = t.kind AND a.identifier = t.identifier
           ON CONFLICT (device_id, app_id, day) DO UPDATE SET minutes = GREATEST(usage.minutes, EXCLUDED.minutes)`,
          [
            device.kid_id,
            device.id,
            today,
            rows.map((u) => u.item.kind),
            rows.map((u) => u.item.identifier),
            rows.map((u) => u.minutes),
            account.id,
          ],
        );
      }
      if (blocked.length > 0) {
        await db.query(
          `INSERT INTO blocked_events (account_id, kid_id, device_id, host, at)
           SELECT $1, $2, $3, t.host, t.at FROM unnest($4::text[], $5::timestamptz[]) AS t(host, at)`,
          [account.id, device.kid_id, device.id, blocked.map((b) => b.host), blocked.map((b) => b.at.toISOString())],
        );
      }
    });

    // The parent may have changed "pause all" or the time zone since the device row was read: load fresh.
    const fresh = await pool.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [account.id]);
    const acc = fresh.rows[0] ?? account;
    const state = (await loadKidStates(pool, acc, now, device.kid_id))[0];
    if (!state) throw new HttpError(401, 'This device is not paired any more. Pair it again from the parent console.');
    const contacts = await pool.query<ContactRow>(
      'SELECT * FROM contacts WHERE account_id = $1 AND kid_id = $2 ORDER BY lower(name), id',
      [acc.id, device.kid_id],
    );
    const { kid, apps, rules } = state;

    res.json({
      serverTime: new Date().toISOString(),
      kid: { id: kid.id, name: kid.name, color: kid.color },
      rules: {
        limitMinutes: rules.limitMinutes,
        usedMinutes: rules.usedMinutes,
        leftMinutes: rules.leftMinutes,
        locked: rules.locked,
        lockReason: rules.lockReason,
        bedtime: rules.bedtime,
        apps: apps
          .filter((a) => a.platform === 'any' || a.platform === device.platform)
          .map((a) => ({
            kind: a.kind,
            platform: a.platform,
            identifier: a.identifier,
            name: a.name,
            allowed: a.allowed,
            free: a.free,
            limitMinutes: a.limit_minutes,
            usedMinutes: rules.apps[a.id]?.usedMinutes ?? 0,
          })),
        safe: {
          onlyAllowedSites: kid.only_allowed_sites,
          safeSearch: kid.safe_search,
          youtubeRestricted: kid.youtube_restricted,
          blockPrivate: kid.block_private,
        },
        contacts: contacts.rows.map((c) => ({ name: c.name, phone: c.phone, canCall: c.can_call, canText: c.can_text })),
      },
    });
  });

  // ---------- requests from the kid ----------

  r.post('/request', async (req, res) => {
    const { device, account } = deviceAuth(res);
    const body = new Body(req.body);
    const kind = body.oneOf('kind', 'The kind', ['time', 'app', 'site'] as const);
    let minutes: number | null = null;
    let detail = body.nullableString('detail', 'The detail', 120) ?? '';
    let identifier = body.nullableString('identifier', 'The identifier', 255);
    if (kind === 'time') {
      minutes = body.int('minutes', 'Minutes', 1, 240);
      identifier = null;
    } else {
      if (!detail && identifier) detail = identifier.slice(0, 120);
      if (!detail) throw new HttpError(400, kind === 'site' ? 'Say which website you want.' : 'Say which app you want.');
      identifier = normalizeIdentifier(kind, kind === 'site' ? 'any' : device.platform, identifier ?? detail).slice(0, 255) || null;
    }
    // Lock the kid row first, so two quick taps are counted one after the other and cannot pass the limit together.
    const inserted = await withTransaction(pool, async (db) => {
      await db.query('SELECT 1 FROM kids WHERE id = $1 AND account_id = $2 FOR UPDATE', [device.kid_id, account.id]);
      return db.query<{ id: string; status: string }>(
        `INSERT INTO requests (account_id, kid_id, device_id, kind, minutes, detail, identifier)
         SELECT $1, $2, $3, $4, $5, $6, $7
          WHERE (SELECT count(*) FROM requests WHERE account_id = $1 AND kid_id = $2 AND status = 'pending') < $8
         RETURNING id, status`,
        [account.id, device.kid_id, device.id, kind, minutes, detail, identifier, MAX_PENDING_REQUESTS],
      );
    });
    const row = inserted.rows[0];
    if (!row) throw new HttpError(429, 'You already have 5 requests waiting. Wait for a parent to answer.');
    res.status(201).json({ id: row.id, status: row.status });
  });

  r.get('/requests/:id', async (req, res) => {
    const { device, account } = deviceAuth(res);
    if (!isUuid(req.params.id)) throw notFound('request');
    const found = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM requests WHERE id = $1 AND account_id = $2 AND kid_id = $3',
      [req.params.id, account.id, device.kid_id],
    );
    const row = found.rows[0];
    if (!row) throw notFound('request');
    res.json({ id: row.id, status: row.status });
  });

  // ---------- parent PIN on the device ----------

  r.post('/pin', async (req, res) => {
    const { account } = deviceAuth(res);
    const pin = new Body(req.body).raw('pin');
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'The PIN must be 4 to 8 digits.');

    const checked = await checkParentPin(pool, account.id, pin);
    switch (checked.result) {
      case 'ok':
        res.json({ ok: true });
        return;
      case 'no-pin':
        throw new HttpError(403, 'No parent PIN is set yet. A parent can set one in the console.');
      case 'locked-out':
        res.setHeader('Retry-After', String(checked.retryAfterSeconds));
        throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil(checked.retryAfterSeconds / 60)} minutes.`, {
          retryAfterSeconds: checked.retryAfterSeconds,
        });
      default:
        if (checked.lockedNow) throw new HttpError(403, `Wrong PIN. PIN checks are locked for ${PIN_LOCK_MINUTES} minutes.`, { triesLeft: 0 });
        throw new HttpError(403, 'Wrong PIN.', { triesLeft: checked.triesLeft });
    }
  });

  return r;
}
