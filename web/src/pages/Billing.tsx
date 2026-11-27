import { useState } from 'react';
import { useApp, useLoad } from '../app';
import { errorMessage } from '../api/client';
import { Card, ErrorBox, Loading, PageHead } from '../components/ui';
import { plural } from '../lib/format';

function dateText(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function BillingPage() {
  const { api } = useApp();
  const billing = useLoad(() => api.billing(), []);
  const [busy, setBusy] = useState<'month' | 'year' | 'portal' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const b = billing.data;

  async function go(which: 'month' | 'year' | 'portal') {
    setBusy(which);
    setError(null);
    try {
      const res = which === 'portal' ? await api.portal() : await api.checkout(which);
      if (res && typeof res.url === 'string' && res.url) {
        window.location.assign(res.url);
        return;
      }
      setError('The payment page could not be opened. Please try again.');
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(null);
  }

  if (!b) {
    return (
      <>
        <PageHead title="Billing" />
        {billing.error ? <ErrorBox message={billing.error} onRetry={() => void billing.reload()} /> : <Loading label="Loading billing" />}
      </>
    );
  }

  if (b.billingEnabled === false) {
    return (
      <>
        <PageHead title="Billing" />
        <Card title="Your plan">
          <div className="row"><span className="mid-num">Free</span><span className="pill pill-deep">Nothing to pay</span></div>
          <p className="muted">Family Screen Warden is free to use right now, with unlimited kids and devices. There is no trial clock and no card is needed.</p>
        </Card>
      </>
    );
  }

  const daysLeft = b.trialDaysLeft ?? 0;
  const ends = dateText(b.trialEndsAt);

  return (
    <>
      <PageHead title="Billing" sub="One plan per family, with unlimited kids and devices." />
      <Card title="Your plan">
        {b.plan === 'trial' && (
          <>
            <div className="row"><span className="mid-num">{plural(daysLeft, 'day', 'days')} left</span><span className="pill pill-peri">Free trial</span></div>
            <p className="muted">Your 30-day free trial{ends ? ` ends on ${ends}` : ''}. No card is needed until you choose a plan. If the trial ends without a plan, the console locks and device rules keep working with the last settings.</p>
          </>
        )}
        {b.plan === 'active' && (
          <>
            <div className="row"><span className="mid-num">Family plan</span><span className="pill pill-deep">Active</span></div>
            <p className="muted">Thank you. Change your card, switch between monthly and yearly, or cancel from the billing portal.</p>
            <div><button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void go('portal')}>{busy === 'portal' ? 'Opening…' : 'Manage billing'}</button></div>
          </>
        )}
        {b.plan === 'locked' && (
          <>
            <div className="row"><span className="mid-num">Trial ended</span><span className="pill pill-warn">Choose a plan</span></div>
            <p className="muted">The console is locked until you choose a plan. Device rules keep working with the last settings you saved.</p>
          </>
        )}
      </Card>

      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {!b.stripeReady && !error && (
        <div className="banner banner-info small" role="note">Payments are not set up on this server yet, so choosing a plan will not work right now.</div>
      )}

      {b.plan !== 'active' && (
        <div className="grid-260">
          <Card title="Monthly">
            <div className="row" style={{ alignItems: 'baseline' }}><span className="big-num">${b.prices.month}</span><span className="muted">a month per family</span></div>
            <p className="small muted">Unlimited kids and devices.</p>
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void go('month')}>
              {busy === 'month' ? 'Opening…' : `Choose monthly, $${b.prices.month} a month`}
            </button>
          </Card>
          <Card title="Yearly">
            <div className="row" style={{ alignItems: 'baseline' }}><span className="big-num">${b.prices.year}</span><span className="muted">a year per family</span></div>
            <p className="small muted">Unlimited kids and devices.</p>
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void go('year')}>
              {busy === 'year' ? 'Opening…' : `Choose yearly, $${b.prices.year} a year`}
            </button>
          </Card>
        </div>
      )}
    </>
  );
}
