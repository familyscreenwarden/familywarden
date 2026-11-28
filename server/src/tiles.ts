/**
 * Map tiles for the parents' Map page. Browsers never ask the tile source themselves: the server fetches each tile
 * (with a User-Agent that says who is asking), keeps it under DATA_DIR/map-tiles and hands it to signed-in parents.
 *
 * The source is MAP_TILE_URL. A tile on disk is used for 14 days, then fetched again (the old copy is used when the
 * source cannot be reached). The folder never grows past MAP_TILE_CACHE_MB: the tiles used longest ago go first.
 * At most 4 tiles are fetched from the source at a time, and nothing is fetched ahead of time.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config';
import { tileType, tileUrl, validTile } from './location';

export const TILE_FRESH_DAYS = 14;
/** One tile is a small picture; anything bigger than this is not kept or passed on. */
export const MAX_TILE_BYTES = 1024 * 1024;
const MAX_AT_ONCE = 4;
const FETCH_TIMEOUT_MS = 10_000;

export interface Tile {
  body: Buffer;
  type: string;
}

export function tileUserAgent(config: Pick<Config, 'publicUrl'>): string {
  return `FamilyScreenWarden/1.0 (parent console map; +https://familyscreenwarden.com; ${config.publicUrl})`;
}

export class TileStore {
  private readonly dir: string;
  private readonly inflight = new Map<string, Promise<Buffer | null>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  /** Bytes on disk, as far as this process knows (null until the folder was measured). */
  private bytes: number | null = null;
  private pruning: Promise<void> | null = null;

  constructor(
    private readonly config: Pick<Config, 'dataDir' | 'mapTileUrl' | 'mapTileCacheBytes' | 'publicUrl'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.dir = path.join(config.dataDir, 'map-tiles');
  }

  get enabled(): boolean {
    return this.config.mapTileUrl !== '';
  }

  /** z, x and y are whole numbers that were checked: nothing a browser sends becomes part of the path as text. */
  file(z: number, x: number, y: number): string {
    return path.join(this.dir, String(z), String(x), String(y));
  }

  /** A tile from the disk (fresh), else from the source (kept), else an old copy, else null. */
  async get(z: number, x: number, y: number): Promise<Tile | null> {
    if (!this.enabled || !validTile(z, x, y)) return null;
    const file = this.file(z, x, y);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < TILE_FRESH_DAYS * 86400_000) return this.read(file, true);
    const key = `${z}/${x}/${y}`;
    let job = this.inflight.get(key);
    if (!job) {
      job = this.fetchAndKeep(z, x, y, file, stat?.size ?? 0).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    const body = await job;
    if (body) {
      const type = tileType(body);
      return type ? { body, type } : null;
    }
    return stat ? this.read(file, false) : null;
  }

  private async read(file: string, touch: boolean): Promise<Tile | null> {
    try {
      const body = await fs.promises.readFile(file);
      const type = tileType(body);
      if (!type) return null;
      // The time a tile was last read decides what goes first when the folder is full.
      if (touch) void fs.promises.utimes(file, new Date(), (await fs.promises.stat(file)).mtime).catch(() => undefined);
      return { body, type };
    } catch {
      return null;
    }
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_AT_ONCE) await new Promise<void>((ok) => this.waiting.push(ok));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async fetchOnce(z: number, x: number, y: number): Promise<Buffer | null> {
    return this.slot(async () => {
      try {
        const res = await this.fetchImpl(tileUrl(this.config.mapTileUrl, z, x, y), {
          headers: { 'User-Agent': tileUserAgent(this.config), Accept: 'image/png,image/jpeg,image/webp' },
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        if (Number(res.headers.get('content-length') ?? 0) > MAX_TILE_BYTES) return null;
        const body = Buffer.from(await res.arrayBuffer());
        // Only a picture is kept or passed on, whatever the source sent.
        if (body.length === 0 || body.length > MAX_TILE_BYTES || !tileType(body)) return null;
        return body;
      } catch {
        return null;
      }
    });
  }

  private async fetchAndKeep(z: number, x: number, y: number, file: string, oldSize: number): Promise<Buffer | null> {
    let body: Buffer | null = null;
    for (let i = 0; i < 2 && !body; i++) body = await this.fetchOnce(z, x, y);
    if (!body) return null;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.part`;
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, file);
      if (this.bytes !== null) this.bytes += body.length - oldSize;
      if (this.bytes === null || this.bytes > this.config.mapTileCacheBytes) void this.prune();
    } catch {
      // A full or read-only disk: the tile is still handed on, just not kept.
    }
    return body;
  }

  /** Every tile file with its size and when it was last read. */
  private async list(): Promise<Array<{ file: string; size: number; usedMs: number }>> {
    const out: Array<{ file: string; size: number; usedMs: number }> = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 2) await walk(full, depth + 1);
        } else if (e.isFile()) {
          const st = await fs.promises.stat(full).catch(() => null);
          if (st) out.push({ file: full, size: st.size, usedMs: Math.max(st.atimeMs, st.mtimeMs) });
        }
      }
    };
    await walk(this.dir, 0);
    return out;
  }

  /** How many bytes the kept tiles take. */
  async size(): Promise<number> {
    const files = await this.list();
    this.bytes = files.reduce((sum, f) => sum + f.size, 0);
    return this.bytes;
  }

  /**
   * Keeps the folder under its size limit: the tiles read longest ago are removed until it is back at 90 % of the
   * limit. Half-written files older than an hour go too. Run by housekeeping, and when a new tile tips it over.
   */
  prune(): Promise<void> {
    // A round that is already under way may have started before the newest tiles: go again after it.
    if (this.pruning) return this.pruning.then(() => this.prune());
    this.pruning = (async () => {
      try {
        const files = await this.list();
        let total = 0;
        const kept: typeof files = [];
        for (const f of files) {
          if (f.file.endsWith('.part')) {
            if (Date.now() - f.usedMs > 3600_000) await fs.promises.rm(f.file, { force: true }).catch(() => undefined);
            continue;
          }
          total += f.size;
          kept.push(f);
        }
        const limit = this.config.mapTileCacheBytes;
        if (total > limit) {
          kept.sort((a, b) => a.usedMs - b.usedMs);
          for (const f of kept) {
            if (total <= limit * 0.9) break;
            await fs.promises.rm(f.file, { force: true }).catch(() => undefined);
            total -= f.size;
          }
        }
        this.bytes = total;
      } finally {
        this.pruning = null;
      }
    })();
    return this.pruning;
  }
}
