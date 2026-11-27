/**
 * Files that come from a kid's phone: photos, videos and movies from the phone's Camera and Movie Maker, and the
 * pictures in texts. The pure parts live here (what a file is, where it goes, how a part of it is sent); the routes
 * are in routes/media.ts and routes/compat.ts.
 *
 * Nothing a phone sends decides a path: folders and file names are the ids of rows (UUIDs).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { hmacSha256, sha256Hex } from './crypto';
import { HttpError, isUuid } from './http';

/** Copies of photos and videos are kept this long, also after the kid deleted them on the phone. */
export const MEDIA_KEEP_DAYS = 90;
/** A link the kid made lasts this long; asking again adds the same time again. */
export const MEDIA_LINK_DAYS = 30;
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'video/webm', 'video/mp4'] as const;
export type MediaKind = 'photo' | 'video' | 'movie';
export const MEDIA_KINDS: readonly MediaKind[] = ['photo', 'video', 'movie'];

/** One picture or clip in a text. */
export const MAX_TEXT_MEDIA_BYTES = 8 * 1024 * 1024;
/** All the pictures in one kid's texts together. */
export const TEXT_MEDIA_QUOTA_BYTES = 1024 * 1024 * 1024;
/** What a picture text can carry. Anything else (pages, scripts, drawings that can hold scripts) is refused. */
export const TEXT_MEDIA_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/heic', 'image/heif',
  'video/mp4', 'video/3gpp', 'video/3gpp2', 'video/webm', 'video/quicktime',
  'audio/amr', 'audio/amr-wb', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/3gpp', 'audio/wav', 'audio/x-wav',
] as const;
/** Types a browser may show in the page. The rest are only offered as a download. */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']);

const starts = (head: Buffer, bytes: number[], at = 0): boolean => head.length >= at + bytes.length && bytes.every((b, i) => head[at + i] === b);
const ascii = (head: Buffer, from: number, to: number): string => head.subarray(from, to).toString('latin1');

/**
 * Whether the first bytes of a file are what its type says. `null`: a type we cannot tell by its first bytes
 * (some sound formats); such a file is stored, and never shown in a page.
 */
export function looksLike(type: string, head: Buffer): boolean | null {
  switch (type) {
    case 'image/jpeg':
      return starts(head, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return starts(head, [0x89, 0x50, 0x4e, 0x47]);
    case 'image/gif':
      return ascii(head, 0, 4) === 'GIF8';
    case 'image/webp':
      return ascii(head, 0, 4) === 'RIFF' && (head.length < 12 || ascii(head, 8, 12) === 'WEBP');
    case 'image/bmp':
      return ascii(head, 0, 2) === 'BM';
    case 'video/webm':
      return starts(head, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'image/heic':
    case 'image/heif':
    case 'video/mp4':
    case 'video/3gpp':
    case 'video/3gpp2':
    case 'video/quicktime':
    case 'audio/mp4':
    case 'audio/3gpp':
      return head.length >= 8 && ascii(head, 4, 8) === 'ftyp';
    case 'audio/amr':
    case 'audio/amr-wb':
      return ascii(head, 0, 5) === '#!AMR';
    case 'audio/ogg':
      return ascii(head, 0, 4) === 'OggS';
    case 'audio/wav':
    case 'audio/x-wav':
      return ascii(head, 0, 4) === 'RIFF';
    default:
      return null;
  }
}

/**
 * A raw upload must say it is one (`X-FSW-Upload: 1`, the same marker the console sends with an APK). A web page on
 * another site cannot add this header to a request without the browser asking the server first, so a file can only
 * arrive from the app or the console.
 */
export function requireUploadMarker(req: Request): void {
  if (req.headers['x-fsw-upload'] !== '1') throw new HttpError(400, 'This upload is missing its X-FSW-Upload header.');
}

/** The type a request says its body has: lower case, without parameters. */
export function declaredType(req: Request): string {
  return String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase().slice(0, 80) ?? '';
}

/** A title sent base64-encoded (UTF-8) in a header: one line of plain text, at most 120 characters. */
export function titleFromHeader(raw: string): string {
  if (!raw || raw.length > 2000 || !/^[A-Za-z0-9+/_=-]*$/.test(raw)) return '';
  // eslint-disable-next-line no-control-regex
  const text = Buffer.from(raw, 'base64').toString('utf8').replace(/[\u0000-\u001f\u007f�]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, 120).join('');
}

// ---------------------------------------------------------------- where files live

/** DATA_DIR/kid-media/<account>/<kid>: one folder per kid, so a kid's or a family's files can go in one sweep. */
export function kidMediaDir(dataDir: string, accountId: string, kidId: string): string {
  if (!isUuid(accountId) || !isUuid(kidId)) throw new Error('Media folders are named by ids.');
  return path.join(dataDir, 'kid-media', accountId.toLowerCase(), kidId.toLowerCase());
}

export function kidMediaFile(dataDir: string, accountId: string, kidId: string, mediaId: string): string {
  if (!isUuid(mediaId)) throw new Error('Media files are named by ids.');
  return path.join(kidMediaDir(dataDir, accountId, kidId), mediaId.toLowerCase());
}

export function removeKidMediaDir(dataDir: string, accountId: string, kidId: string): void {
  try {
    fs.rmSync(kidMediaDir(dataDir, accountId, kidId), { recursive: true, force: true });
  } catch (err) {
    console.error('Could not remove a media folder:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------- links

/**
 * The token of a share link. Only its hash and a random nonce are stored: the token is worked out again from the
 * nonce and the server's secret when the same link is asked for a second time, and nobody who reads the database
 * can open a link with what is in it.
 */
export function shareToken(secret: string, mediaId: string, nonce: string): string {
  return hmacSha256(secret || 'family-screen-warden-dev', `media-link:${mediaId}:${nonce}`).toString('base64url');
}

export const shareTokenHash = (token: string): string => sha256Hex(`media-link:${token}`);

export function isShareToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

// ---------------------------------------------------------------- sending

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/** An HTTP Range header for a file of `size` bytes. null = send the whole file (no header, or one we do not read). */
export function parseRange(header: string | undefined, size: number): ByteRange {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (m[1]) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || start >= size || start > end) return 'unsatisfiable';
    return { start, end };
  }
  const last = Number(m[2]);
  if (!Number.isSafeInteger(last) || last <= 0 || size === 0) return 'unsatisfiable';
  return { start: Math.max(0, size - last), end: size - 1 };
}

/** A file name for a download: letters, digits, spaces, dots and dashes of the title, then the type's ending. */
export function downloadName(title: string, fallback: string, type: string): string {
  const ext: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'video/webm': 'webm', 'video/mp4': 'mp4', 'image/gif': 'gif', 'image/webp': 'webp' };
  const base = (title || fallback).replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;
  return `${base}.${ext[type] ?? 'bin'}`;
}

/**
 * Sends a file that came from a phone. It is data for a picture or video element, never a page: no sniffing, a
 * policy that lets nothing run, and a type from our own short list (anything else goes out as a download).
 * Range requests work, so a video can be played from the middle.
 */
export function sendMedia(req: Request, res: Response, file: string, type: string, opts: { cache: string; download?: string } = { cache: 'private, no-store' }): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    throw new HttpError(404, 'That file is gone.');
  }
  const inline = INLINE_TYPES.has(type);
  res.setHeader('Content-Type', inline ? type : 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', opts.cache);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Robots-Tag', 'noindex');
  if (opts.download || !inline) res.setHeader('Content-Disposition', `attachment; filename="${opts.download ?? 'file.bin'}"`);
  else res.setHeader('Content-Disposition', 'inline');
  let start = 0;
  let end = size - 1;
  const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }
  if (range) {
    ({ start, end } = range);
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------- housekeeping on disk

const STALE_MS = 60 * 60 * 1000;

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function oldEnough(file: string, now: number): boolean {
  try {
    return now - fs.statSync(file).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Removes files nobody owns any more: folders of families and kids that are gone (however they were removed), files
 * without a row, and uploads that stopped half way. Files younger than an hour are left alone (an upload writes
 * the file before its row). Returns how many files and folders went.
 */
export async function sweepMediaFiles(
  dataDir: string,
  known: { kids(accountIds: string[]): Promise<Set<string>>; media(ids: string[]): Promise<Set<string>>; textMedia(ids: string[]): Promise<Set<string>> },
  now: number = Date.now(),
): Promise<number> {
  let removed = 0;
  const drop = (target: string, recursive = false): void => {
    try {
      fs.rmSync(target, { recursive, force: true });
      removed += 1;
    } catch (err) {
      console.error('Could not remove a media file:', err instanceof Error ? err.message : err);
    }
  };
  const sweepFiles = async (dir: string, exists: (ids: string[]) => Promise<Set<string>>): Promise<void> => {
    const files = listDir(dir).filter((f) => f.isFile());
    const ids = files.map((f) => f.name).filter(isUuid);
    const have = ids.length > 0 ? await exists(ids) : new Set<string>();
    for (const f of files) {
      const full = path.join(dir, f.name);
      if (have.has(f.name) || !oldEnough(full, now)) continue;
      drop(full);
    }
  };

  const root = path.join(dataDir, 'kid-media');
  const accounts = listDir(root).filter((d) => d.isDirectory());
  const kids = await known.kids(accounts.map((d) => d.name).filter(isUuid));
  for (const a of accounts) {
    const accountDir = path.join(root, a.name);
    for (const k of listDir(accountDir).filter((d) => d.isDirectory())) {
      const kidDir = path.join(accountDir, k.name);
      if (!kids.has(`${a.name}/${k.name}`)) {
        if (oldEnough(kidDir, now)) drop(kidDir, true);
        continue;
      }
      await sweepFiles(kidDir, known.media);
    }
    if (listDir(accountDir).length === 0 && oldEnough(accountDir, now)) drop(accountDir, true);
  }
  await sweepFiles(path.join(dataDir, 'text-media'), known.textMedia);
  return removed;
}
