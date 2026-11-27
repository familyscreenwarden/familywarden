/**
 * Parent API for what phones add: the setup QR, phone rules, launcher look, chores, family chat, texts,
 * APK pushes, emergency codes and bonus-time codes. Mounted with the other parent routes (signed in, not locked).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import {
  KIDS_ADMIN,
  KIDS_PACKAGE,
  choreShown,
  numKey,
  prettyNumber,
  provisioningPayload,
  unlockCode,
  type ChoreMark,
  type ChoreRepeat,
  type WifiDetails,
} from '../compat/logic';
import { account, type Ctx } from '../context';
import { randomPairingCode } from '../crypto';
import { withTransaction } from '../db';
import { apkFile, looksLikeApk, mediaFile, receiveFile, removeFile } from '../files';
import { Body, HttpError, isUuid, notFound } from '../http';
import { latestRelease } from '../releases';
import { localTime } from '../rules';
import type { ContactRow, DeviceRow, KidRow } from '../state';
import { CHAT_MAX_LENGTH, TEXT_KEEP_DAYS } from './compat';

const LAYOUTS = ['bright', 'gamer', 'glass'] as const;
const THEMES = ['galaxy', 'ocean', 'jungle', 'sunset'] as const;
const REPEATS = ['once', 'daily', 'weekly'] as const;
const SETUP_MINUTES = 60;
const MAX_DEVICES = 50;
const MAX_CHORES_PER_KID = 50;
const MAX_APKS = 20;
export const MAX_APK_BYTES = 200 * 1024 * 1024;
const PHONE_RE = /^\+?[0-9 ().-]{3,32}$/;

function idParam(value: unknown, what: string): string {
  if (!isUuid(value)) throw notFound(what);
  return value.toLowerCase();
}

interface ChoreRow {
  id: string;
  kid_id: string;
  name: string;
  minutes: number;
  repeat: ChoreRepeat;
  active: boolean;
  created_at: Date;
}

interface ApprovalRow {
  id: string;
  chore_id: string;
  kid_id: string;
  day: string;
  minutes: number;
  status: string;
  created_at: Date;
  decided_at: Date | null;
  chore_name: string;
  kid_name: string;
  device_name: string | null;
}

function approvalJson(r: ApprovalRow): Record<string, unknown> {
  return {
    id: r.id,
    choreId: r.chore_id,
    choreName: r.chore_name,
    kidId: r.kid_id,
    kidName: r.kid_name,
    deviceName: r.device_name,
    minutes: r.minutes,
    day: r.day,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  };
}

const APPROVAL_SELECT = `
  SELECT cc.*, ch.name AS chore_name, k.name AS kid_name, d.name AS device_name
    FROM chore_completions cc
    JOIN chores ch ON ch.id = cc.chore_id
    JOIN kids k ON k.id = cc.kid_id AND k.account_id = cc.account_id
    LEFT JOIN devices d ON d.id = cc.device_id AND d.account_id = cc.account_id`;

function phoneRulesJson(k: KidRow): Record<string, unknown> {
  return {
    blockSettings: k.phone_block_settings,
    blockReset: k.phone_block_reset,
    blockSafeBoot: k.phone_block_safe_boot,
    blockInstalls: k.phone_block_installs,
    blockAccounts: k.phone_block_accounts,
    blockUsb: k.phone_block_usb,
    emergencyNumber: k.phone_emergency_number,
    playMinutes: k.phone_play_minutes,
  };
}

function launcherJson(k: KidRow): Record<string, unknown> {
  return { layout: k.launcher_layout, theme: k.launcher_theme, lookLocked: k.launcher_look_locked };
}

/** POST /api/apks/upload?name=: the body is the APK. Mounted before the JSON parser, after the sign-in check. */
export function apkUpload(ctx: Ctx) {
  return async (req: Request, res: Response): Promise<void> => {
    const acc = account(res);
    // A header a plain web form cannot send: a second lock next to the SameSite cookie and the Origin check.
    if (req.headers['x-fsw-upload'] !== '1') throw new HttpError(400, 'That upload did not come from the console.');
    // eslint-disable-next-line no-control-regex
    const name = (typeof req.query.name === 'string' ? req.query.name : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Give the app a name.');
    let fileName: string | null = null;
    try {
      fileName = decodeURIComponent(String(req.headers['x-filename'] ?? '')).replace(/[^\w .()+-]/g, '_').trim().slice(0, 160) || null;
    } catch {
      fileName = null;
    }
    const count = await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM apks WHERE account_id = $1', [acc.id]);
    if ((count.rows[0]?.n ?? 0) >= MAX_APKS) throw new HttpError(400, `You can keep at most ${MAX_APKS} app files. Remove one first.`);
    const id = crypto.randomUUID();
    const file = apkFile(ctx.config.dataDir, id);
    const got = await receiveFile(req, file, MAX_APK_BYTES, 'That file is too big (200 MB at most).');
    if (!looksLikeApk(got, 1000)) {
      removeFile(file);
      throw new HttpError(400, 'That is not an Android app (.apk) file.');
    }
    const made = await ctx.pool.query(
      'INSERT INTO apks (id, account_id, name, file_name, size, sha256) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [id, acc.id, name, fileName, got.size, got.sha256],
    );
    res.status(201).json({ apk: apkJson(made.rows[0] as ApkRow, []) });
  };
}

interface ApkRow {
  id: string;
  name: string;
  file_name: string | null;
  package: string | null;
  size: number;
  sha256: string;
  created_at: Date;
}

function apkJson(a: ApkRow, pushes: Record<string, unknown>[]): Record<string, unknown> {
  return { id: a.id, name: a.name, fileName: a.file_name, package: a.package, size: a.size, sha256: a.sha256, createdAt: a.created_at.toISOString(), pushes };
}

export function phoneRoutes(ctx: Ctx): Router {
  const r = Router();
  const pool = ctx.pool;

  async function ownKid(res: Response, rawId: unknown): Promise<KidRow> {
    const id = idParam(rawId, 'kid');
    const found = await pool.query<KidRow>('SELECT * FROM kids WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    const kid = found.rows[0];
    if (!kid) throw notFound('kid');
    return kid;
  }

  async function ownDevice(res: Response, rawId: unknown): Promise<DeviceRow> {
    const id = idParam(rawId, 'device');
    const found = await pool.query<DeviceRow>('SELECT * FROM devices WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    const device = found.rows[0];
    if (!device) throw notFound('device');
    return device;
  }

  // ---------------------------------------------------------------- the app and the setup QR

  r.get('/android-app', async (_req, res) => {
    const latest = await latestRelease(pool);
    res.json({ latest, package: KIDS_PACKAGE, admin: KIDS_ADMIN });
  });

  /**
   * A setup code for one kid's phone (60 minutes) and two QR codes: the one Android's setup screen reads after a
   * factory reset (full lock-down), and a link any camera opens (quick install, for trying it out).
   * The Wi-Fi password only goes into the QR code; it is not kept.
   */
  r.post('/devices/android-qr', async (req, res) => {
    const acc = account(res);
    const body = new Body(req.body);
    const kid = await ownKid(res, body.raw('kidId'));
    let wifi: WifiDetails | null = null;
    const rawWifi = body.raw('wifi');
    if (rawWifi !== undefined && rawWifi !== null) {
      const w = new Body(rawWifi);
      const ssid = w.string('ssid', 'The Wi-Fi name', { max: 64 });
      const security = w.optOneOf('security', 'The Wi-Fi security', ['WPA', 'WEP', 'NONE'] as const) ?? 'WPA';
      const rawPassword = w.raw('password');
      if (rawPassword !== undefined && rawPassword !== null && (typeof rawPassword !== 'string' || rawPassword.length > 64)) {
        throw new HttpError(400, 'The Wi-Fi password is too long (at most 64 characters).');
      }
      wifi = { ssid, security, password: typeof rawPassword === 'string' && rawPassword ? rawPassword : null };
    }
    const release = await latestRelease(pool);
    if (!release) throw new HttpError(409, 'The kids app for Android is not published on this server yet, so there is nothing for the phone to download.');
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM devices WHERE account_id = $1', [acc.id]);
    if ((count.rows[0]?.n ?? 0) >= MAX_DEVICES) throw new HttpError(400, `A family can have at most ${MAX_DEVICES} devices.`);
    await pool.query('DELETE FROM pairing_codes WHERE account_id = $1 AND expires_at < now()', [acc.id]);

    let code = '';
    let expiresAt = '';
    for (let attempt = 0; attempt < 5 && !code; attempt++) {
      const candidate = randomPairingCode();
      const inserted = await pool.query<{ expires_at: Date }>(
        `INSERT INTO pairing_codes (code, account_id, kid_id, platform, expires_at)
         VALUES ($1, $2, $3, 'android', now() + make_interval(mins => $4))
         ON CONFLICT (code) DO NOTHING RETURNING expires_at`,
        [candidate, acc.id, kid.id, SETUP_MINUTES],
      );
      if (inserted.rows[0]) {
        code = candidate;
        expiresAt = inserted.rows[0].expires_at.toISOString();
      }
    }
    if (!code) throw new Error('Could not make a unique setup code');

    const server = ctx.config.publicUrl;
    const payload = JSON.stringify(provisioningPayload({ server, code, version: release.version, sha256: release.sha256, signatureChecksum: release.signatureChecksum, wifi }));
    const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    const link = `${server}/api/android/get?c=${code}`;
    const linkSvg = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    res.status(201).json({
      code,
      expiresAt,
      minutes: SETUP_MINUTES,
      kidId: kid.id,
      version: release.version,
      payload,
      svg,
      link,
      linkSvg,
      download: `${server}/api/android/download`,
    });
  });

  // ---------------------------------------------------------------- one kid's phone settings

  r.get('/kids/:id/phone', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const [contacts, phones, codes] = await Promise.all([
      pool.query<ContactRow>('SELECT * FROM contacts WHERE account_id = $1 AND kid_id = $2 ORDER BY lower(name), id', [acc.id, kid.id]),
      pool.query<DeviceRow>("SELECT * FROM devices WHERE account_id = $1 AND kid_id = $2 AND platform = 'android' ORDER BY created_at, id", [acc.id, kid.id]),
      pool.query<{ code: string; minutes: number; expires_at: Date }>(
        'SELECT code, minutes, expires_at FROM time_codes WHERE account_id = $1 AND kid_id = $2 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 20',
        [acc.id, kid.id],
      ),
    ]);
    res.json({
      rules: phoneRulesJson(kid),
      launcher: launcherJson(kid),
      contacts: contacts.rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone, canCall: c.can_call, canText: c.can_text, always: c.always })),
      phones: phones.rows.map((d) => ({
        id: d.id,
        name: d.name,
        model: d.model,
        osVersion: d.os_version,
        appVersion: d.app_version,
        lastSeenAt: d.last_seen_at ? d.last_seen_at.toISOString() : null,
        battery: d.info?.battery ?? null,
        charging: d.info?.charging ?? null,
        deviceOwner: d.info?.deviceOwner ?? null,
        usageAccess: d.info?.usageAccess ?? null,
        canUnlock: d.unlock_secret !== null,
      })),
      timeCodes: codes.rows.map((c) => ({ code: `${c.code.slice(0, 4)}-${c.code.slice(4)}`, minutes: c.minutes, expiresAt: c.expires_at.toISOString() })),
    });
  });

  r.put('/kids/:id/phone-rules', async (req, res) => {
    const kid = await ownKid(res, req.params.id);
    const body = new Body(req.body);
    const emergency = body.string('emergencyNumber', 'The emergency number', { max: 6 });
    if (!/^[0-9]{2,6}$/.test(emergency)) throw new HttpError(400, 'Use the emergency number, like 911.');
    const updated = await pool.query<KidRow>(
      `UPDATE kids SET phone_block_settings = $3, phone_block_reset = $4, phone_block_safe_boot = $5, phone_block_installs = $6,
              phone_block_accounts = $7, phone_block_usb = $8, phone_emergency_number = $9, phone_play_minutes = $10
        WHERE id = $1 AND account_id = $2 RETURNING *`,
      [
        kid.id,
        account(res).id,
        body.bool('blockSettings', 'Block settings'),
        body.bool('blockReset', 'Block factory reset'),
        body.bool('blockSafeBoot', 'Block safe mode'),
        body.bool('blockInstalls', 'Block installs'),
        body.bool('blockAccounts', 'Block accounts'),
        body.bool('blockUsb', 'Block USB'),
        emergency,
        body.int('playMinutes', 'Play Store minutes', 2, 60),
      ],
    );
    const row = updated.rows[0];
    if (!row) throw notFound('kid');
    res.json({ rules: phoneRulesJson(row) });
  });

  r.put('/kids/:id/launcher', async (req, res) => {
    const kid = await ownKid(res, req.params.id);
    const body = new Body(req.body);
    const updated = await pool.query<KidRow>(
      'UPDATE kids SET launcher_layout = $3, launcher_theme = $4, launcher_look_locked = $5 WHERE id = $1 AND account_id = $2 RETURNING *',
      [kid.id, account(res).id, body.oneOf('layout', 'The layout', LAYOUTS), body.oneOf('theme', 'The colours', THEMES), body.bool('lookLocked', 'Lock the look')],
    );
    const row = updated.rows[0];
    if (!row) throw notFound('kid');
    res.json({ launcher: launcherJson(row) });
  });

  /** A bonus-time code the kid types on the device ("Use a code"). Works once, for 24 hours. */
  r.post('/kids/:id/time-code', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const minutes = new Body(req.body).int('minutes', 'Minutes', 1, 240);
    const open = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM time_codes WHERE account_id = $1 AND kid_id = $2 AND used_at IS NULL AND expires_at > now()',
      [acc.id, kid.id],
    );
    if ((open.rows[0]?.n ?? 0) >= 20) throw new HttpError(400, `${kid.name} already has 20 unused codes.`);
    await pool.query("DELETE FROM time_codes WHERE account_id = $1 AND expires_at < now() - interval '7 days'", [acc.id]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomPairingCode();
      const made = await pool.query<{ expires_at: Date }>(
        `INSERT INTO time_codes (code, account_id, kid_id, minutes, expires_at) VALUES ($1, $2, $3, $4, now() + interval '24 hours')
         ON CONFLICT (code) DO NOTHING RETURNING expires_at`,
        [code, acc.id, kid.id, minutes],
      );
      if (made.rows[0]) {
        res.status(201).json({ code: `${code.slice(0, 4)}-${code.slice(4)}`, minutes, expiresAt: made.rows[0].expires_at.toISOString() });
        return;
      }
    }
    throw new Error('Could not make a unique time code');
  });

  // ---------------------------------------------------------------- emergency unlock codes

  /** The next emergency code for a phone: 8 digits the app checks by itself, also with no internet. Lifts the lock for 60 minutes. */
  r.post('/devices/:id/unlock-code', async (req, res) => {
    const acc = account(res);
    const device = await ownDevice(res, req.params.id);
    if (!device.unlock_secret) throw new HttpError(400, 'This device was not set up with emergency codes. They work on phones set up with the setup QR code.');
    const open = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM unlock_codes WHERE device_id = $1 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > now()',
      [device.id],
    );
    // The app only tries the next 10 codes after the last one it used.
    if ((open.rows[0]?.n ?? 0) >= 5) throw new HttpError(400, 'There are already 5 unused emergency codes for this device. Use or cancel one first.');
    const next = await pool.query<{ unlock_counter: number }>(
      'UPDATE devices SET unlock_counter = unlock_counter + 1 WHERE id = $1 AND account_id = $2 RETURNING unlock_counter',
      [device.id, acc.id],
    );
    const counter = next.rows[0]?.unlock_counter;
    if (!counter) throw notFound('device');
    const made = await pool.query<{ expires_at: Date }>(
      "INSERT INTO unlock_codes (device_id, counter, account_id, expires_at) VALUES ($1, $2, $3, now() + interval '24 hours') RETURNING expires_at",
      [device.id, counter, acc.id],
    );
    res.status(201).json({ code: unlockCode(device.unlock_secret, counter), counter, expiresAt: made.rows[0]?.expires_at.toISOString() });
  });

  r.delete('/devices/:id/unlock-codes/:counter', async (req, res) => {
    const device = await ownDevice(res, req.params.id);
    const counter = Number(req.params.counter);
    if (!Number.isInteger(counter) || counter < 1) throw notFound('code');
    const done = await pool.query(
      'UPDATE unlock_codes SET cancelled_at = now() WHERE device_id = $1 AND counter = $2 AND account_id = $3 AND used_at IS NULL AND cancelled_at IS NULL',
      [device.id, counter, account(res).id],
    );
    if (done.rowCount !== 1) throw new HttpError(409, 'That code was already used, cancelled or has run out.');
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- chores

  function choreJson(c: ChoreRow, today: string, marks: ChoreMark[]): Record<string, unknown> {
    return {
      id: c.id,
      kidId: c.kid_id,
      name: c.name,
      minutes: c.minutes,
      repeat: c.repeat,
      active: c.active,
      // What the kid's launcher shows for it today: todo, waiting, done or hidden.
      today: c.active ? choreShown(c.repeat, today, marks) : 'hidden',
      createdAt: c.created_at.toISOString(),
    };
  }

  async function marksFor(choreIds: string[]): Promise<Map<string, ChoreMark[]>> {
    const out = new Map<string, ChoreMark[]>();
    if (choreIds.length === 0) return out;
    const rows = await pool.query<{ chore_id: string; day: string; status: ChoreMark['status']; decided_day: string | null }>(
      'SELECT chore_id, day, status, decided_day FROM chore_completions WHERE chore_id = ANY($1::uuid[])',
      [choreIds],
    );
    for (const m of rows.rows) {
      const list = out.get(m.chore_id) ?? [];
      list.push({ day: m.day, status: m.status, decidedDay: m.decided_day });
      out.set(m.chore_id, list);
    }
    return out;
  }

  r.get('/kids/:id/chores', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const today = localTime(ctx.now(), acc.timezone).day;
    const chores = await pool.query<ChoreRow>('SELECT * FROM chores WHERE account_id = $1 AND kid_id = $2 ORDER BY created_at, id', [acc.id, kid.id]);
    const marks = await marksFor(chores.rows.map((c) => c.id));
    res.json({ chores: chores.rows.map((c) => choreJson(c, today, marks.get(c.id) ?? [])) });
  });

  r.post('/kids/:id/chores', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const body = new Body(req.body);
    const name = body.string('name', 'The chore', { max: 80 });
    const minutes = body.int('minutes', 'Minutes earned', 0, 240);
    const repeat = body.optOneOf('repeat', 'Repeat', REPEATS) ?? 'once';
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM chores WHERE account_id = $1 AND kid_id = $2', [acc.id, kid.id]);
    if ((count.rows[0]?.n ?? 0) >= MAX_CHORES_PER_KID) throw new HttpError(400, `A kid can have at most ${MAX_CHORES_PER_KID} chores. Remove one first.`);
    const made = await pool.query<ChoreRow>(
      'INSERT INTO chores (account_id, kid_id, name, minutes, repeat) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [acc.id, kid.id, name, minutes, repeat],
    );
    const chore = made.rows[0];
    if (!chore) throw new Error('Insert returned no row');
    res.status(201).json({ chore: choreJson(chore, localTime(ctx.now(), acc.timezone).day, []) });
  });

  r.patch('/chores/:id', async (req, res) => {
    const acc = account(res);
    const id = idParam(req.params.id, 'chore');
    const body = new Body(req.body);
    const sets: string[] = [];
    const values: unknown[] = [id, acc.id];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (body.has('name')) set('name', body.string('name', 'The chore', { max: 80 }));
    if (body.has('minutes')) set('minutes', body.int('minutes', 'Minutes earned', 0, 240));
    if (body.has('repeat')) set('repeat', body.oneOf('repeat', 'Repeat', REPEATS));
    if (body.has('active')) set('active', body.bool('active', 'Active'));
    if (sets.length === 0) throw new HttpError(400, 'Nothing to change.');
    const updated = await pool.query<ChoreRow>(`UPDATE chores SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2 RETURNING *`, values);
    const chore = updated.rows[0];
    if (!chore) throw notFound('chore');
    const marks = await marksFor([chore.id]);
    res.json({ chore: choreJson(chore, localTime(ctx.now(), acc.timezone).day, marks.get(chore.id) ?? []) });
  });

  r.delete('/chores/:id', async (req, res) => {
    const id = idParam(req.params.id, 'chore');
    const deleted = await pool.query('DELETE FROM chores WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    if (deleted.rowCount !== 1) throw notFound('chore');
    res.json({ ok: true });
  });

  /** Chores kids marked as done. `pending` (the default) is what waits for a parent. */
  r.get('/chore-approvals', async (req, res) => {
    const acc = account(res);
    const status = req.query.status === undefined ? 'pending' : req.query.status;
    if (status !== 'pending' && status !== 'all') throw new HttpError(400, 'Status must be pending or all.');
    const rows = await pool.query<ApprovalRow>(
      `${APPROVAL_SELECT}
        WHERE cc.account_id = $1 AND ($2 = 'all' OR cc.status = 'pending')
        ORDER BY cc.created_at DESC, cc.id LIMIT 200`,
      [acc.id, status],
    );
    res.json({ approvals: rows.rows.map(approvalJson) });
  });

  /** Yes adds the chore's minutes to the kid's time for today (the day of the answer). */
  r.post('/chore-approvals/:id/decide', async (req, res) => {
    const acc = account(res);
    const id = idParam(req.params.id, 'chore');
    const approve = new Body(req.body).bool('approve', 'Approve');
    const today = localTime(ctx.now(), acc.timezone).day;
    await withTransaction(pool, async (db) => {
      const found = await db.query<{ kid_id: string; minutes: number; status: string }>(
        'SELECT kid_id, minutes, status FROM chore_completions WHERE id = $1 AND account_id = $2 FOR UPDATE',
        [id, acc.id],
      );
      const row = found.rows[0];
      if (!row) throw notFound('chore');
      if (row.status !== 'pending') throw new HttpError(409, 'That chore was already answered.');
      await db.query('UPDATE chore_completions SET status = $3, decided_at = now(), decided_day = $4 WHERE id = $1 AND account_id = $2', [
        id,
        acc.id,
        approve ? 'approved' : 'declined',
        today,
      ]);
      if (approve && row.minutes > 0) {
        await db.query("INSERT INTO time_grants (kid_id, day, minutes, reason) VALUES ($1, $2, $3, 'chore')", [row.kid_id, today, row.minutes]);
      }
    });
    const row = await pool.query<ApprovalRow>(`${APPROVAL_SELECT} WHERE cc.id = $1 AND cc.account_id = $2`, [id, acc.id]);
    const approval = row.rows[0];
    if (!approval) throw notFound('chore');
    res.json({ approval: approvalJson(approval) });
  });

  // ---------------------------------------------------------------- family chat

  /** Every message of the last 30 days (at most 200), oldest first. Kids write from the launcher, parents here. */
  r.get('/chat', async (_req, res) => {
    const acc = account(res);
    const rows = await pool.query<{ id: string; kid_id: string | null; kid_name: string | null; kid_color: string | null; text: string; created_at: Date }>(
      `SELECT c.id, c.kid_id, k.name AS kid_name, k.color AS kid_color, c.text, c.created_at
         FROM family_chat c LEFT JOIN kids k ON k.id = c.kid_id
        WHERE c.account_id = $1 AND c.created_at > now() - interval '30 days'
        ORDER BY c.created_at DESC LIMIT 200`,
      [acc.id],
    );
    res.json({
      maxLength: CHAT_MAX_LENGTH,
      messages: rows.rows.reverse().map((m) => ({
        id: m.id,
        kidId: m.kid_id,
        from: m.kid_id ? (m.kid_name ?? 'A kid') : 'Parent',
        color: m.kid_color,
        text: m.text,
        at: m.created_at.toISOString(),
      })),
    });
  });

  r.post('/chat', async (req, res) => {
    const acc = account(res);
    const text = new Body(req.body).string('text', 'The message', { max: CHAT_MAX_LENGTH });
    const recent = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM family_chat WHERE account_id = $1 AND kid_id IS NULL AND created_at > now() - interval '1 minute'",
      [acc.id],
    );
    if ((recent.rows[0]?.n ?? 0) >= 20) throw new HttpError(429, 'That is a lot of messages in one minute. Wait a moment.');
    const made = await pool.query<{ id: string; created_at: Date }>(
      'INSERT INTO family_chat (account_id, kid_id, text) VALUES ($1, NULL, $2) RETURNING id, created_at',
      [acc.id, text],
    );
    const m = made.rows[0];
    if (!m) throw new Error('Insert returned no row');
    res.status(201).json({ message: { id: m.id, kidId: null, from: 'Parent', color: null, text, at: m.created_at.toISOString() } });
  });

  /** A parent can take any message away; it is gone from the kids' launchers too. */
  r.delete('/chat/:id', async (req, res) => {
    const id = idParam(req.params.id, 'message');
    const deleted = await pool.query('DELETE FROM family_chat WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    if (deleted.rowCount !== 1) throw notFound('message');
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- texts on the phone (read only)

  interface TextRow {
    id: string;
    device_id: string | null;
    phone_id: string;
    thread: string;
    participants: string[];
    dir: string;
    from_num: string | null;
    body: string;
    media: Array<{ id: string; type: string }>;
    status: string;
    at: Date;
  }

  async function namesFor(accountId: string, kidId: string): Promise<Map<string, string>> {
    const rows = await pool.query<{ name: string; phone: string }>('SELECT name, phone FROM contacts WHERE account_id = $1 AND kid_id = $2', [accountId, kidId]);
    return new Map(rows.rows.map((c) => [numKey(c.phone), c.name]));
  }

  async function textsJson(accountId: string, rows: TextRow[], names: Map<string, string>): Promise<Record<string, unknown>[]> {
    const withMedia = rows.filter((t) => t.media.length > 0 && t.device_id);
    const media = new Map<string, { id: string; type: string }>();
    if (withMedia.length > 0) {
      const got = await pool.query<{ id: string; device_id: string; phone_media_id: string; type: string }>(
        `SELECT id, device_id, phone_media_id, type FROM text_media
          WHERE account_id = $1 AND (device_id, phone_msg_id) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))`,
        [accountId, withMedia.map((t) => t.device_id), withMedia.map((t) => t.phone_id)],
      );
      for (const g of got.rows) media.set(`${g.device_id}/${g.phone_media_id}`, { id: g.id, type: g.type });
    }
    return rows.map((t) => ({
      id: t.id,
      dir: t.dir,
      from: t.from_num ? prettyNumber(t.from_num) : null,
      fromName: t.from_num ? (names.get(t.from_num) ?? null) : null,
      body: t.body,
      at: t.at.toISOString(),
      status: t.status,
      media: t.media.map((m) => {
        const got = media.get(`${t.device_id}/${m.id}`);
        return got ? { id: got.id, type: got.type, url: `/api/text-media/${got.id}` } : { id: null, type: m.type, url: null };
      }),
    }));
  }

  r.get('/kids/:id/texts', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const names = await namesFor(acc.id, kid.id);
    const [held, threads, blocked] = await Promise.all([
      pool.query<TextRow>("SELECT * FROM texts WHERE account_id = $1 AND kid_id = $2 AND status = 'held' ORDER BY at DESC LIMIT 50", [acc.id, kid.id]),
      pool.query<TextRow & { n: number }>(
        `SELECT DISTINCT ON (thread) *, (count(*) OVER (PARTITION BY thread))::int AS n
           FROM texts WHERE account_id = $1 AND kid_id = $2 AND status NOT IN ('deleted','held')
          ORDER BY thread, at DESC`,
        [acc.id, kid.id],
      ),
      pool.query<{ num: string; phone: string; created_at: Date }>(
        'SELECT num, phone, created_at FROM blocked_numbers WHERE account_id = $1 AND kid_id = $2 ORDER BY created_at DESC',
        [acc.id, kid.id],
      ),
    ]);
    threads.rows.sort((x, y) => y.at.getTime() - x.at.getTime());
    res.json({
      keepDays: TEXT_KEEP_DAYS,
      held: await textsJson(acc.id, held.rows, names),
      threads: threads.rows.map((t) => ({
        thread: t.thread,
        names: t.participants.map((p) => names.get(p) ?? prettyNumber(p)),
        at: t.at.toISOString(),
        count: t.n,
        last: {
          dir: t.dir,
          fromName: t.from_num ? (names.get(t.from_num) ?? prettyNumber(t.from_num)) : null,
          body: t.body || (t.media.length > 0 ? 'Photo' : ''),
        },
      })),
      blocked: blocked.rows.map((b) => ({ num: b.num, phone: b.phone, at: b.created_at.toISOString() })),
    });
  });

  r.get('/kids/:id/texts/thread', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const thread = typeof req.query.t === 'string' ? req.query.t : '';
    if (!thread || thread.length > 400) throw new HttpError(400, 'Say which chat.');
    const names = await namesFor(acc.id, kid.id);
    const rows = await pool.query<TextRow>(
      "SELECT * FROM texts WHERE account_id = $1 AND kid_id = $2 AND thread = $3 AND status NOT IN ('deleted','held') ORDER BY at DESC LIMIT 300",
      [acc.id, kid.id, thread],
    );
    rows.rows.reverse();
    res.json({
      thread,
      names: thread.split(',').map((p) => names.get(p) ?? prettyNumber(p)),
      texts: await textsJson(acc.id, rows.rows, names),
    });
  });

  r.get('/text-media/:id', async (req, res) => {
    const id = idParam(req.params.id, 'photo');
    const found = await pool.query<{ type: string }>('SELECT type FROM text_media WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    const file = mediaFile(ctx.config.dataDir, id);
    const row = found.rows[0];
    if (!row || !fs.existsSync(file)) throw notFound('photo');
    res.setHeader('Content-Type', row.type);
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // The file came from a phone: it is shown as a picture, never run as a page.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(file).pipe(res);
  });

  /** A held text (from a number that is not on the kid's list), gone from the console and from the phone. */
  r.post('/texts/:id/delete', async (req, res) => {
    const id = idParam(req.params.id, 'text');
    const done = await pool.query("UPDATE texts SET status = 'deleted' WHERE id = $1 AND account_id = $2 AND status = 'held'", [id, account(res).id]);
    if (done.rowCount !== 1) throw notFound('text');
    res.json({ ok: true });
  });

  /** Block a number: its texts are dropped on the phone, and the ones being held go. */
  r.post('/kids/:id/blocked-numbers', async (req, res) => {
    const acc = account(res);
    const kid = await ownKid(res, req.params.id);
    const phone = new Body(req.body).string('phone', 'The phone number', { max: 32 });
    const num = numKey(phone);
    if (!PHONE_RE.test(phone) || num.length < 3) throw new HttpError(400, 'The phone number may only have digits, spaces, and + ( ) - .');
    await pool.query(
      'INSERT INTO blocked_numbers (account_id, kid_id, num, phone) VALUES ($1, $2, $3, $4) ON CONFLICT (kid_id, num) DO NOTHING',
      [acc.id, kid.id, num, phone],
    );
    await pool.query("UPDATE texts SET status = 'deleted' WHERE account_id = $1 AND kid_id = $2 AND from_num = $3 AND status = 'held'", [acc.id, kid.id, num]);
    res.status(201).json({ ok: true, num });
  });

  r.delete('/kids/:id/blocked-numbers/:num', async (req, res) => {
    const kid = await ownKid(res, req.params.id);
    const deleted = await pool.query('DELETE FROM blocked_numbers WHERE account_id = $1 AND kid_id = $2 AND num = $3', [
      account(res).id,
      kid.id,
      numKey(String(req.params.num)),
    ]);
    if (deleted.rowCount !== 1) throw notFound('number');
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- APK files to install on phones

  r.get('/apks', async (_req, res) => {
    const acc = account(res);
    const [apks, pushes] = await Promise.all([
      pool.query<ApkRow>('SELECT * FROM apks WHERE account_id = $1 ORDER BY created_at DESC, id', [acc.id]),
      pool.query<{ id: string; apk_id: string; device_id: string; device_name: string; kid_name: string; status: string; message: string | null; updated_at: Date }>(
        `SELECT i.id, i.apk_id, i.device_id, d.name AS device_name, k.name AS kid_name, i.status, i.message, i.updated_at
           FROM apk_installs i JOIN devices d ON d.id = i.device_id JOIN kids k ON k.id = i.kid_id
          WHERE i.account_id = $1 ORDER BY i.updated_at DESC LIMIT 300`,
        [acc.id],
      ),
    ]);
    res.json({
      maxBytes: MAX_APK_BYTES,
      apks: apks.rows.map((a) =>
        apkJson(
          a,
          pushes.rows
            .filter((p) => p.apk_id === a.id)
            .map((p) => ({ id: p.id, deviceId: p.device_id, deviceName: p.device_name, kidName: p.kid_name, status: p.status, message: p.message, at: p.updated_at.toISOString() })),
        ),
      ),
    });
  });

  r.delete('/apks/:id', async (req, res) => {
    const id = idParam(req.params.id, 'app file');
    const deleted = await pool.query('DELETE FROM apks WHERE id = $1 AND account_id = $2', [id, account(res).id]);
    if (deleted.rowCount !== 1) throw notFound('app file');
    removeFile(apkFile(ctx.config.dataDir, id));
    res.json({ ok: true });
  });

  /** Install an APK on every Android phone of these kids. A phone that already has it waiting is not asked twice. */
  r.post('/apks/:id/push', async (req, res) => {
    const acc = account(res);
    const id = idParam(req.params.id, 'app file');
    const kidIds = new Body(req.body).array('kidIds', 'Kids', 20);
    if (kidIds.length === 0 || !kidIds.every((k) => isUuid(k))) throw new HttpError(400, 'Choose at least one kid.');
    const apk = await pool.query<{ name: string }>('SELECT name FROM apks WHERE id = $1 AND account_id = $2', [id, acc.id]);
    const found = apk.rows[0];
    if (!found) throw notFound('app file');
    const phones = await pool.query<{ id: string; kid_id: string }>(
      "SELECT id, kid_id FROM devices WHERE account_id = $1 AND platform = 'android' AND kid_id = ANY($2::uuid[])",
      [acc.id, kidIds],
    );
    if (phones.rows.length === 0) throw new HttpError(400, 'None of those kids has an Android phone yet.');
    let pushed = 0;
    for (const p of phones.rows) {
      const made = await pool.query(
        `INSERT INTO apk_installs (account_id, apk_id, device_id, kid_id, name)
         SELECT $1, $2, $3, $4, $5
          WHERE NOT EXISTS (SELECT 1 FROM apk_installs WHERE apk_id = $2 AND device_id = $3 AND status IN ('waiting','installing')
                               AND created_at > now() - interval '7 days')`,
        [acc.id, id, p.id, p.kid_id, found.name],
      );
      pushed += made.rowCount ?? 0;
    }
    res.status(201).json({ ok: true, phones: phones.rows.length, pushed });
  });

  return r;
}
