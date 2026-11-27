/**
 * A kid's photos, videos and movies (the phone's Camera, My photos and Movie Maker).
 *
 * Everything the kid takes or makes is copied here for the parents and kept MEDIA_KEEP_DAYS days, also when the kid
 * deletes it on the phone (the copy stays, marked "Deleted on the phone"). A kid can share one with a link: anyone
 * with the link can watch that one item for MEDIA_LINK_DAYS days, and a parent can end the link at any time.
 *
 *  The phone (its token):
 *   - POST /api/android/media                    the file (raw body, X-FSW-Upload: 1, Content-Type and X-Media-* headers); a repeat answers 200
 *   - POST /api/android/media/:phoneId/deleted   the kid deleted it on the phone
 *   - POST /api/android/media/:phoneId/link      a link for the family to watch it
 *   - POST /api/android/media/:phoneId/family-screen   not a thing here: answers that there is none
 *  Anyone with the link: GET /m/<token> (a page), GET /m/<token>/file
 *  Parents (signed in): GET /api/kids/:id/media, GET /api/media/:id/file, DELETE /api/media/:id, DELETE /api/media/:id/link
 *
 * A phone only ever reaches what that same phone uploaded; a parent only what belongs to the signed-in family.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router, type Request, type Response } from 'express';
import { account, type Ctx } from '../context';
import { receiveFile, removeFile } from '../files';
import { HttpError, isUuid, notFound, RateLimiter } from '../http';
import {
  MAX_MEDIA_BYTES,
  MEDIA_KEEP_DAYS,
  MEDIA_KINDS,
  MEDIA_LINK_DAYS,
  MEDIA_TYPES,
  declaredType,
  downloadName,
  isShareToken,
  kidMediaFile,
  looksLike,
  requireUploadMarker,
  sendMedia,
  shareToken,
  shareTokenHash,
  titleFromHeader,
  type MediaKind,
} from '../media';
import type { AccountRow, DeviceRow } from '../state';

interface MediaRow {
  id: string;
  account_id: string;
  kid_id: string;
  device_id: string | null;
  phone_id: string;
  kind: MediaKind;
  title: string;
  type: string;
  size: string;
  duration_sec: number;
  at: Date;
  created_at: Date;
  deleted_on_phone_at: Date | null;
  share_token_hash: string | null;
  share_nonce: string | null;
  share_expires_at: Date | null;
}

type DeviceAuth = (req: Request) => Promise<{ device: DeviceRow; account: AccountRow }>;

const header = (req: Request, name: string): string => {
  const v = req.headers[name];
  return typeof v === 'string' ? v.trim() : '';
};

const what = (kind: MediaKind): string => (kind === 'photo' ? 'photo' : kind === 'movie' ? 'movie' : 'video');
const firstName = (name: string): string => name.trim().split(/\s+/)[0] || 'A kid';
const possessive = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface MediaRouters {
  /** POST /api/android/media, mounted before the JSON parser (the body is the file). */
  upload: (req: Request, res: Response) => Promise<void>;
  /** The JSON routes under /api/android/media. */
  phone: Router;
  /** /m/<token>: the page and the file behind a share link. No sign-in. */
  watch: Router;
  /** The parents' gallery, mounted with the other parent routes. */
  parent: Router;
}

export function mediaRoutes(ctx: Ctx, auth: DeviceAuth): MediaRouters {
  const pool = ctx.pool;
  const dataDir = ctx.config.dataDir;
  const uploadsPerDevice = new RateLimiter(300, 60 * 60 * 1000);
  const linksPerDevice = new RateLimiter(60, 60 * 60 * 1000);
  const watchPerIp = new RateLimiter(240, 60 * 1000);
  const fileOf = (m: Pick<MediaRow, 'id' | 'account_id' | 'kid_id'>): string => kidMediaFile(dataDir, m.account_id, m.kid_id, m.id);

  async function usedBytes(accountId: string, kidId: string): Promise<number> {
    const sum = await pool.query<{ bytes: string }>('SELECT COALESCE(SUM(size), 0)::text AS bytes FROM kid_media WHERE account_id = $1 AND kid_id = $2', [accountId, kidId]);
    return Number(sum.rows[0]?.bytes ?? 0);
  }

  // ---------------------------------------------------------------- the phone

  const FULL = 'There is no room left for more photos and videos. A parent can delete some in the console.';

  async function upload(req: Request, res: Response): Promise<void> {
    requireUploadMarker(req);
    const { device, account: owner } = await auth(req);
    if (!uploadsPerDevice.take(device.id)) throw new HttpError(429, 'Lots of photos and videos already. The rest are sent a little later.');
    const type = declaredType(req);
    if (!(MEDIA_TYPES as readonly string[]).includes(type)) throw new HttpError(415, 'Only JPEG or PNG photos and WebM or MP4 videos.');
    const phoneId = header(req, 'x-media-id');
    if (!phoneId || phoneId.length > 64 || !/^[\x21-\x7e]+$/.test(phoneId)) throw new HttpError(400, 'X-Media-Id is missing.');
    const kind = header(req, 'x-media-kind') as MediaKind;
    if (!MEDIA_KINDS.includes(kind)) throw new HttpError(400, 'X-Media-Kind must be photo, video or movie.');
    if ((kind === 'photo') !== type.startsWith('image/')) throw new HttpError(400, 'X-Media-Kind and Content-Type do not match.');
    const title = titleFromHeader(header(req, 'x-media-title'));
    const atMs = Number(header(req, 'x-media-at'));
    const at = Number.isFinite(atMs) && atMs > 0 && atMs < Date.now() + 24 * 3600_000 ? new Date(atMs) : new Date();
    const seconds = Number(header(req, 'x-media-duration'));
    const durationSec = kind !== 'photo' && Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.round(seconds), 24 * 3600) : 0;

    const have = await pool.query<{ id: string }>('SELECT id FROM kid_media WHERE device_id = $1 AND phone_id = $2', [device.id, phoneId]);
    if (have.rows[0]) {
      req.resume();
      res.json({ ok: true, id: have.rows[0].id });
      return;
    }
    // Room: what the kid has here already plus what this upload says it brings.
    const quota = ctx.config.kidMediaQuotaBytes;
    const used = await usedBytes(owner.id, device.kid_id);
    const declared = Number(req.headers['content-length'] ?? 0);
    if (used >= quota || (Number.isFinite(declared) && used + declared > quota)) throw new HttpError(507, FULL);

    const id = crypto.randomUUID();
    const file = kidMediaFile(dataDir, owner.id, device.kid_id, id);
    const got = await receiveFile(req, file, MAX_MEDIA_BYTES, 'That file is too big (200 MB at most).');
    if (got.size === 0) {
      removeFile(file);
      throw new HttpError(400, 'The file is empty.');
    }
    if (looksLike(type, got.head) !== true) {
      removeFile(file);
      // 415, so the phone stops trying this one file and goes on with the next.
      throw new HttpError(415, 'That file is not the photo or video it says it is.');
    }
    if (used + got.size > quota) {
      removeFile(file);
      throw new HttpError(507, FULL);
    }
    const made = await pool.query<{ id: string }>(
      `INSERT INTO kid_media (id, account_id, kid_id, device_id, phone_id, kind, title, type, size, duration_sec, at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        WHERE EXISTS (SELECT 1 FROM devices WHERE id = $4 AND account_id = $2 AND kid_id = $3)
       ON CONFLICT (device_id, phone_id) DO NOTHING RETURNING id`,
      [id, owner.id, device.kid_id, device.id, phoneId, kind, title, type, got.size, durationSec, at.toISOString()],
    );
    if (!made.rows[0]) {
      // The same upload twice at once (the other one won), or the phone was removed meanwhile.
      removeFile(file);
      const other = await pool.query<{ id: string }>('SELECT id FROM kid_media WHERE device_id = $1 AND phone_id = $2', [device.id, phoneId]);
      if (!other.rows[0]) throw new HttpError(401, 'This device was removed. Set it up again from the parent console.');
      res.json({ ok: true, id: other.rows[0].id });
      return;
    }
    res.status(201).json({ ok: true, id });
  }

  /** One of this phone's own uploads, by the id the phone gave it. */
  async function own(req: Request): Promise<{ row: MediaRow; kidName: string }> {
    const { device, account: owner } = await auth(req);
    const phoneId = String(req.params.phoneId ?? '');
    const found =
      phoneId && phoneId.length <= 64
        ? await pool.query<MediaRow & { kid_name: string }>(
            `SELECT m.*, k.name AS kid_name FROM kid_media m JOIN kids k ON k.id = m.kid_id
              WHERE m.device_id = $1 AND m.account_id = $2 AND m.phone_id = $3`,
            [device.id, owner.id, phoneId],
          )
        : null;
    const row = found?.rows[0];
    if (!row) throw new HttpError(404, 'That one is not on the server yet.');
    return { row, kidName: row.kid_name };
  }

  const phone = Router();

  phone.post('/:phoneId/deleted', async (req, res) => {
    const { row } = await own(req);
    await pool.query('UPDATE kid_media SET deleted_on_phone_at = COALESCE(deleted_on_phone_at, now()) WHERE id = $1', [row.id]);
    res.json({ ok: true });
  });

  /** A link for the family to watch it: the same link again while it lasts, and asking again gives it 30 more days. */
  phone.post('/:phoneId/link', async (req, res) => {
    const { row } = await own(req);
    if (!linksPerDevice.take(row.device_id ?? row.id)) throw new HttpError(429, 'Lots of links already. Try again a little later.');
    if (!fs.existsSync(fileOf(row))) throw new HttpError(404, 'That one is not on the server yet.');
    let token: string | null = null;
    if (row.share_nonce && row.share_token_hash && row.share_expires_at && row.share_expires_at.getTime() > Date.now()) {
      const again = shareToken(ctx.config.sessionSecret, row.id, row.share_nonce);
      if (shareTokenHash(again) === row.share_token_hash) token = again;
    }
    let nonce = row.share_nonce;
    if (!token) {
      nonce = crypto.randomBytes(18).toString('base64url');
      token = shareToken(ctx.config.sessionSecret, row.id, nonce);
    }
    await pool.query(
      'UPDATE kid_media SET share_token_hash = $2, share_nonce = $3, share_expires_at = now() + make_interval(days => $4) WHERE id = $1',
      [row.id, shareTokenHash(token), nonce, MEDIA_LINK_DAYS],
    );
    res.json({ link: `${ctx.config.publicUrl}/m/${token}` });
  });

  /** The app this API was written for can ask to show a movie on a shared family screen. There is none here. */
  phone.post('/:phoneId/family-screen', async (req, res) => {
    await auth(req);
    res.json({ status: 'unavailable', message: 'There is no shared screen to show this on. Send it to your family with a link instead.' });
  });

  // ---------------------------------------------------------------- the link (/m/<token>)

  const watch = Router();

  async function shared(req: Request): Promise<(MediaRow & { kid_name: string }) | null> {
    if (!watchPerIp.take(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many requests. Please wait a minute and try again.');
    const token = String(req.params.token ?? '');
    if (!isShareToken(token)) return null;
    const found = await pool.query<MediaRow & { kid_name: string }>(
      `SELECT m.*, k.name AS kid_name FROM kid_media m JOIN kids k ON k.id = m.kid_id
        WHERE m.share_token_hash = $1 AND m.share_expires_at > now()`,
      [shareTokenHash(token)],
    );
    const row = found.rows[0];
    return row && fs.existsSync(fileOf(row)) ? row : null;
  }

  function page(res: Response, status: number, title: string, body: string): void {
    res.status(status);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#eef1fb;background:#0c1a2e;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}
main{width:100%;max-width:720px;background:#080c22;border:1px solid #141b3f;border-radius:10px;padding:20px;box-sizing:border-box;text-align:center}
h1{font-size:24px;font-weight:400;margin:6px 0 4px;overflow-wrap:anywhere}p{color:#8e9ac0;line-height:1.5;margin:0 0 8px;font-size:14px}
video,img{display:block;width:100%;max-height:75vh;object-fit:contain;border-radius:8px;background:#000;margin:14px 0 10px}
.brand{display:flex;align-items:center;justify-content:center;gap:8px;color:#8e9ac0;font-size:13px;margin-top:12px}
</style></head><body><main>${body}
<div class="brand"><svg width="18" height="21" viewBox="0 0 120 140" aria-hidden="true"><path d="M60 8 L112 26 V68 C112 100 90 122 60 132 C30 122 8 100 8 68 V26 Z" fill="none" stroke="#34d399" stroke-width="9" stroke-linejoin="round"/><path d="M82 46 H46 V68 H74 V92 H38" fill="none" stroke="#34d399" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Family Screen Warden</span></div>
</main></body></html>`);
  }

  watch.get('/:token', async (req, res) => {
    const m = await shared(req);
    if (!m) {
      page(res, 404, 'This link is not working', `<h1>This link is not working</h1><p>It may have run out (links last ${MEDIA_LINK_DAYS} days), or it was removed.</p>`);
      return;
    }
    const first = firstName(m.kid_name);
    const heading = m.title || `${possessive(first)} ${what(m.kind)}`;
    const when = m.at.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const src = `/m/${encodeURIComponent(String(req.params.token))}/file`;
    page(
      res,
      200,
      heading,
      `<p>${esc(possessive(first))} ${what(m.kind)} · ${esc(when)}</p><h1>${esc(heading)}</h1>
${m.kind === 'photo' ? `<img src="${src}" alt="${esc(m.title || 'Photo')}">` : `<video controls playsinline preload="metadata" src="${src}"></video>`}
<p>${esc(first)} shared this with a link. It shows this one ${what(m.kind)} and nothing else.</p>`,
    );
  });

  watch.get('/:token/file', async (req, res) => {
    const m = await shared(req);
    if (!m) {
      res.status(404).setHeader('Cache-Control', 'no-store');
      res.json({ error: 'This link is not working.' });
      return;
    }
    sendMedia(req, res, fileOf(m), m.type, { cache: 'private, no-store' });
  });

  // ---------------------------------------------------------------- parents

  const parent = Router();

  async function ownMedia(res: Response, rawId: unknown): Promise<MediaRow> {
    if (!isUuid(rawId)) throw notFound('photo or video');
    const found = await pool.query<MediaRow>('SELECT * FROM kid_media WHERE id = $1 AND account_id = $2', [rawId.toLowerCase(), account(res).id]);
    const row = found.rows[0];
    if (!row) throw notFound('photo or video');
    return row;
  }

  parent.get('/kids/:id/media', async (req, res) => {
    const acc = account(res);
    if (!isUuid(req.params.id)) throw notFound('kid');
    const kid = await pool.query<{ id: string }>('SELECT id FROM kids WHERE id = $1 AND account_id = $2', [req.params.id.toLowerCase(), acc.id]);
    const kidId = kid.rows[0]?.id;
    if (!kidId) throw notFound('kid');
    const [rows, used] = await Promise.all([
      pool.query<MediaRow & { device_name: string | null }>(
        `SELECT m.*, d.name AS device_name FROM kid_media m LEFT JOIN devices d ON d.id = m.device_id AND d.account_id = m.account_id
          WHERE m.account_id = $1 AND m.kid_id = $2 ORDER BY m.at DESC, m.created_at DESC, m.id LIMIT 1000`,
        [acc.id, kidId],
      ),
      usedBytes(acc.id, kidId),
    ]);
    const now = Date.now();
    res.json({
      keepDays: MEDIA_KEEP_DAYS,
      linkDays: MEDIA_LINK_DAYS,
      usedBytes: used,
      quotaBytes: ctx.config.kidMediaQuotaBytes,
      items: rows.rows.map((m) => {
        const linked = !!m.share_token_hash && !!m.share_expires_at && m.share_expires_at.getTime() > now;
        return {
          id: m.id,
          kind: m.kind,
          title: m.title,
          at: m.at.toISOString(),
          durationSec: m.duration_sec,
          size: Number(m.size),
          type: m.type,
          url: `/api/media/${m.id}/file`,
          deviceName: m.device_name,
          deletedOnPhone: !!m.deleted_on_phone_at,
          linkShared: linked,
          linkExpiresAt: linked && m.share_expires_at ? m.share_expires_at.toISOString() : null,
        };
      }),
    });
  });

  parent.get('/media/:id/file', async (req, res) => {
    const m = await ownMedia(res, req.params.id);
    const download = req.query.download === '1' ? downloadName(m.title, what(m.kind), m.type) : undefined;
    sendMedia(req, res, fileOf(m), m.type, { cache: 'private, max-age=3600', download });
  });

  /** Ends the link the kid made: whoever has it sees "this link is not working". */
  parent.delete('/media/:id/link', async (req, res) => {
    const m = await ownMedia(res, req.params.id);
    await pool.query('UPDATE kid_media SET share_token_hash = NULL, share_nonce = NULL, share_expires_at = NULL WHERE id = $1 AND account_id = $2', [m.id, m.account_id]);
    res.json({ ok: true });
  });

  /** Gone from the server, its link too. It stays on the phone if the kid still has it there. */
  parent.delete('/media/:id', async (req, res) => {
    const m = await ownMedia(res, req.params.id);
    await pool.query('DELETE FROM kid_media WHERE id = $1 AND account_id = $2', [m.id, m.account_id]);
    removeFile(fileOf(m));
    res.json({ ok: true });
  });

  return { upload, phone, watch, parent };
}
