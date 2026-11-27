import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { Config } from './config';
import { DEFAULT_IP_LIMITS, requireAccount, requireUnlocked, type Ctx, type IpLimits } from './context';
import { HttpError, RateLimiter } from './http';
import { createMailer, type Mailer } from './mail';
import { authRoutes } from './routes/auth';
import { billingRoutes, stripeWebhook } from './routes/billing';
import { compatRoutes } from './routes/compat';
import { deviceRoutes } from './routes/device';
import { parentRoutes } from './routes/parent';
import { apkUpload, phoneRoutes } from './routes/phone';
import { latestReleaseRoute, publishRelease } from './releases';
import { StripeClient } from './stripe';

export interface AppOptions {
  pool: Pool;
  config: Config;
  mailer?: Mailer;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  ipLimits?: Partial<IpLimits>;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp(options: AppOptions): express.Express {
  const { pool, config } = options;
  const ctx: Ctx = {
    pool,
    config,
    mailer: options.mailer ?? createMailer(config, options.fetchImpl),
    stripe: new StripeClient(config, options.fetchImpl),
    now: options.now ?? (() => new Date()),
    ipLimits: { ...DEFAULT_IP_LIMITS, ...options.ipLimits },
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  // Security headers, set by hand (the same set helmet would send).
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Content-Security-Policy', CSP);
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    if (req.path.startsWith('/api/') || req.path.startsWith('/stripe/') || req.path.startsWith('/internal/') || req.path.startsWith('/m/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: true });
    } catch {
      res.status(503).json({ status: 'error', db: false });
    }
  });

  // Stripe signs the raw bytes, so this route must come before the JSON parser.
  app.post('/stripe/webhook', express.raw({ type: () => true, limit: '1mb' }), stripeWebhook(ctx));

  // The kids' Android app, published by GitHub Actions: the body is the APK, so this also comes before the JSON parser.
  app.post('/internal/android/publish', publishRelease(ctx));
  app.get('/internal/android/latest', latestReleaseRoute(ctx));

  // A broad per-address limit against runaway clients; the tight limits live on the single routes.
  const perIp = new RateLimiter(ctx.ipLimits.api, 60 * 1000);
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    if (!perIp.take(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many requests. Please wait a minute and try again.');
    next();
  });

  // In production, a browser request that changes something must come from our own pages.
  // (The session cookie is SameSite=Lax as well; this is a second lock. Devices send no Origin header.)
  if (config.production) {
    const ownOrigin = new URL(config.publicUrl).origin;
    app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
      const origin = req.headers.origin;
      if (req.method !== 'GET' && req.method !== 'HEAD' && origin && origin !== ownOrigin) {
        throw new HttpError(403, 'This request did not come from the Family Screen Warden console.');
      }
      next();
    });
  }

  // Uploads whose body is a file (a photo from a phone's texts, a kid's photo or video, an APK from a parent):
  // before the JSON parser.
  const compat = compatRoutes(ctx);
  app.post('/api/android/text-media/:msgId/:mediaId', compat.textMediaUpload);
  app.post('/api/android/media', compat.mediaUpload);
  app.post('/api/apks/upload', requireAccount(ctx), requireUnlocked, apkUpload(ctx));

  // Device sync carries the installed-app list, so it gets a larger body allowance than the rest.
  app.use('/api/device/sync', express.json({ limit: '1mb' }));
  app.use('/api/warden/sync', express.json({ limit: '1mb' }));
  app.use('/api', express.json({ limit: '100kb' }));

  app.use('/api/device', deviceRoutes(ctx));
  // The kid-device API: what the kids' Android app (and later the Windows app) speaks.
  app.use('/api/warden', compat.warden);
  app.use('/api/android', compat.android);
  app.use('/api/warden', (_req: Request, _res: Response) => {
    throw new HttpError(404, 'That address does not exist.');
  });
  app.use('/api/android', (_req: Request, _res: Response) => {
    throw new HttpError(404, 'That address does not exist.');
  });
  app.use('/api', authRoutes(ctx));
  // Everything below needs a signed-in parent. Billing stays open to locked accounts; the rest answers 402.
  app.use('/api', requireAccount(ctx));
  app.use('/api', billingRoutes(ctx));
  app.use('/api', requireUnlocked, parentRoutes(ctx), phoneRoutes(ctx), compat.mediaParent);

  app.use('/api', (_req: Request, _res: Response) => {
    throw new HttpError(404, 'That address does not exist.');
  });
  app.use('/stripe', (_req: Request, _res: Response) => {
    throw new HttpError(404, 'That address does not exist.');
  });
  app.use('/internal', (_req: Request, _res: Response) => {
    throw new HttpError(404, 'That address does not exist.');
  });

  // A kid's photo or video shared with a link: the link itself is the key, and it shows that one item only.
  app.use('/m', compat.watch);
  app.use('/m', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'That address does not exist.' });
  });

  // The built parent console, when it is there (production). Any other path gets index.html.
  const indexHtml = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(config.webDist, {
        index: false,
        setHeaders(res, filePath) {
          const rel = path.relative(config.webDist, filePath);
          if (rel.startsWith(`assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'That address does not exist.' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...err.extra });
      return;
    }
    const e = err as { type?: string; status?: number; statusCode?: number; message?: string };
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'That request is too big.' });
      return;
    }
    if (e?.type === 'entity.parse.failed' || e?.type === 'charset.unsupported' || e?.type === 'encoding.unsupported') {
      res.status(400).json({ error: 'The request is not valid JSON.' });
      return;
    }
    const status = e?.status ?? e?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'The request could not be read.' });
      return;
    }
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}
