/**
 * Where the kids' phones are: a map for parents, family places with arrive / leave, check-ins from the kid and
 * "Ring phone". The logic without a database is in ../location.ts, the map tiles in ../tiles.ts.
 *
 * This is the location of children, so the rules are strict (test/location-routes.test.ts proves each one):
 *   - every parent route is scoped to the signed-in family: another family gets 404, a signed-out visitor 401;
 *   - a phone writes only for the kid it is paired to (its token says who; the body cannot name another kid);
 *   - a parent can switch sharing off per kid: the phone is told in its sync and nothing it still sends is kept;
 *   - points are deleted after the kid's keep time (1, 30 or 90 days; 30 by default), check-ins after 90 days;
 *   - a parent can clear a kid's location history; removing the kid, the phone or the family removes it too;
 *   - nothing here is public, and no coordinates leave the server except to the signed-in parents.
 *
 *  The phone (/api/android, its token):
 *   - POST /location   {lat, lng, accuracy?, at?, battery?, charging?} or {fixes:[…]}   → {sharing, live}
 *   - POST /checkin    {kind: ok | pickup | help, lat?, lng?, accuracy?}              → {ok, id?, message}
 *   - in its sync answer: location {sharing, live, ring}
 *  Parents (/api, cookie session):
 *   - GET    /location[?live=1]                 every kid with a phone: last position, today's trail, places, check-ins
 *   - GET    /kids/:id/location/trail?day=      one day's trail and arrive / leave
 *   - PUT    /kids/:id/location/settings        {sharing?, alerts?, keepDays?}
 *   - DELETE /kids/:id/location                 clears the kid's location history
 *   - POST   /kids/:id/ring                     the phone rings loudly, even on mute
 *   - GET|POST /places, PUT|DELETE /places/:id  {name, lat, lng, radius}
 *   - POST   /checkins/:id/answer               {text}
 *   - GET    /map-tiles/:z/:x/:y.png            map tiles (see ../tiles.ts)
 */
import { Router, type Request } from 'express';
import { zonedToUtc } from '../compat/logic';
import { account, type Ctx } from '../context';
import { Body, HttpError, isUuid, notFound, RateLimiter } from '../http';
import {
  CHECKIN_KINDS,
  CHECKIN_TEXT,
  DEFAULT_KEEP_DAYS,
  KEEP_DAYS,
  fixTime,
  placeChanges,
  round,
  validTile,
  type CheckInKind,
  type Fix,
  type KeepDays,
  type PlaceLike,
} from '../location';
import { localTime } from '../rules';
import type { AccountRow, Db, DeviceRow } from '../state';
import { TileStore } from '../tiles';

/** While a parent has the map open the phone reports every few seconds; the map asks again before this runs out. */
const LIVE_MS = 2 * 60_000;
/** "Please come get me" and "I need help now": the phone shares live until a parent answers, at most this long. */
const ALERT_LIVE_MS = 30 * 60_000;
/** A ring is passed to the phone for this long. */
const RING_MS = 10 * 60_000;
const MAX_PLACES = 50;
const MAX_FIXES_PER_POST = 30;
const MAX_TRAIL_POINTS = 2000;
export const TILE_MAX_ZOOM = 19;

interface Auth {
  device: DeviceRow;
  account: AccountRow;
}

interface Settings {
  sharing: boolean;
  alerts: boolean;
  keepDays: KeepDays;
  liveUntil: Date | null;
  ringId: string | null;
  ringAt: Date | null;
}

interface SettingsRow {
  kid_id: string;
  sharing: boolean;
  alerts: boolean;
  keep_days: KeepDays;
  live_until: Date | null;
  ring_id: string | null;
  ring_at: Date | null;
}

const DEFAULT_SETTINGS: Settings = { sharing: true, alerts: true, keepDays: DEFAULT_KEEP_DAYS, liveUntil: null, ringId: null, ringAt: null };

function settingsFrom(r: SettingsRow | undefined): Settings {
  return r
    ? { sharing: r.sharing, alerts: r.alerts, keepDays: r.keep_days, liveUntil: r.live_until, ringId: r.ring_id, ringAt: r.ring_at }
    : { ...DEFAULT_SETTINGS };
}

async function settingsOf(db: Db, kidId: string): Promise<Settings> {
  const found = await db.query<SettingsRow>('SELECT * FROM kid_location_settings WHERE kid_id = $1', [kidId]);
  return settingsFrom(found.rows[0]);
}

async function ensureSettings(db: Db, accountId: string, kidId: string): Promise<void> {
  await db.query('INSERT INTO kid_location_settings (kid_id, account_id) VALUES ($1, $2) ON CONFLICT (kid_id) DO NOTHING', [kidId, accountId]);
}

function isLive(s: Settings, nowMs: number): boolean {
  return s.sharing && s.liveUntil !== null && s.liveUntil.getTime() > nowMs;
}

/** In a phone's sync answer: is sharing on, is a parent watching right now, and a ring to play (its id changes with every ring). */
export async function locationExtras(db: Db, device: Pick<DeviceRow, 'kid_id' | 'platform'>): Promise<Record<string, unknown>> {
  if (device.platform !== 'android') return {};
  const s = await settingsOf(db, device.kid_id);
  const now = Date.now();
  const ringing = s.ringId !== null && s.ringAt !== null && now - s.ringAt.getTime() < RING_MS;
  return { location: { sharing: s.sharing, live: isLive(s, now), ring: ringing ? s.ringId : null } };
}

interface FixInput {
  lat: number;
  lng: number;
  accuracy: number | null;
  at: unknown;
  battery: number | null;
  charging: boolean | null;
}

function num(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

function readFix(raw: unknown): FixInput {
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const lat = num(o.lat, -90, 90);
  const lng = num(o.lng, -180, 180);
  if (lat === null || lng === null) throw new HttpError(400, 'A position needs lat (-90 to 90) and lng (-180 to 180).');
  const battery = num(o.battery, 0, 100);
  return {
    lat,
    lng,
    accuracy: num(o.accuracy, 0, 100_000),
    at: o.at,
    battery: battery === null ? null : Math.round(battery),
    charging: typeof o.charging === 'boolean' ? o.charging : null,
  };
}

interface PlaceRow extends PlaceLike {
  account_id: string;
}

export interface LocationRouters {
  /** POST /location and /checkin, mounted under /api/android (the phone's token). */
  phone: Router;
  /** The parents' side, mounted with the other parent routes (signed in, not locked). */
  parent: Router;
  tiles: TileStore;
}

export function locationRoutes(ctx: Ctx, auth: (req: Request) => Promise<Auth>): LocationRouters {
  const pool = ctx.pool;
  const phone = Router();
  const parent = Router();
  const tiles = new TileStore(ctx.config, ctx.fetchImpl);
  const postsPerDevice = new RateLimiter(120, 60_000);
  const checkinsPerDevice = new RateLimiter(10, 15 * 60_000);
  const ringsPerKid = new RateLimiter(6, 60_000);
  const tilesPerAccount = new RateLimiter(ctx.ipLimits.tiles, 60_000);

  const first = (name: string): string => name.split(' ')[0] ?? name;

  /** A notice to the parent's email address. Sent in the background; a mail problem never fails the phone's call. */
  function notify(to: AccountRow, subject: string, text: string): void {
    void ctx.mailer.sendNotice?.(to.email, subject, text).catch(() => undefined);
  }

  async function placesOf(accountId: string): Promise<PlaceRow[]> {
    const found = await pool.query<PlaceRow>(
      'SELECT id, account_id, name, lat, lng, radius_m AS radius FROM family_places WHERE account_id = $1 ORDER BY lower(name), id',
      [accountId],
    );
    return found.rows;
  }

  /** Keeps one position of the phone's own kid, and notes arriving at or leaving one of the family's places. */
  async function noteFix(a: Auth, f: FixInput, places: PlaceRow[], settings: Settings): Promise<void> {
    const { device, account: acc } = a;
    const at = fixTime(f.at, new Date());
    const fix: Fix = { lat: f.lat, lng: f.lng, accuracy: f.accuracy, at };
    const state = await pool.query<{ place_id: string }>('SELECT place_id FROM kid_place_state WHERE kid_id = $1 AND inside', [device.kid_id]);
    const changes = placeChanges(fix, places, new Set(state.rows.map((s) => s.place_id)));
    await pool.query(
      `INSERT INTO kid_locations (account_id, kid_id, device_id, lat, lng, accuracy, battery, charging, at, place_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [acc.id, device.kid_id, device.id, f.lat, f.lng, f.accuracy, f.battery, f.charging, at, changes.inside[0] ?? null],
    );
    if (changes.events.length === 0) return;
    const kid = await pool.query<{ name: string }>('SELECT name FROM kids WHERE id = $1 AND account_id = $2', [device.kid_id, acc.id]);
    const name = first(kid.rows[0]?.name ?? 'Your kid');
    for (const e of changes.events) {
      await pool.query(
        `INSERT INTO kid_place_state (kid_id, place_id, inside, since) VALUES ($1, $2, $3, $4)
         ON CONFLICT (kid_id, place_id) DO UPDATE SET inside = EXCLUDED.inside, since = EXCLUDED.since`,
        [device.kid_id, e.place.id, e.kind === 'arrive', at],
      );
      await pool.query('INSERT INTO kid_place_events (account_id, kid_id, place_id, place_name, kind, at) VALUES ($1, $2, $3, $4, $5, $6)', [
        acc.id,
        device.kid_id,
        e.place.id,
        e.place.name,
        e.kind,
        at,
      ]);
      if (settings.alerts) {
        const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: acc.timezone });
        const what = `${name} ${e.kind === 'arrive' ? 'arrived at' : 'left'} ${e.place.name}`;
        notify(acc, what, `${what} at ${time}.`);
      }
    }
  }

  // ---------------------------------------------------------------- the phone

  phone.post('/location', async (req, res) => {
    const a = await auth(req);
    if (a.device.platform !== 'android') throw new HttpError(404, 'That address does not exist.');
    if (!postsPerDevice.take(a.device.id)) throw new HttpError(429, 'Too many positions. Wait a minute.');
    const s = await settingsOf(pool, a.device.kid_id);
    // Sharing is off: the phone is told, and whatever it sent is not read and not kept.
    if (!s.sharing) {
      res.json({ sharing: false, live: false });
      return;
    }
    const body = new Body(req.body);
    const list = body.has('fixes') ? body.array('fixes', 'Positions', MAX_FIXES_PER_POST) : [req.body];
    if (list.length === 0) throw new HttpError(400, 'Send at least one position.');
    const fixes = list.map(readFix);
    const places = await placesOf(a.account.id);
    for (const f of fixes) await noteFix(a, f, places, s);
    res.json({ sharing: true, live: isLive(s, Date.now()) });
  });

  phone.post('/checkin', async (req, res) => {
    const a = await auth(req);
    const { device, account: acc } = a;
    if (device.platform !== 'android') throw new HttpError(404, 'That address does not exist.');
    const body = new Body(req.body);
    const kind: CheckInKind = body.oneOf('kind', 'The check-in', CHECKIN_KINDS);
    const recent = await pool.query("SELECT 1 FROM kid_checkins WHERE kid_id = $1 AND kind = $2 AND at > now() - interval '1 minute'", [device.kid_id, kind]);
    if (recent.rowCount) {
      res.json({ ok: true, message: 'Sent already. Your parents have it.' });
      return;
    }
    if (!checkinsPerDevice.take(device.id)) throw new HttpError(429, 'That was sent a lot. Call a parent instead.');
    const s = await settingsOf(pool, device.kid_id);
    // With sharing off the check-in still reaches the parents, but without a position.
    const lat = s.sharing ? num(body.raw('lat'), -90, 90) : null;
    const lng = s.sharing ? num(body.raw('lng'), -180, 180) : null;
    const here = lat !== null && lng !== null;
    const accuracy = here ? num(body.raw('accuracy'), 0, 100_000) : null;
    const made = await pool.query<{ id: string }>(
      'INSERT INTO kid_checkins (account_id, kid_id, device_id, kind, lat, lng, accuracy) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [acc.id, device.kid_id, device.id, kind, here ? lat : null, here ? lng : null, accuracy],
    );
    let where: string | null = null;
    if (here) {
      const places = await placesOf(acc.id);
      await noteFix(a, { lat, lng, accuracy, at: null, battery: null, charging: null }, places, s);
      const inside = await pool.query<{ name: string }>(
        `SELECT p.name FROM kid_place_state s JOIN family_places p ON p.id = s.place_id AND p.account_id = $2
          WHERE s.kid_id = $1 AND s.inside ORDER BY s.since DESC LIMIT 1`,
        [device.kid_id, acc.id],
      );
      where = inside.rows[0]?.name ?? null;
    }
    // "Come get me" and "I need help": the phone shares live until a parent answers (or 30 minutes).
    if (kind !== 'ok' && s.sharing) {
      await ensureSettings(pool, acc.id, device.kid_id);
      await pool.query(
        'UPDATE kid_location_settings SET live_until = GREATEST(COALESCE(live_until, now()), now() + make_interval(secs => $2)) WHERE kid_id = $1',
        [device.kid_id, ALERT_LIVE_MS / 1000],
      );
    }
    const kid = await pool.query<{ name: string }>('SELECT name FROM kids WHERE id = $1 AND account_id = $2', [device.kid_id, acc.id]);
    const name = first(kid.rows[0]?.name ?? 'Your kid');
    notify(
      acc,
      kind === 'help' ? `${name} needs help now` : kind === 'pickup' ? `${name} asks: please come get me` : `${name} checked in: I’m here and I’m OK`,
      `${name}: “${CHECKIN_TEXT[kind]}”${where ? ` (at ${where})` : ''}. Open the map in Family Screen Warden to see where.`,
    );
    res.json({
      ok: true,
      id: made.rows[0]?.id,
      message:
        kind === 'ok'
          ? 'Sent! Your parents can see you’re OK.'
          : s.sharing
            ? 'Sent to your parents. Your phone shares where you are until one answers.'
            : 'Sent to your parents.',
    });
  });

  // ---------------------------------------------------------------- parents

  function idParam(value: unknown, what: string): string {
    if (!isUuid(value)) throw notFound(what);
    return value.toLowerCase();
  }

  /** The kid, only when it belongs to the signed-in family (404 otherwise, as for a kid that does not exist). */
  async function ownKid(accountId: string, rawId: unknown): Promise<{ id: string; name: string }> {
    const id = idParam(rawId, 'kid');
    const found = await pool.query<{ id: string; name: string }>('SELECT id, name FROM kids WHERE id = $1 AND account_id = $2', [id, accountId]);
    const kid = found.rows[0];
    if (!kid) throw notFound('kid');
    return kid;
  }

  /** Midnight starting this day ('YYYY-MM-DD') in the family's time zone. */
  const dayStart = (day: string, timeZone: string): Date => zonedToUtc(day, '00:00', timeZone);

  function tileInfo(): Record<string, unknown> {
    return {
      enabled: tiles.enabled,
      attribution: ctx.config.mapTileAttribution,
      attributionUrl: ctx.config.mapTileAttributionUrl,
      maxZoom: TILE_MAX_ZOOM,
    };
  }

  const placeJson = (p: PlaceLike): Record<string, unknown> => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, radius: p.radius });

  parent.get('/location', async (req, res) => {
    const acc = account(res);
    const live = req.query.live === '1';
    // Kids who have a phone. Every query below is tied to the signed-in family.
    const kids = await pool.query<{ id: string; name: string; color: string }>(
      `SELECT k.id, k.name, k.color FROM kids k
        WHERE k.account_id = $1 AND EXISTS (SELECT 1 FROM devices d WHERE d.kid_id = k.id AND d.account_id = $1 AND d.platform = 'android')
        ORDER BY k.created_at, k.id`,
      [acc.id],
    );
    const ids = kids.rows.map((k) => k.id);
    if (live && ids.length > 0) {
      // The map is open: phones that share are asked to report every few seconds for the next two minutes.
      await pool.query(
        `INSERT INTO kid_location_settings (kid_id, account_id) SELECT k.id, k.account_id FROM kids k WHERE k.account_id = $1 AND k.id = ANY($2::uuid[])
         ON CONFLICT (kid_id) DO NOTHING`,
        [acc.id, ids],
      );
      await pool.query(
        `UPDATE kid_location_settings SET live_until = GREATEST(COALESCE(live_until, now()), now() + make_interval(secs => $3))
          WHERE account_id = $1 AND kid_id = ANY($2::uuid[]) AND sharing`,
        [acc.id, ids, LIVE_MS / 1000],
      );
    }
    const since = dayStart(localTime(new Date(), acc.timezone).day, acc.timezone);
    const [places, settings, lasts, trails, events, phones, checkins] = await Promise.all([
      placesOf(acc.id),
      pool.query<SettingsRow>('SELECT * FROM kid_location_settings WHERE account_id = $1', [acc.id]),
      pool.query<{ kid_id: string; lat: number; lng: number; accuracy: number | null; battery: number | null; charging: boolean | null; at: Date; place_id: string | null; phone: string | null }>(
        `SELECT DISTINCT ON (l.kid_id) l.kid_id, l.lat, l.lng, l.accuracy, l.battery, l.charging, l.at, l.place_id, d.name AS phone
           FROM kid_locations l LEFT JOIN devices d ON d.id = l.device_id AND d.account_id = l.account_id
          WHERE l.account_id = $1 AND l.kid_id = ANY($2::uuid[])
          ORDER BY l.kid_id, l.at DESC, l.id DESC`,
        [acc.id, ids],
      ),
      pool.query<{ kid_id: string; lat: number; lng: number; at: Date }>(
        `SELECT kid_id, lat, lng, at FROM (
           SELECT kid_id, lat, lng, at, row_number() OVER (PARTITION BY kid_id ORDER BY at DESC, id DESC) AS n
             FROM kid_locations
            WHERE account_id = $1 AND kid_id = ANY($2::uuid[]) AND at >= $3 AND (accuracy IS NULL OR accuracy < 250)) x
          WHERE n <= $4 ORDER BY kid_id, at`,
        [acc.id, ids, since, MAX_TRAIL_POINTS],
      ),
      pool.query<{ kid_id: string; place_name: string; kind: string; at: Date }>(
        'SELECT kid_id, place_name, kind, at FROM kid_place_events WHERE account_id = $1 AND kid_id = ANY($2::uuid[]) AND at >= $3 ORDER BY at DESC LIMIT 200',
        [acc.id, ids, since],
      ),
      pool.query<{ kid_id: string; name: string; info: { battery?: number | null; charging?: boolean | null } | null }>(
        `SELECT DISTINCT ON (kid_id) kid_id, name, info FROM devices
          WHERE account_id = $1 AND platform = 'android' ORDER BY kid_id, last_seen_at DESC NULLS LAST`,
        [acc.id],
      ),
      pool.query<{ id: string; kid_id: string; kind: string; lat: number | null; lng: number | null; at: Date; answer: string | null; answered_at: Date | null }>(
        `SELECT id, kid_id, kind, lat, lng, at, answer, answered_at FROM kid_checkins
          WHERE account_id = $1 AND at > now() - interval '12 hours' ORDER BY at DESC LIMIT 20`,
        [acc.id],
      ),
    ]);
    const now = Date.now();
    res.json({
      kids: kids.rows.map((k) => {
        const s = settingsFrom(settings.rows.find((r) => r.kid_id === k.id));
        const last = lasts.rows.find((l) => l.kid_id === k.id);
        const device = phones.rows.find((p) => p.kid_id === k.id);
        const place = last?.place_id ? (places.find((p) => p.id === last.place_id) ?? null) : null;
        return {
          id: k.id,
          name: k.name,
          color: k.color,
          sharing: s.sharing,
          alerts: s.alerts,
          keepDays: s.keepDays,
          live: isLive(s, now),
          phone: last?.phone ?? device?.name ?? null,
          last: last
            ? {
                lat: last.lat,
                lng: last.lng,
                accuracy: last.accuracy,
                at: last.at.toISOString(),
                battery: last.battery ?? device?.info?.battery ?? null,
                charging: last.charging ?? device?.info?.charging ?? null,
                place: place ? { id: place.id, name: place.name } : null,
              }
            : null,
          trail: trails.rows.filter((t) => t.kid_id === k.id).map((t) => [round(t.lat, 6), round(t.lng, 6), t.at.toISOString()]),
          events: events.rows.filter((e) => e.kid_id === k.id).slice(0, 30).map((e) => ({ placeName: e.place_name, kind: e.kind, at: e.at.toISOString() })),
          ringing: s.ringId !== null && s.ringAt !== null && now - s.ringAt.getTime() < 60_000,
        };
      }),
      places: places.map(placeJson),
      checkins: checkins.rows.map((c) => ({
        id: c.id,
        kidId: c.kid_id,
        kind: c.kind,
        lat: c.lat,
        lng: c.lng,
        at: c.at.toISOString(),
        answer: c.answer,
        answeredAt: c.answered_at ? c.answered_at.toISOString() : null,
      })),
      tiles: tileInfo(),
      keepDaysOptions: KEEP_DAYS,
    });
  });

  parent.get('/kids/:id/location/trail', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(acc.id, req.params.id);
    const asked = typeof req.query.day === 'string' ? req.query.day : '';
    if (asked && !isDay(asked)) throw new HttpError(400, 'The day must look like 2026-03-11.');
    const day = asked || localTime(new Date(), acc.timezone).day;
    const from = dayStart(day, acc.timezone);
    const to = dayStart(nextDay(day), acc.timezone);
    const [trail, events] = await Promise.all([
      pool.query<{ lat: number; lng: number; at: Date }>(
        `SELECT lat, lng, at FROM (
           SELECT lat, lng, at, id FROM kid_locations
            WHERE account_id = $1 AND kid_id = $2 AND at >= $3 AND at < $4 AND (accuracy IS NULL OR accuracy < 250)
            ORDER BY at DESC, id DESC LIMIT $5) x ORDER BY at`,
        [acc.id, kid.id, from, to, MAX_TRAIL_POINTS],
      ),
      pool.query<{ place_name: string; kind: string; at: Date }>(
        'SELECT place_name, kind, at FROM kid_place_events WHERE account_id = $1 AND kid_id = $2 AND at >= $3 AND at < $4 ORDER BY at LIMIT 200',
        [acc.id, kid.id, from, to],
      ),
    ]);
    res.json({
      day,
      trail: trail.rows.map((t) => [round(t.lat, 6), round(t.lng, 6), t.at.toISOString()]),
      events: events.rows.map((e) => ({ placeName: e.place_name, kind: e.kind, at: e.at.toISOString() })),
    });
  });

  /** A real calendar day written as YYYY-MM-DD. */
  function isDay(day: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const d = new Date(`${day}T12:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
  }

  function nextDay(day: string): string {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  parent.put('/kids/:id/location/settings', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(acc.id, req.params.id);
    const body = new Body(req.body);
    const sharing = body.optBool('sharing', 'Share location');
    const alerts = body.optBool('alerts', 'Arrive and leave emails');
    let keepDays: KeepDays | undefined;
    if (body.has('keepDays')) {
      const v = body.raw('keepDays');
      if (!(KEEP_DAYS as readonly unknown[]).includes(v)) throw new HttpError(400, `Keep the trail for ${KEEP_DAYS.join(', ')} days.`);
      keepDays = v as KeepDays;
    }
    if (sharing === undefined && alerts === undefined && keepDays === undefined) throw new HttpError(400, 'Nothing to change.');
    await ensureSettings(pool, acc.id, kid.id);
    const updated = await pool.query<SettingsRow>(
      `UPDATE kid_location_settings
          SET sharing = COALESCE($3, sharing), alerts = COALESCE($4, alerts), keep_days = COALESCE($5, keep_days),
              live_until = CASE WHEN $3 IS FALSE THEN NULL ELSE live_until END
        WHERE kid_id = $1 AND account_id = $2 RETURNING *`,
      [kid.id, acc.id, sharing ?? null, alerts ?? null, keepDays ?? null],
    );
    const s = settingsFrom(updated.rows[0]);
    // A shorter keep time counts at once, not at the next housekeeping round.
    if (keepDays !== undefined) {
      await pool.query('DELETE FROM kid_locations WHERE account_id = $1 AND kid_id = $2 AND at < now() - make_interval(days => $3)', [acc.id, kid.id, keepDays]);
      await pool.query('DELETE FROM kid_place_events WHERE account_id = $1 AND kid_id = $2 AND at < now() - make_interval(days => $3)', [acc.id, kid.id, keepDays]);
    }
    res.json({ ok: true, sharing: s.sharing, alerts: s.alerts, keepDays: s.keepDays });
  });

  /** "Clear location history": every position, arrive / leave and check-in of this kid is gone, at once. */
  parent.delete('/kids/:id/location', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(acc.id, req.params.id);
    const gone = await pool.query('DELETE FROM kid_locations WHERE account_id = $1 AND kid_id = $2', [acc.id, kid.id]);
    await pool.query('DELETE FROM kid_place_events WHERE account_id = $1 AND kid_id = $2', [acc.id, kid.id]);
    await pool.query('DELETE FROM kid_place_state WHERE kid_id = $1', [kid.id]);
    await pool.query('DELETE FROM kid_checkins WHERE account_id = $1 AND kid_id = $2', [acc.id, kid.id]);
    res.json({ ok: true, removed: gone.rowCount ?? 0 });
  });

  parent.post('/kids/:id/ring', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(acc.id, req.params.id);
    if (!ringsPerKid.take(kid.id)) throw new HttpError(429, 'That phone was just asked to ring. Give it a minute.');
    await ensureSettings(pool, acc.id, kid.id);
    await pool.query('UPDATE kid_location_settings SET ring_id = gen_random_uuid(), ring_at = now() WHERE kid_id = $1 AND account_id = $2', [kid.id, acc.id]);
    res.json({ ok: true, message: `${first(kid.name)}'s phone rings within about 20 seconds, loudly, even on mute.` });
  });

  // ---------- places

  function readPlace(raw: unknown): { name: string; lat: number; lng: number; radius: number } {
    const body = new Body(raw);
    const name = body.string('name', 'The name of the place', { max: 60 });
    const lat = num(body.raw('lat'), -90, 90);
    const lng = num(body.raw('lng'), -180, 180);
    if (lat === null || lng === null) throw new HttpError(400, 'Tap the map where the place is.');
    const radius = body.has('radius') ? body.int('radius', 'The size of the place', 50, 2000) : 150;
    return { name, lat, lng, radius };
  }

  parent.get('/places', async (_req, res) => {
    res.json({ places: (await placesOf(account(res).id)).map(placeJson) });
  });

  parent.post('/places', async (req, res) => {
    const acc = account(res);
    const p = readPlace(req.body);
    const made = await pool.query<{ id: string }>(
      `INSERT INTO family_places (account_id, name, lat, lng, radius_m)
       SELECT $1, $2, $3, $4, $5 WHERE (SELECT count(*) FROM family_places WHERE account_id = $1) < $6
       RETURNING id`,
      [acc.id, p.name, p.lat, p.lng, p.radius, MAX_PLACES],
    );
    const row = made.rows[0];
    if (!row) throw new HttpError(400, `A family can have at most ${MAX_PLACES} places.`);
    res.status(201).json({ place: { id: row.id, ...p } });
  });

  parent.put('/places/:id', async (req, res) => {
    const acc = account(res);
    const id = idParam(req.params.id, 'place');
    const p = readPlace(req.body);
    const updated = await pool.query('UPDATE family_places SET name = $3, lat = $4, lng = $5, radius_m = $6 WHERE id = $1 AND account_id = $2', [
      id,
      acc.id,
      p.name,
      p.lat,
      p.lng,
      p.radius,
    ]);
    if (updated.rowCount !== 1) throw notFound('place');
    res.json({ place: { id, ...p } });
  });

  parent.delete('/places/:id', async (req, res) => {
    const id = idParam(req.params.id, 'place');
    const deleted = await pool.query('DELETE FROM family_places WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    if (deleted.rowCount !== 1) throw notFound('place');
    res.json({ ok: true });
  });

  // ---------- check-ins

  parent.post('/checkins/:id/answer', async (req, res) => {
    const acc = account(res);
    const id = idParam(req.params.id, 'check-in');
    const text = new Body(req.body).string('text', 'The answer', { max: 200 });
    const updated = await pool.query<{ kid_id: string }>(
      'UPDATE kid_checkins SET answer = $3, answered_at = now() WHERE id = $1 AND account_id = $2 RETURNING kid_id',
      [id, acc.id, text],
    );
    const row = updated.rows[0];
    if (!row) throw notFound('check-in');
    // Answered: back to normal sharing (unless the map is open).
    await pool.query("UPDATE kid_location_settings SET live_until = LEAST(live_until, now() + interval '2 minutes') WHERE kid_id = $1 AND account_id = $2", [
      row.kid_id,
      acc.id,
    ]);
    res.json({ ok: true });
  });

  // ---------- map tiles

  /**
   * One map tile, for a signed-in parent. The tile is public map data, not family data, but the route is behind the
   * sign-in so the server is nobody's free tile proxy. Limited per family.
   */
  parent.get('/map-tiles/:z/:x/:file', async (req, res) => {
    const acc = account(res);
    const match = /^(\d{1,7})\.png$/.exec(req.params.file ?? '');
    const z = /^\d{1,2}$/.test(req.params.z ?? '') ? Number(req.params.z) : Number.NaN;
    const x = /^\d{1,7}$/.test(req.params.x ?? '') ? Number(req.params.x) : Number.NaN;
    const y = match ? Number(match[1]) : Number.NaN;
    if (!validTile(z, x, y)) throw new HttpError(404, 'That map tile does not exist.');
    if (!tiles.enabled) throw new HttpError(404, 'No map tiles are set up on this server.');
    if (!tilesPerAccount.take(acc.id)) {
      res.setHeader('Retry-After', '30');
      throw new HttpError(429, 'The map is asking for a lot of tiles. Wait a moment.');
    }
    const tile = await tiles.get(z, x, y);
    if (!tile) {
      // The source could not be reached and there is no old copy: the map asks again shortly.
      res.status(503).setHeader('Retry-After', '2');
      res.json({ error: 'That map tile is not available right now.' });
      return;
    }
    res.setHeader('Content-Type', tile.type);
    res.setHeader('Content-Length', String(tile.body.length));
    // Kept by the parent's own browser only (never by a shared cache in between).
    res.setHeader('Cache-Control', 'private, max-age=604800');
    res.end(tile.body);
  });

  return { phone, parent, tiles };
}
