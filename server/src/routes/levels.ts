/**
 * Kids' levels and safe browsing: the parents' routes (the logic is in ../levels.ts).
 *
 * A level (Little kid, Big kid, Teen) sets a kid's screen time, bedtime, websites, SafeSearch and who they can
 * text, in one go, on all their devices. Anything can still be changed by hand afterwards; the console shows what
 * differs from the level. With a birthday the console suggests the next level when the kid reaches it (a level is
 * never changed by the server itself).
 *
 * Safe browsing is one set of rules for every device: the sync answer's `web` (see webFor) goes to phones and PCs alike.
 *
 *   - GET  /kids/:id/safety            the level, changes from it, web rules, devices, blocked today
 *   - POST /kids/:id/safety/level      {level, only?}: use a level (only: put one setting back to the level's)
 *   - PUT  /kids/:id/safety/birthday   {birthday | null}
 *   - PUT  /kids/:id/safety/web        {mode?, categories?, safeSearch?, youTube?, blockPrivate?}
 *   - POST /kids/:id/safety/site       {host, allow, remove?}: always allow (the kid's list) or always block
 *   - PUT  /kids/:id/safety/texting    {who: family | friends | anyone}
 */
import { Router, type Response } from 'express';
import { account, type Ctx } from '../context';
import { Body, HttpError, isUuid, notFound } from '../http';
import {
  CATEGORY_IDS,
  LEVELS,
  WEB_CATEGORIES,
  categoryOf,
  changesFrom,
  levelForBirthday,
  levelOf,
  nextLevelDate,
  normalizeHost,
  webRules,
  type LevelSettings,
  type TextingWho,
  type WebMode,
  type WebRules,
} from '../levels';
import { localTime } from '../rules';
import type { AppRow, Db, KidRow } from '../state';
import { normalizeIdentifier } from './parent';

const MODES = ['sites', 'filtered', 'open'] as const;
const WHO = ['family', 'friends', 'anyone'] as const;
const LEVEL_IDS = ['little', 'big', 'teen'] as const;
export const MAX_BLOCKED_SITES = 500;
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A website as a parent or a phone wrote it ("https://www.TikTok.com/@x") as a bare host, or '' when it is none. */
export function cleanHost(raw: string): string {
  const host = normalizeIdentifier('site', 'any', raw).slice(0, 255);
  return HOST_RE.test(host) ? host : '';
}

/** The kid's list: the websites a parent allowed. */
export function allowedHosts(apps: Array<Pick<AppRow, 'kind' | 'allowed' | 'identifier'>>): string[] {
  return apps.filter((a) => a.kind === 'site' && a.allowed).map((a) => a.identifier);
}

/** In every device's sync answer: the web rules, the same for phones and PCs. */
export function webFor(kid: Pick<KidRow, 'web_mode' | 'web_categories' | 'web_blocked'>, apps: Array<Pick<AppRow, 'kind' | 'allowed' | 'identifier'>>): WebRules {
  return webRules(kid.web_mode, kid.web_categories, kid.web_blocked, allowedHosts(apps));
}

/** A kid's settings now, in the shape a level has. Bedtime has one switch here: off means off on every night. */
export function settingsNow(k: KidRow): LevelSettings {
  return {
    schoolMinutes: k.limit_school_minutes,
    offMinutes: k.limit_weekend_minutes,
    schoolBedtime: k.bedtime_enabled ? k.bed_school_start : '',
    otherBedtime: k.bedtime_enabled ? k.bed_other_start : '',
    webMode: k.web_mode,
    categories: k.web_categories,
    safeSearch: k.safe_search,
    youTube: k.youtube_restricted,
    texting: k.texting_who,
  };
}

/** Writes some of a level's settings to the kid. Wake-up times, apps and the kid's website list are left alone. */
export async function saveSettings(db: Db, accountId: string, kidId: string, v: Partial<LevelSettings>): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [kidId, accountId];
  const set = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (v.schoolMinutes !== undefined) set('limit_school_minutes', v.schoolMinutes);
  if (v.offMinutes !== undefined) set('limit_weekend_minutes', v.offMinutes);
  if (v.schoolBedtime) set('bed_school_start', v.schoolBedtime);
  if (v.otherBedtime) set('bed_other_start', v.otherBedtime);
  if (v.schoolBedtime !== undefined || v.otherBedtime !== undefined) set('bedtime_enabled', Boolean(v.schoolBedtime ?? v.otherBedtime));
  if (v.webMode !== undefined) {
    set('web_mode', v.webMode);
    // The older switch "Only allowed websites" says the same thing as mode 'sites'; the two are kept in step.
    set('only_allowed_sites', v.webMode === 'sites');
  }
  if (v.categories !== undefined) set('web_categories', [...new Set(v.categories.filter((c) => CATEGORY_IDS.includes(c)))]);
  if (v.safeSearch !== undefined) set('safe_search', v.safeSearch);
  if (v.youTube !== undefined) set('youtube_restricted', v.youTube);
  if (v.texting !== undefined) set('texting_who', v.texting);
  if (sets.length === 0) return;
  await db.query(`UPDATE kids SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2`, values);
}

export function levelRoutes(ctx: Ctx): Router {
  const r = Router();
  const pool = ctx.pool;

  /** The kid, only when it belongs to the signed-in family. */
  async function ownKid(res: Response, rawId: unknown): Promise<KidRow> {
    if (!isUuid(rawId)) throw notFound('kid');
    const found = await pool.query<KidRow>('SELECT * FROM kids WHERE id = $1 AND account_id = $2', [rawId.toLowerCase(), account(res).id]);
    const kid = found.rows[0];
    if (!kid) throw notFound('kid');
    return kid;
  }

  r.get('/kids/:id/safety', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const [sites, devices, blocked] = await Promise.all([
      pool.query<{ identifier: string }>("SELECT identifier FROM apps WHERE account_id = $1 AND kid_id = $2 AND kind = 'site' AND allowed ORDER BY identifier", [
        acc.id,
        kid.id,
      ]),
      pool.query<{ id: string; name: string; platform: string; last_seen_at: Date | null; app_version: string | null }>(
        'SELECT id, name, platform, last_seen_at, app_version FROM devices WHERE account_id = $1 AND kid_id = $2 ORDER BY lower(name), id',
        [acc.id, kid.id],
      ),
      // Blocked in the last day, from every device of this kid: one line per website, newest first.
      pool.query<{ host: string; at: Date; devices: string[] }>(
        `SELECT b.host, max(b.at) AS at, COALESCE(array_agg(DISTINCT d.name) FILTER (WHERE d.name IS NOT NULL), '{}') AS devices
           FROM blocked_events b LEFT JOIN devices d ON d.id = b.device_id AND d.account_id = b.account_id
          WHERE b.account_id = $1 AND b.kid_id = $2 AND b.at > $3
          GROUP BY b.host ORDER BY max(b.at) DESC LIMIT 100`,
        [acc.id, kid.id, new Date(ctx.now().getTime() - 24 * 3600_000)],
      ),
    ]);
    const allowed = sites.rows.map((s) => s.identifier);
    const now = settingsNow(kid);
    const level = levelOf(kid.level);
    const today = localTime(ctx.now(), acc.timezone).day;
    const suggested = kid.birthday ? levelForBirthday(kid.birthday, today) : null;
    res.json({
      kid: { id: kid.id, name: kid.name },
      level: kid.level,
      birthday: kid.birthday,
      suggested: suggested && suggested.id !== kid.level ? suggested.id : null,
      next: kid.birthday && level ? nextLevelDate(kid.birthday, level.id) : null,
      levels: LEVELS,
      changes: level ? changesFrom(level.settings, now) : [],
      settings: now,
      blockPrivate: kid.block_private,
      web: { mode: kid.web_mode, categories: kid.web_categories, blocked: [...kid.web_blocked].sort(), allowed },
      categories: WEB_CATEGORIES.map((c) => ({ id: c.id, name: c.name, sites: c.hosts.length })),
      devices: devices.rows.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        lastSeenAt: d.last_seen_at ? d.last_seen_at.toISOString() : null,
        appVersion: d.app_version,
      })),
      blockedToday: blocked.rows
        .filter((b) => !allowed.includes(normalizeHost(b.host)))
        .slice(0, 30)
        .map((b) => ({ host: b.host, at: b.at.toISOString(), devices: b.devices, category: categoryOf(b.host)?.name ?? null })),
    });
  });

  r.post('/kids/:id/safety/level', async (req, res) => {
    const kid = await ownKid(res, req.params.id);
    const body = new Body(req.body);
    const level = levelOf(body.oneOf('level', 'The level', LEVEL_IDS));
    if (!level) throw new HttpError(400, 'That level is not known.');
    const only = body.nullableString('only', 'The setting', 40);
    if (only) {
      if (!Object.prototype.hasOwnProperty.call(level.settings, only)) throw new HttpError(400, 'That is not a setting of a level.');
      const key = only as keyof LevelSettings;
      await saveSettings(pool, kid.account_id, kid.id, { [key]: level.settings[key] } as Partial<LevelSettings>);
    } else {
      await saveSettings(pool, kid.account_id, kid.id, level.settings);
      await pool.query('UPDATE kids SET level = $3 WHERE id = $1 AND account_id = $2', [kid.id, kid.account_id, level.id]);
    }
    res.json({ ok: true });
  });

  r.put('/kids/:id/safety/birthday', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const raw = new Body(req.body).raw('birthday');
    let birthday: string | null = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      const today = localTime(ctx.now(), acc.timezone).day;
      const real = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))
        && new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) === raw;
      if (!real) throw new HttpError(400, 'The birthday must be a date like 2016-03-14.');
      if (raw > today || raw < '1990-01-01') throw new HttpError(400, 'That birthday does not look right.');
      birthday = raw;
    }
    await pool.query('UPDATE kids SET birthday = $3::date WHERE id = $1 AND account_id = $2', [kid.id, acc.id, birthday]);
    res.json({ ok: true, birthday });
  });

  r.put('/kids/:id/safety/web', async (req, res) => {
    const kid = await ownKid(res, req.params.id);
    const body = new Body(req.body);
    const mode: WebMode | undefined = body.optOneOf('mode', 'The website rule', MODES);
    let categories: string[] | undefined;
    if (body.has('categories')) {
      const list = body.array('categories', 'Blocked kinds of sites', 40);
      if (!list.every((c): c is string => typeof c === 'string' && CATEGORY_IDS.includes(c))) throw new HttpError(400, 'One of those kinds of sites is not known.');
      categories = list;
    }
    const safeSearch = body.optBool('safeSearch', 'SafeSearch');
    const youTube = body.optBool('youTube', 'YouTube Restricted Mode');
    const blockPrivate = body.optBool('blockPrivate', 'Block private browsing');
    if (mode === undefined && categories === undefined && safeSearch === undefined && youTube === undefined && blockPrivate === undefined) {
      throw new HttpError(400, 'Nothing to change.');
    }
    await saveSettings(pool, kid.account_id, kid.id, { webMode: mode, categories, safeSearch, youTube });
    if (blockPrivate !== undefined) await pool.query('UPDATE kids SET block_private = $3 WHERE id = $1 AND account_id = $2', [kid.id, kid.account_id, blockPrivate]);
    res.json({ ok: true });
  });

  r.post('/kids/:id/safety/site', async (req, res) => {
    const kid = await ownKid(res, req.params.id);
    const body = new Body(req.body);
    const host = cleanHost(body.string('host', 'The website', { max: 255 }));
    if (!host) throw new HttpError(400, 'Type a website, like khanacademy.org.');
    const allow = body.bool('allow', 'Allow');
    const remove = body.optBool('remove', 'Remove') ?? false;
    // Off both lists first, then onto the one asked for.
    await pool.query('UPDATE kids SET web_blocked = array_remove(web_blocked, $3) WHERE id = $1 AND account_id = $2', [kid.id, kid.account_id, host]);
    if (allow && !remove) {
      await pool.query(
        `INSERT INTO apps (account_id, kid_id, kind, platform, identifier, name, allowed)
         VALUES ($1, $2, 'site', 'any', $3, $3, true)
         ON CONFLICT (kid_id, kind, identifier) DO UPDATE SET allowed = true`,
        [kid.account_id, kid.id, host],
      );
    } else {
      // Off the kid's list: the row stays (with its time in the reports), switched off.
      await pool.query("UPDATE apps SET allowed = false WHERE account_id = $1 AND kid_id = $2 AND kind = 'site' AND identifier = $3", [kid.account_id, kid.id, host]);
      if (!remove) {
        const added = await pool.query(
          'UPDATE kids SET web_blocked = array_append(web_blocked, $3) WHERE id = $1 AND account_id = $2 AND cardinality(web_blocked) < $4',
          [kid.id, kid.account_id, host, MAX_BLOCKED_SITES],
        );
        if (added.rowCount !== 1) throw new HttpError(400, `At most ${MAX_BLOCKED_SITES} websites can be blocked by name. Unblock one first.`);
      }
    }
    res.json({ ok: true, host });
  });

  r.put('/kids/:id/safety/texting', async (req, res) => {
    const kid = await ownKid(res, req.params.id);
    const who: TextingWho = new Body(req.body).oneOf('who', 'Who the kid can text', WHO);
    await saveSettings(pool, kid.account_id, kid.id, { texting: who });
    res.json({ ok: true });
  });

  return r;
}
