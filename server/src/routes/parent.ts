import { Router, type Response } from 'express';
import { account, type Ctx } from '../context';
import { appSlug, isPackageName } from '../compat/logic';
import { randomPairingCode } from '../crypto';
import { withTransaction } from '../db';
import { mediaFile, removeFile } from '../files';
import { removeKidMediaDir } from '../media';
import { Body, HttpError, isUuid, notFound } from '../http';
import { addDays, isClock, lastDays, localTime, statusText } from '../rules';
import {
  appJson,
  contactJson,
  deviceJson,
  deviceStatus,
  kidJson,
  loadKidStates,
  requestJson,
  todayJson,
  type AppRow,
  type ContactRow,
  type DeviceRow,
  type KidRow,
  type KidState,
  type RequestRow,
} from '../state';
import { patchAccount } from './auth';

const KID_COLORS = ['#34d399', '#6f82de', '#fbbf24', '#f87171', '#22d3ee', '#c084fc'];
const MAX_KIDS = 20;
const MAX_DEVICES = 50;
const MAX_APPS_PER_KID = 3000;
const MAX_CONTACTS_PER_KID = 50;

const PLATFORMS = ['windows', 'android'] as const;
const APP_PLATFORMS = ['windows', 'android', 'any'] as const;
const APP_KINDS = ['app', 'site'] as const;

/** A path id that is not a UUID can never match a row: answer 404 without asking the database. */
function idParam(value: unknown, what: string): string {
  if (!isUuid(value)) throw notFound(what);
  return value.toLowerCase();
}

function color(body: Body, key: string): string {
  const v = body.string(key, 'The colour', { max: 7 });
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new HttpError(400, 'The colour must look like #34d399.');
  return v.toLowerCase();
}

function clock(body: Body, key: string, label: string): string {
  const v = body.string(key, label, { max: 5 });
  if (!isClock(v)) throw new HttpError(400, `${label} must be a time like 20:30.`);
  return v;
}

/** Sites are stored as a bare lower-case host; Windows program names are lower-cased; Android packages are kept as sent. */
export function normalizeIdentifier(kind: 'app' | 'site', platform: string, raw: string): string {
  let v = raw.trim();
  if (kind === 'site') {
    v = v.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    v = v.split(/[/?#]/)[0] ?? '';
    v = v.replace(/^www\./, '').replace(/\.$/, '');
    return v;
  }
  return platform === 'android' ? v : v.toLowerCase();
}

function limitMinutesField(body: Body): number | null | undefined {
  if (!body.has('limitMinutes')) return undefined;
  if (body.raw('limitMinutes') === null) return null;
  return body.int('limitMinutes', 'The app limit', 0, 1440);
}

export function parentRoutes(ctx: Ctx): Router {
  const r = Router();
  const pool = ctx.pool;

  async function kidState(res: Response, rawId: unknown): Promise<KidState> {
    const id = idParam(rawId, 'kid');
    const states = await loadKidStates(pool, account(res), ctx.now(), id);
    const state = states[0];
    if (!state) throw notFound('kid');
    return state;
  }

  /** Makes sure the kid belongs to the signed-in account. */
  async function ownKid(res: Response, rawId: unknown): Promise<KidRow> {
    const id = idParam(rawId, 'kid');
    const found = await pool.query<KidRow>('SELECT * FROM kids WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    const kid = found.rows[0];
    if (!kid) throw notFound('kid');
    return kid;
  }

  // ---------- account ----------

  r.patch('/account', async (req, res) => {
    res.json(await patchAccount(ctx, account(res), req.body));
  });

  r.post('/pause-all', async (req, res) => {
    const paused = new Body(req.body).bool('paused', 'Paused');
    await pool.query('UPDATE accounts SET paused_all = $2 WHERE id = $1', [account(res).id, paused]);
    res.json({ ok: true, pausedAll: paused });
  });

  // ---------- dashboard ----------

  r.get('/dashboard', async (_req, res) => {
    const acc = account(res);
    const now = ctx.now();
    const today = localTime(now, acc.timezone).day;
    const days = lastDays(today, 7);
    const from = days[0] ?? today;

    const [states, devicesRes, requestsRes, weekRes, blockedRes] = await Promise.all([
      loadKidStates(pool, acc, now),
      pool.query<DeviceRow>('SELECT * FROM devices WHERE account_id = $1 ORDER BY created_at, id', [acc.id]),
      pool.query<RequestRow>(
        `SELECT r.*, k.name AS kid_name, d.name AS device_name
           FROM requests r
           JOIN kids k ON k.id = r.kid_id AND k.account_id = r.account_id
           LEFT JOIN devices d ON d.id = r.device_id AND d.account_id = r.account_id
          WHERE r.account_id = $1 AND r.status = 'pending'
          ORDER BY r.created_at DESC, r.id
          LIMIT 100`,
        [acc.id],
      ),
      pool.query<{ kid_id: string; day: string; minutes: number }>(
        `SELECT u.kid_id, u.day, SUM(u.minutes)::int AS minutes
           FROM usage u
           JOIN kids k ON k.id = u.kid_id
           LEFT JOIN apps a ON a.id = u.app_id
          WHERE k.account_id = $1 AND u.day BETWEEN $2 AND $3 AND COALESCE(a.free, false) = false
          GROUP BY u.kid_id, u.day`,
        [acc.id, from, today],
      ),
      pool.query<{ day: string; count: number }>(
        `SELECT (at AT TIME ZONE $2)::date AS day, count(*)::int AS count
           FROM blocked_events
          WHERE account_id = $1 AND (at AT TIME ZONE $2)::date BETWEEN $3 AND $4
          GROUP BY 1`,
        [acc.id, acc.timezone, from, today],
      ),
    ]);

    const byKid = new Map(states.map((s) => [s.kid.id, s]));
    let totalLimit = 0;
    let totalUsed = 0;
    for (const s of states) {
      totalLimit += s.rules.limitMinutes;
      totalUsed += Math.min(s.rules.usedMinutes, s.rules.limitMinutes);
    }

    // What each kid has open right now: the front app of a device seen in the last 3 minutes.
    const frontApp = new Map<string, string>();
    for (const d of devicesRes.rows) {
      if (d.front_app && deviceStatus(d, false, Date.now()) !== 'off' && !frontApp.has(d.kid_id)) frontApp.set(d.kid_id, d.front_app);
    }

    res.json({
      kids: states.map((s) => ({
        id: s.kid.id,
        name: s.kid.name,
        color: s.kid.color,
        ...todayJson(s.rules),
        statusText: statusText(s.rules, frontApp.get(s.kid.id) ?? null),
        bedtimeTonight: s.rules.bedtime.enabled ? s.rules.bedtime.start : null,
      })),
      devices: devicesRes.rows.map((d) => {
        const s = byKid.get(d.kid_id);
        return deviceJson(d, s?.kid.name ?? '', deviceStatus(d, s?.rules.locked ?? false, Date.now()));
      }),
      requests: requestsRes.rows.map(requestJson),
      week: days.map((day) => {
        const minutes: Record<string, number> = {};
        for (const s of states) minutes[s.kid.id] = 0;
        for (const row of weekRes.rows) if (row.day === day && row.kid_id in minutes) minutes[row.kid_id] = row.minutes;
        return { day, minutes };
      }),
      blocked: days.map((day) => ({ day, count: blockedRes.rows.find((b) => b.day === day)?.count ?? 0 })),
      appLimits: states.flatMap((s) =>
        s.apps
          .filter((a) => a.limit_minutes !== null)
          .map((a) => ({
            kidId: s.kid.id,
            kidName: s.kid.name,
            appId: a.id,
            appName: a.name,
            usedMinutes: s.rules.apps[a.id]?.usedMinutes ?? 0,
            limitMinutes: a.limit_minutes,
          })),
      ),
      familyPercent: totalLimit > 0 ? Math.round((totalUsed / totalLimit) * 100) : 0,
      pausedAll: acc.paused_all,
    });
  });

  // ---------- kids ----------

  r.get('/kids', async (_req, res) => {
    const states = await loadKidStates(pool, account(res), ctx.now());
    res.json({ kids: states.map((s) => ({ ...kidJson(s.kid), today: todayJson(s.rules) })) });
  });

  r.post('/kids', async (req, res) => {
    const acc = account(res);
    const body = new Body(req.body);
    const name = body.string('name', "The kid's name", { max: 40 });
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM kids WHERE account_id = $1', [acc.id]);
    const n = count.rows[0]?.n ?? 0;
    if (n >= MAX_KIDS) throw new HttpError(400, `A family can have at most ${MAX_KIDS} kids.`);
    const chosen = body.has('color') ? color(body, 'color') : (KID_COLORS[n % KID_COLORS.length] ?? '#34d399');
    const created = await pool.query<KidRow>(
      'INSERT INTO kids (account_id, name, color) VALUES ($1, $2, $3) RETURNING *',
      [acc.id, name, chosen],
    );
    const kid = created.rows[0];
    if (!kid) throw new Error('Insert returned no row');
    res.status(201).json({ kid: kidJson(kid) });
  });

  r.get('/kids/:id', async (req, res) => {
    const acc = account(res);
    const state = await kidState(res, req.params.id);
    const contacts = await pool.query<ContactRow>(
      'SELECT * FROM contacts WHERE account_id = $1 AND kid_id = $2 ORDER BY lower(name), id',
      [acc.id, state.kid.id],
    );
    res.json({
      kid: kidJson(state.kid),
      apps: state.apps.map((a) => appJson(a, state.rules.apps[a.id]?.usedMinutes ?? 0)),
      contacts: contacts.rows.map(contactJson),
      today: todayJson(state.rules),
    });
  });

  r.patch('/kids/:id', async (req, res) => {
    const acc = account(res);
    const id = idParam(req.params.id, 'kid');
    const body = new Body(req.body);
    const sets: string[] = [];
    const values: unknown[] = [id, acc.id];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (body.has('name')) set('name', body.string('name', "The kid's name", { max: 40 }));
    if (body.has('color')) set('color', color(body, 'color'));
    if (body.has('limitSchoolMinutes')) set('limit_school_minutes', body.int('limitSchoolMinutes', 'The school day limit', 0, 1440));
    if (body.has('limitWeekendMinutes')) set('limit_weekend_minutes', body.int('limitWeekendMinutes', 'The weekend limit', 0, 1440));
    if (body.has('bedSchoolStart')) set('bed_school_start', clock(body, 'bedSchoolStart', 'School night bedtime'));
    if (body.has('bedSchoolEnd')) set('bed_school_end', clock(body, 'bedSchoolEnd', 'School night wake-up time'));
    if (body.has('bedOtherStart')) set('bed_other_start', clock(body, 'bedOtherStart', 'Other night bedtime'));
    if (body.has('bedOtherEnd')) set('bed_other_end', clock(body, 'bedOtherEnd', 'Other night wake-up time'));
    if (body.has('bedtimeEnabled')) set('bedtime_enabled', body.bool('bedtimeEnabled', 'Bedtime on/off'));
    if (body.has('onlyAllowedSites')) {
      // The same thing as the website rule on "Levels and web": on is 'sites'; off opens the web unless a filter is set.
      const only = body.bool('onlyAllowedSites', 'Only allowed websites');
      set('only_allowed_sites', only);
      values.push(only);
      sets.push(`web_mode = CASE WHEN $${values.length} THEN 'sites' WHEN web_mode = 'sites' THEN 'open' ELSE web_mode END`);
    }
    if (body.has('safeSearch')) set('safe_search', body.bool('safeSearch', 'SafeSearch'));
    if (body.has('youtubeRestricted')) set('youtube_restricted', body.bool('youtubeRestricted', 'YouTube Restricted Mode'));
    if (body.has('blockPrivate')) set('block_private', body.bool('blockPrivate', 'Block private browsing'));
    if (body.has('locked')) set('locked', body.bool('locked', 'Locked'));
    if (sets.length === 0) throw new HttpError(400, 'Nothing to change.');
    const updated = await pool.query<KidRow>(
      `UPDATE kids SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2 RETURNING *`,
      values,
    );
    const kid = updated.rows[0];
    if (!kid) throw notFound('kid');
    res.json({ kid: kidJson(kid) });
  });

  r.delete('/kids/:id', async (req, res) => {
    const id = idParam(req.params.id, 'kid');
    const photos = await pool.query<{ id: string }>('SELECT id FROM text_media WHERE kid_id = $1 AND account_id = $2', [id, account(res).id]);
    const deleted = await pool.query('DELETE FROM kids WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    if (deleted.rowCount !== 1) throw notFound('kid');
    for (const p of photos.rows) removeFile(mediaFile(ctx.config.dataDir, p.id));
    // The kid's photos and videos go with the kid: the rows went with the delete above, the files go here.
    removeKidMediaDir(ctx.config.dataDir, account(res).id, id);
    res.json({ ok: true });
  });

  r.post('/kids/:id/grant', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const minutes = new Body(req.body).int('minutes', 'Extra minutes', 1, 240);
    const today = localTime(ctx.now(), acc.timezone).day;
    await pool.query("INSERT INTO time_grants (kid_id, day, minutes, reason) VALUES ($1, $2, $3, 'parent')", [
      kid.id,
      today,
      minutes,
    ]);
    const state = await kidState(res, kid.id);
    res.json({ ok: true, today: todayJson(state.rules) });
  });

  r.post('/kids/:id/lock', async (req, res) => {
    const id = idParam(req.params.id, 'kid');
    const locked = new Body(req.body).bool('locked', 'Locked');
    const updated = await pool.query('UPDATE kids SET locked = $3 WHERE id = $1 AND account_id = $2', [
      id,
      account(res).id,
      locked,
    ]);
    if (updated.rowCount !== 1) throw notFound('kid');
    const state = await kidState(res, id);
    res.json({ ok: true, kid: kidJson(state.kid), today: todayJson(state.rules) });
  });

  // ---------- apps ----------

  r.post('/kids/:id/apps', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const body = new Body(req.body);
    const kind = body.oneOf('kind', 'The kind', APP_KINDS);
    const platform = kind === 'site' ? 'any' : (body.optOneOf('platform', 'The platform', APP_PLATFORMS) ?? 'any');
    const identifier = normalizeIdentifier(kind, platform, body.string('identifier', kind === 'site' ? 'The website address' : 'The app identifier', { max: 255 }));
    if (!identifier) throw new HttpError(400, 'The website address is needed, for example khanacademy.org.');
    const name = body.string('name', 'The name', { max: 80 });
    const allowed = body.optBool('allowed', 'Allowed') ?? true;
    const free = body.optBool('free', 'Free') ?? false;
    const limit = limitMinutesField(body) ?? null;
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM apps WHERE account_id = $1 AND kid_id = $2', [acc.id, kid.id]);
    if ((count.rows[0]?.n ?? 0) >= MAX_APPS_PER_KID) throw new HttpError(400, 'This kid already has too many apps and sites.');
    const created = await pool.query<AppRow>(
      `INSERT INTO apps (account_id, kid_id, kind, platform, identifier, name, allowed, free, limit_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (kid_id, kind, identifier) DO NOTHING
       RETURNING *`,
      [acc.id, kid.id, kind, platform, identifier, name, allowed, free, limit],
    );
    const app = created.rows[0];
    if (!app) throw new HttpError(409, `${kid.name} already has that ${kind === 'site' ? 'website' : 'app'} in the list.`);
    res.status(201).json({ app: appJson(app, 0) });
  });

  r.patch('/apps/:id', async (req, res) => {
    const acc = account(res);
    const id = idParam(req.params.id, 'app');
    const body = new Body(req.body);
    const sets: string[] = [];
    const values: unknown[] = [id, acc.id];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (body.has('name')) set('name', body.string('name', 'The name', { max: 80 }));
    if (body.has('allowed')) set('allowed', body.bool('allowed', 'Allowed'));
    if (body.has('free')) set('free', body.bool('free', 'Free'));
    if (body.has('platform')) set('platform', body.oneOf('platform', 'The platform', APP_PLATFORMS));
    const limit = limitMinutesField(body);
    if (limit !== undefined) set('limit_minutes', limit);
    if (sets.length === 0) throw new HttpError(400, 'Nothing to change.');
    const updated = await pool.query<AppRow>(
      `UPDATE apps SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2 RETURNING *`,
      values,
    );
    const app = updated.rows[0];
    if (!app) throw notFound('app');
    const state = (await loadKidStates(pool, acc, ctx.now(), app.kid_id))[0];
    res.json({ app: appJson(app, state?.rules.apps[app.id]?.usedMinutes ?? 0) });
  });

  r.delete('/apps/:id', async (req, res) => {
    const acc = account(res);
    const id = idParam(req.params.id, 'app');
    const today = localTime(ctx.now(), acc.timezone).day;
    const ok = await withTransaction(pool, async (db) => {
      const found = await db.query<{ id: string }>('SELECT id FROM apps WHERE id = $1 AND account_id = $2 FOR UPDATE', [id, acc.id]);
      if (found.rowCount !== 1) return false;
      // Devices report day totals, so today's minutes come back with the next sync if the app is still in use.
      // Older days keep their minutes (shown as "Removed app" in reports).
      await db.query('DELETE FROM usage WHERE app_id = $1 AND day = $2', [id, today]);
      await db.query('DELETE FROM apps WHERE id = $1 AND account_id = $2', [id, acc.id]);
      return true;
    });
    if (!ok) throw notFound('app');
    res.json({ ok: true });
  });

  // ---------- contacts ----------

  function phone(body: Body): string {
    const v = body.string('phone', 'The phone number', { max: 32 });
    if (!/^\+?[0-9 ().-]{3,32}$/.test(v) || v.replace(/\D/g, '').length < 3) {
      throw new HttpError(400, 'The phone number may only have digits, spaces, and + ( ) - .');
    }
    return v;
  }

  r.post('/kids/:id/contacts', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const body = new Body(req.body);
    const name = body.string('name', 'The name', { max: 60 });
    const number = phone(body);
    const canCall = body.optBool('canCall', 'Can call') ?? true;
    const canText = body.optBool('canText', 'Can text') ?? true;
    const always = body.optBool('always', 'Always reachable') ?? true;
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE account_id = $1 AND kid_id = $2', [acc.id, kid.id]);
    if ((count.rows[0]?.n ?? 0) >= MAX_CONTACTS_PER_KID) throw new HttpError(400, `A kid can have at most ${MAX_CONTACTS_PER_KID} contacts.`);
    const created = await pool.query<ContactRow>(
      'INSERT INTO contacts (account_id, kid_id, name, phone, can_call, can_text, always) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [acc.id, kid.id, name, number, canCall, canText, always],
    );
    const contact = created.rows[0];
    if (!contact) throw new Error('Insert returned no row');
    res.status(201).json({ contact: contactJson(contact) });
  });

  r.patch('/contacts/:id', async (req, res) => {
    const id = idParam(req.params.id, 'contact');
    const body = new Body(req.body);
    const sets: string[] = [];
    const values: unknown[] = [id, account(res).id];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (body.has('name')) set('name', body.string('name', 'The name', { max: 60 }));
    if (body.has('phone')) set('phone', phone(body));
    if (body.has('canCall')) set('can_call', body.bool('canCall', 'Can call'));
    if (body.has('canText')) set('can_text', body.bool('canText', 'Can text'));
    if (body.has('always')) set('always', body.bool('always', 'Always reachable'));
    if (sets.length === 0) throw new HttpError(400, 'Nothing to change.');
    const updated = await pool.query<ContactRow>(
      `UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2 RETURNING *`,
      values,
    );
    const contact = updated.rows[0];
    if (!contact) throw notFound('contact');
    res.json({ contact: contactJson(contact) });
  });

  r.delete('/contacts/:id', async (req, res) => {
    const id = idParam(req.params.id, 'contact');
    const deleted = await pool.query('DELETE FROM contacts WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    if (deleted.rowCount !== 1) throw notFound('contact');
    res.json({ ok: true });
  });

  // ---------- devices ----------

  async function deviceList(res: Response, onlyId?: string): Promise<Record<string, unknown>[]> {
    const acc = account(res);
    const [states, devices] = await Promise.all([
      loadKidStates(pool, acc, ctx.now()),
      onlyId
        ? pool.query<DeviceRow>('SELECT * FROM devices WHERE account_id = $1 AND id = $2', [acc.id, onlyId])
        : pool.query<DeviceRow>('SELECT * FROM devices WHERE account_id = $1 ORDER BY created_at, id', [acc.id]),
    ]);
    const byKid = new Map(states.map((s) => [s.kid.id, s]));
    return devices.rows.map((d) => {
      const s = byKid.get(d.kid_id);
      return deviceJson(d, s?.kid.name ?? '', deviceStatus(d, s?.rules.locked ?? false, Date.now()));
    });
  }

  r.get('/devices', async (_req, res) => {
    res.json({ devices: await deviceList(res) });
  });

  r.post('/devices/pairing-code', async (req, res) => {
    const acc = account(res);
    const body = new Body(req.body);
    const kid = await ownKid(res, body.raw('kidId'));
    const platform = body.oneOf('platform', 'The platform', PLATFORMS);
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM devices WHERE account_id = $1', [acc.id]);
    if ((count.rows[0]?.n ?? 0) >= MAX_DEVICES) throw new HttpError(400, `A family can have at most ${MAX_DEVICES} devices.`);
    // Old unused codes for this account are of no use any more.
    await pool.query('DELETE FROM pairing_codes WHERE account_id = $1 AND (expires_at < now() OR used_at IS NOT NULL)', [acc.id]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomPairingCode();
      const inserted = await pool.query<{ expires_at: Date }>(
        `INSERT INTO pairing_codes (code, account_id, kid_id, platform, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 minutes')
         ON CONFLICT (code) DO NOTHING
         RETURNING expires_at`,
        [code, acc.id, kid.id, platform],
      );
      const row = inserted.rows[0];
      if (row) {
        res.status(201).json({ code, expiresAt: row.expires_at.toISOString() });
        return;
      }
    }
    throw new Error('Could not make a unique pairing code');
  });

  r.patch('/devices/:id', async (req, res) => {
    const acc = account(res);
    const id = idParam(req.params.id, 'device');
    const body = new Body(req.body);
    const sets: string[] = [];
    const values: unknown[] = [id, acc.id];
    if (body.has('name')) {
      values.push(body.string('name', 'The device name', { max: 60 }));
      sets.push(`name = $${values.length}`);
    }
    if (body.has('kidId')) {
      const kid = await ownKid(res, body.raw('kidId'));
      values.push(kid.id);
      sets.push(`kid_id = $${values.length}`);
    }
    if (sets.length === 0) throw new HttpError(400, 'Nothing to change.');
    const updated = await pool.query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2`, values);
    if (updated.rowCount !== 1) throw notFound('device');
    const list = await deviceList(res, id);
    res.json({ device: list[0] });
  });

  r.delete('/devices/:id', async (req, res) => {
    const id = idParam(req.params.id, 'device');
    const deleted = await pool.query('DELETE FROM devices WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    if (deleted.rowCount !== 1) throw notFound('device');
    res.json({ ok: true });
  });

  // ---------- requests ----------

  r.get('/requests', async (req, res) => {
    const acc = account(res);
    const status = req.query.status === undefined ? 'pending' : req.query.status;
    if (status !== 'pending' && status !== 'all') throw new HttpError(400, 'Status must be pending or all.');
    const rows = await pool.query<RequestRow>(
      `SELECT r.*, k.name AS kid_name, d.name AS device_name
         FROM requests r
         JOIN kids k ON k.id = r.kid_id AND k.account_id = r.account_id
         LEFT JOIN devices d ON d.id = r.device_id AND d.account_id = r.account_id
        WHERE r.account_id = $1 AND ($2 = 'all' OR r.status = 'pending')
        ORDER BY r.created_at DESC, r.id
        LIMIT 200`,
      [acc.id, status],
    );
    res.json({ requests: rows.rows.map(requestJson) });
  });

  r.post('/requests/:id/decide', async (req, res) => {
    const acc = account(res);
    const id = idParam(req.params.id, 'request');
    const approve = new Body(req.body).bool('approve', 'Approve');
    const today = localTime(ctx.now(), acc.timezone).day;

    await withTransaction(pool, async (db) => {
      const found = await db.query<RequestRow & { device_platform: string | null }>(
        `SELECT r.*, d.platform AS device_platform
           FROM requests r LEFT JOIN devices d ON d.id = r.device_id AND d.account_id = r.account_id
          WHERE r.id = $1 AND r.account_id = $2
          FOR UPDATE OF r`,
        [id, acc.id],
      );
      const request = found.rows[0];
      if (!request) throw notFound('request');
      if (request.status !== 'pending') throw new HttpError(409, 'That request was already answered.');
      await db.query('UPDATE requests SET status = $3, decided_at = now() WHERE id = $1 AND account_id = $2', [
        id,
        acc.id,
        approve ? 'approved' : 'denied',
      ]);
      if (!approve) return;
      if (request.kind === 'time') {
        const minutes = Math.min(240, Math.max(1, request.minutes ?? 15));
        await db.query("INSERT INTO time_grants (kid_id, day, minutes, reason) VALUES ($1, $2, $3, 'request')", [
          request.kid_id,
          today,
          minutes,
        ]);
      } else if (request.kind === 'contact') {
        // "Ask to add a friend" from the phone's texting app: yes makes a contact the kid can text (not call).
        const number = request.identifier ?? '';
        if (!number) throw new HttpError(400, 'That request does not say which phone number it is for.');
        // A contact with this number that could neither be called nor texted (switched off earlier) may be texted again.
        await db.query(
          `UPDATE contacts SET can_text = true WHERE account_id = $1 AND kid_id = $2 AND NOT can_call AND NOT can_text
              AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $3`,
          [acc.id, request.kid_id, number],
        );
        await db.query(
          `INSERT INTO contacts (account_id, kid_id, name, phone, can_call, can_text, always)
           SELECT $1, $2, $3, $4, false, true, false
            WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE account_id = $1 AND kid_id = $2
                               AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $4)`,
          [acc.id, request.kid_id, request.detail || number, number],
        );
        await db.query('DELETE FROM blocked_numbers WHERE kid_id = $1 AND num = $2', [request.kid_id, number]);
      } else {
        const platform = request.kind === 'site' ? 'any' : (request.device_platform ?? 'any');
        const identifier = normalizeIdentifier(request.kind, platform, request.identifier ?? request.detail);
        if (!identifier) throw new HttpError(400, 'That request does not say which app or website it is for.');
        // An app asked for by name ("Roblox") that a phone already reported by package: allow that one, not a second row.
        let known = false;
        if (request.kind === 'app' && platform === 'android' && !isPackageName(identifier)) {
          const slug = appSlug(request.detail || identifier);
          const rows = await db.query<{ id: string; name: string }>(
            "SELECT id, name FROM apps WHERE account_id = $1 AND kid_id = $2 AND kind = 'app' AND platform = 'android'",
            [acc.id, request.kid_id],
          );
          const twin = slug ? rows.rows.find((r) => appSlug(r.name) === slug) : undefined;
          if (twin) {
            await db.query('UPDATE apps SET allowed = true WHERE id = $1', [twin.id]);
            known = true;
          }
        }
        // A website a parent says yes to is no longer on the kid's blocked list.
        if (request.kind === 'site') {
          await db.query('UPDATE kids SET web_blocked = array_remove(web_blocked, $3) WHERE id = $1 AND account_id = $2', [request.kid_id, acc.id, identifier]);
        }
        if (!known) {
          await db.query(
            `INSERT INTO apps (account_id, kid_id, kind, platform, identifier, name, allowed)
             VALUES ($1, $2, $3, $4, $5, $6, true)
             ON CONFLICT (kid_id, kind, identifier) DO UPDATE SET allowed = true`,
            [acc.id, request.kid_id, request.kind, platform, identifier, request.detail || identifier],
          );
        }
      }
    });

    const row = await pool.query<RequestRow>(
      `SELECT r.*, k.name AS kid_name, d.name AS device_name
         FROM requests r
         JOIN kids k ON k.id = r.kid_id AND k.account_id = r.account_id
         LEFT JOIN devices d ON d.id = r.device_id AND d.account_id = r.account_id
        WHERE r.id = $1 AND r.account_id = $2`,
      [id, acc.id],
    );
    const request = row.rows[0];
    if (!request) throw notFound('request');
    res.json({ request: requestJson(request) });
  });

  // ---------- reports ----------

  r.get('/reports', async (req, res) => {
    const acc = account(res);
    const daysParam = req.query.days === undefined || req.query.days === '' ? '7' : req.query.days;
    if (daysParam !== '7' && daysParam !== '30') throw new HttpError(400, 'Days must be 7 or 30.');
    const count = Number(daysParam);
    let kidId: string | null = null;
    if (typeof req.query.kidId === 'string' && req.query.kidId !== '') {
      kidId = (await ownKid(res, req.query.kidId)).id;
    }
    const today = localTime(ctx.now(), acc.timezone).day;
    const from = addDays(today, -(count - 1));

    const [usage, blocked] = await Promise.all([
      pool.query<{ day: string; name: string; free: boolean; minutes: number }>(
        `SELECT u.day, COALESCE(a.name, 'Removed app') AS name, COALESCE(a.free, false) AS free, SUM(u.minutes)::int AS minutes
           FROM usage u
           JOIN kids k ON k.id = u.kid_id
           LEFT JOIN apps a ON a.id = u.app_id
          WHERE k.account_id = $1 AND ($2::uuid IS NULL OR u.kid_id = $2) AND u.day BETWEEN $3 AND $4
          GROUP BY u.day, COALESCE(a.name, 'Removed app'), COALESCE(a.free, false)
         HAVING SUM(u.minutes) > 0
          ORDER BY u.day, minutes DESC, name`,
        [acc.id, kidId, from, today],
      ),
      pool.query<{ host: string; count: number; last_at: Date }>(
        `SELECT host, count(*)::int AS count, max(at) AS last_at
           FROM blocked_events
          WHERE account_id = $1 AND ($2::uuid IS NULL OR kid_id = $2) AND (at AT TIME ZONE $5)::date BETWEEN $3 AND $4
          GROUP BY host
          ORDER BY count DESC, last_at DESC
          LIMIT 100`,
        [acc.id, kidId, from, today, acc.timezone],
      ),
    ]);

    res.json({
      days: lastDays(today, count).map((day) => {
        const rows = usage.rows.filter((u) => u.day === day);
        return {
          day,
          // Free apps never count against the limit, so they are left out of the day total but still listed.
          minutes: rows.reduce((sum, u) => sum + (u.free ? 0 : u.minutes), 0),
          byApp: rows.map((u) => ({ name: u.name, minutes: u.minutes, free: u.free })),
        };
      }),
      blocked: blocked.rows.map((b) => ({ host: b.host, count: b.count, lastAt: b.last_at.toISOString() })),
    });
  });

  return r;
}
