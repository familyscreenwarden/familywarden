import path from 'node:path';
import { isTileTemplate } from './location';

export interface Config {
  databaseUrl: string;
  port: number;
  publicUrl: string;
  sessionSecret: string;
  devLinks: boolean;
  production: boolean;
  trustProxy: number;
  ses: { region: string; accessKeyId: string; secretAccessKey: string; from: string } | null;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripeApiBase: string;
  webDist: string;
  /** The paywall. Off: no trial lock, no 402s, billing reported as off. */
  billingEnabled: boolean;
  /** Secret GitHub Actions sends to publish a new kids' app (empty = publishing is off). */
  publishToken: string;
  /** Folder for files: published app versions, uploaded APKs, photos from texts, kids' photos and videos. */
  dataDir: string;
  /** How much room one kid's photos and videos may take, in bytes. */
  kidMediaQuotaBytes: number;
  /**
   * Where map tiles come from: an address with {z}, {x} and {y} (empty = no tiles; the map still shows the kids).
   * The server fetches them itself, keeps them under DATA_DIR/map-tiles and hands them to signed-in parents.
   */
  mapTileUrl: string;
  /** True when MAP_TILE_URL was not set and the default (the public OpenStreetMap tile servers) is in use. */
  mapTileDefault: boolean;
  /** The credit the tile source asks for, shown on the map, and where it links to. */
  mapTileAttribution: string;
  mapTileAttributionUrl: string;
  /** How much room the kept tiles may take, in bytes. */
  mapTileCacheBytes: number;
}

export const DEFAULT_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function flag(env: NodeJS.ProcessEnv, key: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(str(env, key).toLowerCase());
}

function str(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? '').trim();
}

/** Reads the configuration from the environment. Throws a readable error when something required is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = str(env, 'NODE_ENV') === 'production';
  const port = Number(str(env, 'PORT') || '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a number between 0 and 65535.');
  const databaseUrl = str(env, 'DATABASE_URL');
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. Example: postgres://postgres@127.0.0.1:5432/fsw');
  const sessionSecret = str(env, 'SESSION_SECRET');
  if (production && sessionSecret.length < 16) {
    throw new Error('SESSION_SECRET must be set to a long random string (16+ characters) when NODE_ENV=production.');
  }
  const devLinks = str(env, 'DEV_LINKS') === '1';
  const region = str(env, 'AWS_SES_REGION');
  const accessKeyId = str(env, 'AWS_SES_ACCESS_KEY_ID');
  const secretAccessKey = str(env, 'AWS_SES_SECRET_ACCESS_KEY');
  const from = str(env, 'MAIL_FROM_EMAIL');
  const ses = region && accessKeyId && secretAccessKey && from ? { region, accessKeyId, secretAccessKey, from } : null;
  const trustProxy = Number(str(env, 'TRUST_PROXY') || '0');
  const quotaMb = Number(str(env, 'KID_MEDIA_QUOTA_MB') || '5120');
  if (!Number.isFinite(quotaMb) || quotaMb < 1 || quotaMb > 1024 * 1024) throw new Error('KID_MEDIA_QUOTA_MB must be a number of megabytes, 1 or more.');
  const tileSetting = str(env, 'MAP_TILE_URL');
  const tilesOff = ['off', 'none', 'no', '0', 'false'].includes(tileSetting.toLowerCase());
  const mapTileUrl = tilesOff ? '' : tileSetting || DEFAULT_MAP_TILE_URL;
  if (mapTileUrl && !isTileTemplate(mapTileUrl)) {
    throw new Error('MAP_TILE_URL must be an http(s) address with {z}, {x} and {y} in it, for example https://tiles.example.com/{z}/{x}/{y}.png (or "off").');
  }
  const tileMb = Number(str(env, 'MAP_TILE_CACHE_MB') || '512');
  if (!Number.isFinite(tileMb) || tileMb < 1 || tileMb > 1024 * 1024) throw new Error('MAP_TILE_CACHE_MB must be a number of megabytes, 1 or more.');
  const attributionUrl = str(env, 'MAP_TILE_ATTRIBUTION_URL');
  if (attributionUrl && !/^https?:\/\//i.test(attributionUrl)) throw new Error('MAP_TILE_ATTRIBUTION_URL must start with http:// or https://.');
  const ownTiles = tileSetting !== '' && !tilesOff;
  return {
    databaseUrl,
    port,
    publicUrl: (str(env, 'PUBLIC_URL') || `http://localhost:${port}`).replace(/\/+$/, ''),
    sessionSecret,
    devLinks,
    production,
    trustProxy: Number.isInteger(trustProxy) && trustProxy > 0 ? trustProxy : 0,
    ses,
    stripeSecretKey: str(env, 'STRIPE_SECRET_KEY'),
    stripeWebhookSecret: str(env, 'STRIPE_WEBHOOK_SECRET'),
    stripeApiBase: (str(env, 'STRIPE_API_BASE') || 'https://api.stripe.com').replace(/\/+$/, ''),
    webDist: str(env, 'WEB_DIST') || path.resolve(__dirname, '..', '..', 'web', 'dist'),
    billingEnabled: flag(env, 'BILLING_ENABLED'),
    publishToken: str(env, 'PUBLISH_TOKEN'),
    dataDir: path.resolve(str(env, 'DATA_DIR') || path.resolve(__dirname, '..', 'data')),
    kidMediaQuotaBytes: Math.floor(quotaMb * 1024 * 1024),
    mapTileUrl,
    mapTileDefault: !ownTiles && !tilesOff,
    // The default credit is OpenStreetMap's. With another source, set the credit that source asks for.
    mapTileAttribution: (str(env, 'MAP_TILE_ATTRIBUTION') || (ownTiles ? '' : '© OpenStreetMap contributors')).slice(0, 200),
    mapTileAttributionUrl: attributionUrl || (ownTiles ? '' : 'https://www.openstreetmap.org/copyright'),
    mapTileCacheBytes: Math.floor(tileMb * 1024 * 1024),
  };
}
