import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import http, { type Server } from 'node:http';
import type { Pool } from 'pg';
import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { createPool, migrate } from '../src/db';
import type { IpLimits } from '../src/context';
import type { Mailer } from '../src/mail';

export const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-test-data-'));
process.on('exit', () => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5544/fsw_test';

/** Wednesday 11 March 2026, 15:00 in Denver: a school day, well outside bedtime. */
export const WEDNESDAY_AFTERNOON = new Date('2026-03-11T21:00:00Z');
export const TODAY = '2026-03-11';

export interface Json {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface Reply {
  status: number;
  body: Json;
  headers: Headers;
  text: string;
}

export interface TestServer {
  url: string;
  pool: Pool;
  config: Config;
  /** Change the clock the rules use. */
  setNow(date: Date): void;
  /** Sign-in links the fake mailer was asked to send. */
  sent: Array<{ email: string; link: string }>;
  /** Notices (check-ins, arrive / leave) the fake mailer was asked to send. */
  notices: Array<{ email: string; subject: string; text: string }>;
  close(): Promise<void>;
}

/** Empties the test database completely, so every run starts from nothing and migrations run for real. */
export async function resetDatabase(): Promise<void> {
  if (!/fsw_test|_test/.test(TEST_DATABASE_URL)) throw new Error('Refusing to wipe a database whose name does not contain "_test".');
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
  } finally {
    await pool.end();
  }
}

export async function startServer(
  env: Record<string, string> = {},
  options: { fetchImpl?: typeof fetch; ipLimits?: Partial<IpLimits> } = {},
): Promise<TestServer> {
  // BILLING_ENABLED is on here because the existing tests describe the paywall; the server's own default is off
  // (test/android.test.ts covers that). DATA_DIR is a throwaway folder.
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL, PORT: '0', PUBLIC_URL: 'http://console.test', DEV_LINKS: '1', WEB_DIST: '/nonexistent/fsw-web-dist',
    BILLING_ENABLED: '1', DATA_DIR: TEST_DATA_DIR, MAP_TILE_URL: 'off', ...env,
  });
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  let now = WEDNESDAY_AFTERNOON;
  const sent: Array<{ email: string; link: string }> = [];
  const notices: Array<{ email: string; subject: string; text: string }> = [];
  const mailer: Mailer = {
    async sendSignInLink(email, link) {
      sent.push({ email, link });
    },
    async sendNotice(email, subject, text) {
      notices.push({ email, subject, text });
    },
  };
  const app = createApp({ pool, config, mailer, now: () => now, fetchImpl: options.fetchImpl,
    // Every test comes from 127.0.0.1, so the per-address limits are lifted unless a test sets them.
    ipLimits: options.ipLimits ?? { links: 100000, verify: 100000, pair: 100000, api: 1000000 },
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    pool,
    config,
    sent,
    notices,
    setNow(date) {
      now = date;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

/** A tiny HTTP client that keeps cookies (a parent's browser) or a bearer token (a kid's device). */
export class Client {
  cookie = '';
  bearer = '';
  constructor(readonly base: string) {}

  async send(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers['cookie'] = this.cookie;
    if (this.bearer) headers['authorization'] = `Bearer ${this.bearer}`;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      headers['content-type'] ??= 'application/json';
    }
    const res = await fetch(this.base + path, { method, headers, body: payload, redirect: 'manual' });
    const setCookie = res.headers.getSetCookie();
    for (const c of setCookie) {
      const first = c.split(';')[0] ?? '';
      if (first.startsWith('fsw_session=')) this.cookie = first === 'fsw_session=' ? '' : first;
    }
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = {};
    }
    return { status: res.status, body: json, headers: res.headers, text };
  }

  get(path: string): Promise<Reply> {
    return this.send('GET', path);
  }
  post(path: string, body: unknown = {}): Promise<Reply> {
    return this.send('POST', path, body);
  }
  patch(path: string, body: unknown): Promise<Reply> {
    return this.send('PATCH', path, body);
  }
  del(path: string): Promise<Reply> {
    return this.send('DELETE', path);
  }
}

/** Walks the real sign-in flow: ask for a link, open it, keep the cookie. */
export async function signIn(server: TestServer, email: string): Promise<Client> {
  const client = new Client(server.url);
  const asked = await client.post('/api/auth/request-link', { email });
  if (asked.status !== 200 || typeof asked.body.devLink !== 'string') {
    throw new Error(`request-link failed: ${asked.status} ${asked.text}`);
  }
  const link = new URL(asked.body.devLink as string);
  const verified = await client.get(link.pathname + link.search);
  if (verified.status !== 302 || verified.headers.get('location') !== '/' || !client.cookie) {
    throw new Error(`verify failed: ${verified.status} ${verified.headers.get('location')}`);
  }
  return client;
}

export async function createKid(parent: Client, name: string): Promise<string> {
  const res = await parent.post('/api/kids', { name });
  if (res.status !== 201) throw new Error(`create kid failed: ${res.status} ${res.text}`);
  return res.body.kid.id as string;
}

/** Pairs a new device for a kid through the real pairing-code flow. */
export async function pairDevice(
  server: TestServer,
  parent: Client,
  kidId: string,
  platform: 'windows' | 'android',
  name: string,
): Promise<{ device: Client; deviceId: string }> {
  const code = await parent.post('/api/devices/pairing-code', { kidId, platform });
  if (code.status !== 201) throw new Error(`pairing code failed: ${code.status} ${code.text}`);
  const device = new Client(server.url);
  const paired = await device.post('/api/device/pair', { code: code.body.code, name, platform, model: 'Test model', osVersion: '1', appVersion: '1.0.0' });
  if (paired.status !== 201) throw new Error(`pair failed: ${paired.status} ${paired.text}`);
  device.bearer = paired.body.deviceToken as string;
  return { device, deviceId: paired.body.deviceId as string };
}

/** A small PNG-looking picture: the PNG signature, then the tile's own name so tests can tell tiles apart. */
export function fakeTile(name: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(name)]);
}

export interface TileSource {
  /** What to put in MAP_TILE_URL. */
  template: string;
  /** Every request the stand-in got: the path and the User-Agent. */
  hits: Array<{ path: string; userAgent: string }>;
  /** What the stand-in answers: tiles, an error, or something that is not a picture. */
  mode: 'ok' | 'down' | 'html';
  close(): Promise<void>;
}

/** A stand-in for a map tile provider, on this machine (real tile servers cannot be reached from the tests). */
export async function startTileSource(): Promise<TileSource> {
  const source: TileSource = { template: '', hits: [], mode: 'ok', close: async () => undefined };
  const server = http.createServer((req, res) => {
    source.hits.push({ path: req.url ?? '', userAgent: String(req.headers['user-agent'] ?? '') });
    if (source.mode === 'down') {
      res.writeHead(503).end('busy');
    } else if (source.mode === 'html') {
      res.writeHead(200, { 'content-type': 'image/png' }).end('<html><script>alert(1)</script></html>');
    } else {
      res.writeHead(200, { 'content-type': 'image/png' }).end(fakeTile(req.url ?? ''));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  source.template = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/{z}/{x}/{y}.png?key=test`;
  source.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return source;
}
