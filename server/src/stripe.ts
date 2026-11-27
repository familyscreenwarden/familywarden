import type { Config } from './config';
import { hmacSha256, safeEqualHex } from './crypto';
import { HttpError } from './http';

export const LOOKUP_KEYS = { month: 'fsw_family_month', year: 'fsw_family_year' } as const;
export type Interval = keyof typeof LOOKUP_KEYS;

export const STRIPE_NOT_READY = 'Payments are not set up on this server yet. Please try again later.';

/**
 * Checks a Stripe-Signature header by hand: HMAC-SHA256 over "<t>.<raw body>" with the webhook secret,
 * compared in constant time, and the timestamp must be within `toleranceSeconds` of now.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  if (!header || !secret) return false;
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;
  const expected = hmacSha256(secret, Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody])).toString('hex');
  let ok = false;
  for (const sig of signatures) {
    if (safeEqualHex(sig.toLowerCase(), expected)) ok = true;
  }
  return ok;
}

/** Builds a Stripe-Signature header (used by tests and handy for local webhook testing). */
export function signStripePayload(payload: string, secret: string, timestampSeconds: number): string {
  const sig = hmacSha256(secret, `${timestampSeconds}.${payload}`).toString('hex');
  return `t=${timestampSeconds},v1=${sig}`;
}

type Params = Array<[string, string]>;

export class StripeClient {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get ready(): boolean {
    return this.config.stripeSecretKey.length > 0;
  }

  private async call(method: 'GET' | 'POST', path: string, params: Params): Promise<Record<string, unknown>> {
    if (!this.ready) throw new HttpError(503, STRIPE_NOT_READY);
    const encoded = new URLSearchParams(params).toString();
    const url = `${this.config.stripeApiBase}${path}${method === 'GET' && encoded ? `?${encoded}` : ''}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.config.stripeSecretKey}`,
          ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: method === 'POST' ? encoded : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      console.error('[stripe] request failed:', err instanceof Error ? err.message : err);
      throw new HttpError(502, 'The payment service did not answer. Please try again in a minute.');
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok || typeof json !== 'object' || json === null) {
      const err = (json as { error?: { message?: unknown } } | null)?.error?.message;
      console.error(`[stripe] ${method} ${path} answered ${res.status}: ${typeof err === 'string' ? err : 'no detail'}`);
      throw new HttpError(502, 'The payment service refused the request. Please try again in a minute.');
    }
    return json as Record<string, unknown>;
  }

  async findPriceId(interval: Interval): Promise<string> {
    const key = LOOKUP_KEYS[interval];
    const json = await this.call('GET', '/v1/prices', [
      ['lookup_keys[]', key],
      ['active', 'true'],
      ['limit', '1'],
    ]);
    const first = Array.isArray(json.data) ? (json.data[0] as { id?: unknown } | undefined) : undefined;
    if (!first || typeof first.id !== 'string') {
      console.error(`[stripe] no active price with lookup key ${key}`);
      throw new HttpError(503, 'The plan is not set up in the payment service yet. Please try again later.');
    }
    return first.id;
  }

  async createCustomer(email: string, accountId: string): Promise<string> {
    const json = await this.call('POST', '/v1/customers', [
      ['email', email],
      ['metadata[account_id]', accountId],
    ]);
    if (typeof json.id !== 'string') throw new HttpError(502, 'The payment service gave an answer we could not read.');
    return json.id;
  }

  async createCheckout(args: { customerId: string; priceId: string; accountId: string }): Promise<string> {
    const base = this.config.publicUrl;
    const json = await this.call('POST', '/v1/checkout/sessions', [
      ['mode', 'subscription'],
      ['customer', args.customerId],
      ['client_reference_id', args.accountId],
      ['line_items[0][price]', args.priceId],
      ['line_items[0][quantity]', '1'],
      ['subscription_data[metadata][account_id]', args.accountId],
      ['success_url', `${base}/billing?checkout=success`],
      ['cancel_url', `${base}/billing?checkout=cancelled`],
    ]);
    if (typeof json.url !== 'string') throw new HttpError(502, 'The payment service gave an answer we could not read.');
    return json.url;
  }

  async createPortal(customerId: string): Promise<string> {
    const json = await this.call('POST', '/v1/billing_portal/sessions', [
      ['customer', customerId],
      ['return_url', `${this.config.publicUrl}/billing`],
    ]);
    if (typeof json.url !== 'string') throw new HttpError(502, 'The payment service gave an answer we could not read.');
    return json.url;
  }
}
