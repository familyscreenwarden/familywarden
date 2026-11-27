import { Router, type Request, type Response } from 'express';
import { account, type Ctx } from '../context';
import { Body, HttpError, isUuid } from '../http';
import { trialDaysLeft, type AccountRow } from '../state';
import { STRIPE_NOT_READY, verifyStripeSignature } from '../stripe';

export const PRICES = { month: 4, year: 36 } as const;

/** Parent billing routes. Open to locked accounts too, so they can choose a plan. */
export function billingRoutes(ctx: Ctx): Router {
  const r = Router();
  const pool = ctx.pool;

  r.get('/billing', (_req, res) => {
    const acc = account(res);
    res.json({
      plan: acc.plan,
      trialEndsAt: acc.trial_ends_at.toISOString(),
      trialDaysLeft: trialDaysLeft(acc, new Date()),
      prices: PRICES,
      stripeReady: ctx.stripe.ready,
    });
  });

  r.post('/billing/checkout', async (req, res) => {
    const acc = account(res);
    const interval = new Body(req.body).oneOf('interval', 'The interval', ['month', 'year'] as const);
    if (!ctx.stripe.ready) throw new HttpError(503, STRIPE_NOT_READY);
    const priceId = await ctx.stripe.findPriceId(interval);
    let customerId = acc.stripe_customer_id;
    if (!customerId) {
      customerId = await ctx.stripe.createCustomer(acc.email, acc.id);
      await pool.query('UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [acc.id, customerId]);
    }
    const url = await ctx.stripe.createCheckout({ customerId, priceId, accountId: acc.id });
    res.json({ url });
  });

  r.post('/billing/portal', async (_req, res) => {
    const acc = account(res);
    if (!ctx.stripe.ready) throw new HttpError(503, STRIPE_NOT_READY);
    if (!acc.stripe_customer_id) throw new HttpError(400, 'There is no plan to manage yet. Choose a plan first.');
    res.json({ url: await ctx.stripe.createPortal(acc.stripe_customer_id) });
  });

  return r;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length < 256 ? v : null;
}

/**
 * POST /stripe/webhook. The body must be the raw bytes (mounted with express.raw), because the signature covers them.
 */
export function stripeWebhook(ctx: Ctx) {
  const pool = ctx.pool;

  async function findAccount(metadataAccountId: string | null, customerId: string | null): Promise<AccountRow | null> {
    if (metadataAccountId && isUuid(metadataAccountId)) {
      const byId = await pool.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [metadataAccountId]);
      // If the account already has a customer, it must be this one.
      const row = byId.rows[0];
      if (row && (!row.stripe_customer_id || !customerId || row.stripe_customer_id === customerId)) return row;
    }
    if (customerId) {
      const byCustomer = await pool.query<AccountRow>('SELECT * FROM accounts WHERE stripe_customer_id = $1', [customerId]);
      if (byCustomer.rows[0]) return byCustomer.rows[0];
    }
    return null;
  }

  return async (req: Request, res: Response): Promise<void> => {
    if (!ctx.config.stripeWebhookSecret) throw new HttpError(503, 'Stripe webhooks are not set up on this server.');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const header = req.headers['stripe-signature'];
    if (!verifyStripeSignature(raw, typeof header === 'string' ? header : undefined, ctx.config.stripeWebhookSecret)) {
      throw new HttpError(400, 'The webhook signature is not valid.');
    }
    let event: { type?: unknown; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(raw.toString('utf8')) as typeof event;
    } catch {
      throw new HttpError(400, 'The webhook body is not JSON.');
    }
    const type = asString(event.type) ?? '';
    const obj = event.data?.object ?? {};

    if (type === 'checkout.session.completed') {
      const acc = await findAccount(asString(obj.client_reference_id), asString(obj.customer));
      const customerId = asString(obj.customer);
      const subscriptionId = asString(obj.subscription);
      if (acc && customerId && subscriptionId && obj.mode === 'subscription') {
        await pool.query(
          "UPDATE accounts SET stripe_customer_id = $2, stripe_subscription_id = $3, plan = 'active' WHERE id = $1",
          [acc.id, customerId, subscriptionId],
        );
      }
    } else if (
      type === 'customer.subscription.created' ||
      type === 'customer.subscription.updated' ||
      type === 'customer.subscription.deleted'
    ) {
      const metadata = (typeof obj.metadata === 'object' && obj.metadata !== null ? obj.metadata : {}) as Record<string, unknown>;
      const customerId = asString(obj.customer);
      const subscriptionId = asString(obj.id);
      const status = asString(obj.status) ?? '';
      const acc = await findAccount(asString(metadata.account_id), customerId);
      if (acc && subscriptionId) {
        const paying = type !== 'customer.subscription.deleted' && ['active', 'trialing', 'past_due'].includes(status);
        const ended = type === 'customer.subscription.deleted' || ['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(status);
        if (paying) {
          await pool.query(
            "UPDATE accounts SET plan = 'active', stripe_subscription_id = $2, stripe_customer_id = COALESCE($3, stripe_customer_id) WHERE id = $1",
            [acc.id, subscriptionId, customerId],
          );
        } else if (ended && (!acc.stripe_subscription_id || acc.stripe_subscription_id === subscriptionId)) {
          // Only the account's current subscription can end the plan. Back to the trial if it is still running.
          await pool.query(
            `UPDATE accounts
                SET plan = CASE WHEN trial_ends_at > now() THEN 'trial' ELSE 'locked' END,
                    stripe_subscription_id = NULL
              WHERE id = $1`,
            [acc.id],
          );
        }
      }
    }
    res.json({ received: true });
  };
}
