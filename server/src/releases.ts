/**
 * Published versions of the kids' Android app.
 *
 *   GitHub Actions --POST /internal/android/publish (Bearer PUBLISH_TOKEN, X-Version, X-Sha256, X-Notes)--> DATA_DIR
 *   Android's setup screen and phones updating --GET /api/android/download?v=--> the APK
 *
 * Android's setup checks the APK's SHA-256 from the QR code, and phones check it before updating.
 * Only the newest 3 versions keep their file (a QR code made just before a new version still works).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { isVersion, newerVersion, normalizeSignatureChecksum } from './compat/logic';
import type { Ctx } from './context';
import { looksLikeApk, receiveFile, releaseFile, removeFile, sendFile } from './files';
import { HttpError, RateLimiter } from './http';

export const MAX_RELEASE_BYTES = 200 * 1024 * 1024;
const MIN_RELEASE_BYTES = 100_000;
const KEEP_FILES = 3;

export interface Release {
  version: string;
  size: number;
  sha256: string;
  signatureChecksum: string | null;
  notes: string;
  createdAt: string;
}

interface ReleaseRow {
  version: string;
  size: number;
  sha256: string;
  signature_checksum: string | null;
  notes: string;
  has_file: boolean;
  created_at: Date;
}

function releaseJson(r: ReleaseRow): Release {
  return { version: r.version, size: r.size, sha256: r.sha256, signatureChecksum: r.signature_checksum, notes: r.notes, createdAt: r.created_at.toISOString() };
}

/** The newest published version that still has its file, or null when nothing is published. */
export async function latestRelease(pool: Pool): Promise<Release | null> {
  const rows = await pool.query<ReleaseRow>('SELECT * FROM app_releases WHERE has_file');
  let best: ReleaseRow | null = null;
  for (const r of rows.rows) if (!best || newerVersion(r.version, best.version)) best = r;
  return best ? releaseJson(best) : null;
}

function sameToken(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function header(req: Request, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
}

/** POST /internal/android/publish: the body is the APK; version, checksums and notes come in headers. */
export function publishRelease(ctx: Ctx) {
  const wrongTokens = new RateLimiter(10, 15 * 60 * 1000);
  return async (req: Request, res: Response): Promise<void> => {
    const token = ctx.config.publishToken;
    if (token.length < 32) throw new HttpError(503, 'Publishing is not set up on this server (PUBLISH_TOKEN, 32 characters or more).');
    const sent = /^Bearer\s+(\S+)$/.exec(header(req, 'authorization'))?.[1] ?? '';
    if (!sent || !sameToken(sent, token)) {
      if (!wrongTokens.take(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many tries with a wrong publish token.');
      throw new HttpError(401, 'Wrong publish token.');
    }
    const version = header(req, 'x-version');
    if (!isVersion(version)) throw new HttpError(400, 'X-Version must look like 1.2.3.');
    const known = await ctx.pool.query('SELECT 1 FROM app_releases WHERE version = $1', [version]);
    if (known.rowCount) throw new HttpError(409, `Version ${version} is already published.`);

    const dest = releaseFile(ctx.config.dataDir, version);
    const incoming = `${dest}.incoming`;
    const got = await receiveFile(req, incoming, MAX_RELEASE_BYTES, 'That file is too big (200 MB at most).');
    const want = header(req, 'x-sha256').toLowerCase();
    // The signing certificate's SHA-256 (the workflow sends URL-safe base64 without padding). Optional.
    const sigSent = header(req, 'x-signature-checksum');
    const sig = normalizeSignatureChecksum(sigSent);
    let problem: string | null = null;
    if (!looksLikeApk(got, MIN_RELEASE_BYTES)) problem = 'That is not an Android app (.apk) file.';
    else if (want && want !== got.sha256) problem = 'The upload does not match X-Sha256.';
    else if (sigSent && !sig) problem = 'X-Signature-Checksum must be the SHA-256 of the signing certificate (base64 or hex).';
    if (problem) {
      removeFile(incoming);
      throw new HttpError(400, problem);
    }
    let notes = '';
    try {
      notes = Buffer.from(header(req, 'x-notes'), 'base64').toString('utf8').slice(0, 2000);
    } catch {
      notes = '';
    }
    const inserted = await ctx.pool.query(
      `INSERT INTO app_releases (version, size, sha256, signature_checksum, notes) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (version) DO NOTHING`,
      [version, got.size, got.sha256, sig, notes],
    );
    if (inserted.rowCount !== 1) {
      removeFile(incoming);
      throw new HttpError(409, `Version ${version} is already published.`);
    }
    fs.renameSync(incoming, dest);

    // Older versions keep their row (history) but lose their file.
    const all = await ctx.pool.query<{ version: string }>('SELECT version FROM app_releases WHERE has_file');
    const sorted = all.rows.map((r) => r.version).sort((a, b) => (newerVersion(a, b) ? -1 : newerVersion(b, a) ? 1 : 0));
    for (const old of sorted.slice(KEEP_FILES)) {
      await ctx.pool.query('UPDATE app_releases SET has_file = false WHERE version = $1', [old]);
      removeFile(releaseFile(ctx.config.dataDir, old));
    }
    console.log(`Published the kids' Android app ${version} (${Math.round(got.size / 1048576)} MB).`);
    res.json({ ok: true, version, sha256: got.sha256, size: got.size, ...(sig ? { signatureChecksum: sig } : {}) });
  };
}

/** GET /internal/android/latest: what is published (nothing secret: version, size, checksum). */
export function latestReleaseRoute(ctx: Ctx) {
  return async (_req: Request, res: Response): Promise<void> => {
    res.json(await latestRelease(ctx.pool));
  };
}

/** GET /api/android/download[?v=]: public, because Android's setup screen downloads the app before anything is paired. */
export function downloadRelease(ctx: Ctx) {
  return async (req: Request, res: Response): Promise<void> => {
    const asked = typeof req.query.v === 'string' ? req.query.v : '';
    let version = asked;
    if (!version) version = (await latestRelease(ctx.pool))?.version ?? '';
    if (!isVersion(version)) throw new HttpError(404, 'The Family Screen Warden kids app is not published yet. Try again later.');
    const row = await ctx.pool.query('SELECT 1 FROM app_releases WHERE version = $1 AND has_file', [version]);
    if (!row.rowCount) throw new HttpError(404, 'That version is not available any more.');
    sendFile(res, releaseFile(ctx.config.dataDir, version), 'application/vnd.android.package-archive', `FamilyScreenWardenKids-${version}.apk`);
  };
}
