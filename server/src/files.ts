import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { HttpError } from './http';

/** Where files live under DATA_DIR. Ids are UUIDs and versions are checked before they get here: no user text in paths. */
export function releaseFile(dataDir: string, version: string): string {
  return path.join(dataDir, 'releases', 'android', `${version}.apk`);
}
export function apkFile(dataDir: string, apkId: string): string {
  return path.join(dataDir, 'apks', `${apkId}.apk`);
}
export function mediaFile(dataDir: string, mediaId: string): string {
  return path.join(dataDir, 'text-media', mediaId);
}

export interface Received {
  size: number;
  sha256: string;
  /** The first bytes, to tell what kind of file it is. */
  head: Buffer;
}

/**
 * Streams a request body to `dest` (through a .part file, so a half upload never looks like a whole one).
 * Answers 413 past `maxBytes`. The caller checks the content and removes the file if it is not wanted.
 */
export async function receiveFile(req: Request, dest: string, maxBytes: number, tooBig: string): Promise<Received> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new HttpError(413, tooBig);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${crypto.randomBytes(6).toString('hex')}.part`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      let failed = false;
      const fail = (err: unknown): void => {
        if (failed) return;
        failed = true;
        req.unpipe(out);
        out.destroy();
        reject(err);
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (head.length < 8) head = Buffer.concat([head, chunk]).subarray(0, 8);
        if (size > maxBytes) {
          fail(new HttpError(413, tooBig));
          req.resume();
          return;
        }
        hash.update(chunk);
      });
      req.on('error', fail);
      req.on('aborted', () => fail(new HttpError(400, 'The upload was cut off.')));
      out.on('error', fail);
      out.on('finish', () => {
        if (!failed) resolve();
      });
      req.pipe(out);
    });
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { size, sha256: hash.digest('hex'), head };
}

/** An APK is a zip file: it starts with "PK". */
export function looksLikeApk(received: Received, minBytes: number): boolean {
  return received.size >= minBytes && received.head.subarray(0, 2).toString('latin1') === 'PK';
}

export function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    console.error(`Could not remove ${file}:`, err instanceof Error ? err.message : err);
  }
}

/** Sends a file from DATA_DIR. The download is not a page: no sniffing, no caching in between. */
export function sendFile(res: Response, file: string, type: string, downloadName?: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HttpError(404, 'That file is gone.');
  }
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', 'no-store');
  if (downloadName) res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
