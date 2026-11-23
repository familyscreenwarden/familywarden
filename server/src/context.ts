import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import type { Config } from './config';
import { hashSessionToken } from './crypto';
import { HttpError } from './http';
import type { Mailer } from './mail';
import type { AccountRow } from './state';
import type { StripeClient } from './stripe';

export interface Ctx {
  pool: Pool;
  config: Config;
  mailer: Mailer;
  stripe: StripeClient;
  /** The clock used for "today" and rule evaluation. Tests replace it. */
  now: () => Date;
  /** Per-address limits (hits per window) for the routes that need no sign-in. */
  ipLimits: IpLimits;
}

export interface IpLimits {
  /** Sign-in links per hour. */
  links: number;
  /** Sign-in link openings per 15 minutes. */
  verify: number;
  /** Device pairing tries per 15 minutes. */
  pair: number;
  /** Any API call per minute. */
  api: number;
}

export const DEFAULT_IP_LIMITS: IpLimits = { links: 30, verify: 60, pair: 20, api: 600 };

export const SESSION_COOKIE = 'fsw_session';
export const SESSION_DAYS = 30;

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function sessionCookie(config: Config, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.production) parts.push('Secure');
  return parts.join('; ');
}

export function account(res: Response): AccountRow {
  const a = res.locals.account as AccountRow | undefined;
  if (!a) throw new HttpError(401, 'Please sign in.');
  return a;
}

/** Loads the signed-in account from the session cookie, or answers 401. */
export function requireAccount(ctx: Ctx) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token || token.length > 200) throw new HttpError(401, 'Please sign in.');
    const hash = hashSessionToken(token, ctx.config.sessionSecret);
    const found = await ctx.pool.query<AccountRow & { session_last_seen: Date }>(
      `SELECT a.*, s.last_seen_at AS session_last_seen
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hash],
    );
    const row = found.rows[0];
    if (!row) throw new HttpError(401, 'Please sign in.');
    if (Date.now() - row.session_last_seen.getTime() > 5 * 60 * 1000) {
      await ctx.pool.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [hash]);
    }
    // The trial check also runs in the background; doing it here makes the lock exact to the second.
    if (row.plan === 'trial' && row.trial_ends_at.getTime() <= Date.now()) {
      await ctx.pool.query("UPDATE accounts SET plan = 'locked' WHERE id = $1 AND plan = 'trial'", [row.id]);
      row.plan = 'locked';
    }
    res.locals.account = row;
    res.locals.sessionHash = hash;
    next();
  };
}

/** A locked account (trial over, no plan) may only read /api/me, use billing and sign out. */
export function requireUnlocked(_req: Request, res: Response, next: NextFunction): void {
  if (account(res).plan === 'locked') {
    throw new HttpError(402, 'Your free trial has ended. Choose a plan to keep using the console.', { locked: true });
  }
  next();
}
