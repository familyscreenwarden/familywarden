import { Router } from 'express';
import { account, requireAccount, sessionCookie, SESSION_DAYS, type Ctx } from '../context';
import { hashPin, hashSessionToken, randomToken, sha256Hex } from '../crypto';
import { withTransaction } from '../db';
import { Body, HttpError, RateLimiter } from '../http';
import { isValidTimeZone } from '../rules';
import { accountJson, type AccountRow } from '../state';

const EMAIL_RE = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]{2,}$/;

export function normalizeEmail(input: unknown): string {
  if (typeof input !== 'string') throw new HttpError(400, 'Please enter your email address.');
  const email = input.trim().toLowerCase();
  if (email.length < 5 || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new HttpError(400, 'That does not look like an email address.');
  }
  return email;
}

export function authRoutes(ctx: Ctx): Router {
  const r = Router();
  const linkPerIp = new RateLimiter(ctx.ipLimits.links, 60 * 60 * 1000);
  const verifyPerIp = new RateLimiter(ctx.ipLimits.verify, 15 * 60 * 1000);

  r.post('/auth/request-link', async (req, res) => {
    const body = new Body(req.body);
    const email = normalizeEmail(body.raw('email'));
    if (!linkPerIp.take(req.ip ?? 'unknown')) {
      throw new HttpError(429, 'Too many sign-in links were asked for from this network. Please wait an hour.');
    }
    // 5 per email per hour, counted in the database so it holds across restarts and servers.
    const token = randomToken();
    const inserted = await withTransaction(ctx.pool, async (db) => {
      // One request per email at a time, so a burst cannot slip past the count.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
      return db.query(
        `INSERT INTO login_tokens (token_hash, email, expires_at)
         SELECT $1, $2, now() + interval '15 minutes'
          WHERE (SELECT count(*) FROM login_tokens WHERE email = $2 AND created_at > now() - interval '1 hour') < 5`,
        [sha256Hex(token), email],
      );
    });
    if (inserted.rowCount !== 1) {
      throw new HttpError(429, 'Too many sign-in links were asked for. Please wait an hour and try again.');
    }
    const link = `${ctx.config.publicUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;
    await ctx.mailer.sendSignInLink(email, link);
    res.json(ctx.config.devLinks ? { ok: true, devLink: link } : { ok: true });
  });

  r.get('/auth/verify', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token || token.length > 200 || !verifyPerIp.take(req.ip ?? 'unknown')) {
      res.redirect(302, '/signin?error=expired');
      return;
    }
    const used = await ctx.pool.query<{ email: string }>(
      `UPDATE login_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING email`,
      [sha256Hex(token)],
    );
    const email = used.rows[0]?.email;
    if (!email) {
      res.redirect(302, '/signin?error=expired');
      return;
    }
    // First sign-in creates the family account with a 30-day trial.
    const acc = await ctx.pool.query<{ id: string }>(
      `INSERT INTO accounts (email, trial_ends_at) VALUES ($1, now() + interval '30 days')
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [email],
    );
    const accountId = acc.rows[0]?.id;
    if (!accountId) throw new Error('Could not create the account.');
    const session = randomToken();
    await ctx.pool.query(
      `INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [hashSessionToken(session, ctx.config.sessionSecret), accountId],
    );
    res.setHeader('Set-Cookie', sessionCookie(ctx.config, session, SESSION_DAYS * 24 * 60 * 60));
    res.redirect(302, '/');
  });

  r.post('/auth/logout', requireAccount(ctx), async (_req, res) => {
    await ctx.pool.query('DELETE FROM sessions WHERE token_hash = $1 AND account_id = $2', [
      res.locals.sessionHash as string,
      account(res).id,
    ]);
    res.setHeader('Set-Cookie', sessionCookie(ctx.config, '', 0));
    res.json({ ok: true });
  });

  // What the sign-in page may know before anyone is signed in: whether there is a paywall to mention.
  r.get('/config', (_req, res) => {
    res.json({ billingEnabled: ctx.config.billingEnabled });
  });

  r.get('/me', requireAccount(ctx), (_req, res) => {
    // `billingEnabled` sits beside the account: false means there is no paywall on this server right now.
    res.json({ account: accountJson(account(res), new Date(), ctx.config.billingEnabled), billingEnabled: ctx.config.billingEnabled });
  });

  return r;
}

/** PATCH /api/account. Mounted behind the "not locked" check with the other parent routes. */
export async function patchAccount(ctx: Ctx, current: AccountRow, rawBody: unknown): Promise<Record<string, unknown>> {
  const body = new Body(rawBody);
  const sets: string[] = [];
  const values: unknown[] = [current.id];
  if (body.has('timezone')) {
    const tz = body.string('timezone', 'The time zone', { max: 64 });
    if (!isValidTimeZone(tz)) throw new HttpError(400, 'That time zone is not known. Example: America/Denver.');
    values.push(tz);
    sets.push(`timezone = $${values.length}`);
  }
  if (body.has('pin')) {
    const pin = body.raw('pin');
    if (pin === null || pin === '') {
      sets.push('parent_pin_hash = NULL', 'pin_failed_count = 0', 'pin_locked_until = NULL');
    } else {
      if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'The PIN must be 4 to 8 digits.');
      values.push(await hashPin(pin));
      sets.push(`parent_pin_hash = $${values.length}`, 'pin_failed_count = 0', 'pin_locked_until = NULL');
    }
  }
  if (sets.length === 0) throw new HttpError(400, 'Nothing to change. Send a time zone or a PIN.');
  const updated = await ctx.pool.query<AccountRow>(
    `UPDATE accounts SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values,
  );
  const row = updated.rows[0];
  if (!row) throw new HttpError(401, 'Please sign in.');
  return { account: accountJson(row, new Date(), ctx.config.billingEnabled) };
}
