import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../app';
import { useShell } from '../components/Layout';
import { Card, PageHead } from '../components/ui';

const FALLBACK_ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'Europe/London',
  'Europe/Berlin', 'Europe/Paris', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];

function allZones(current: string): string[] {
  let zones = FALLBACK_ZONES;
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const list = intl.supportedValuesOf?.('timeZone');
    if (list && list.length) zones = list;
  } catch { /* keep the short list */ }
  return zones.includes(current) ? zones : [current, ...zones];
}

export function SettingsPage() {
  const { api, run, locked } = useApp();
  const { account, reloadAccount } = useShell();
  const navigate = useNavigate();
  const zones = useMemo(() => allZones(account.timezone), [account.timezone]);
  const [tz, setTz] = useState(account.timezone);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ids = { tz: useId(), pin: useId(), pin2: useId(), err: useId() };
  const readOnly = locked || account.plan === 'locked';

  async function saveZone(e: FormEvent) {
    e.preventDefault();
    setBusy('tz');
    await run(() => api.updateAccount({ timezone: tz }), `Time zone set to ${tz.replace(/_/g, ' ')}.`);
    await reloadAccount();
    setBusy(null);
  }

  async function savePin(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{4,8}$/.test(pin)) { setPinError('The PIN must be 4 to 8 digits.'); return; }
    if (pin !== pin2) { setPinError('The two PINs do not match.'); return; }
    setPinError(null);
    setBusy('pin');
    if (await run(() => api.updateAccount({ pin }), 'Parent PIN saved.')) { setPin(''); setPin2(''); }
    await reloadAccount();
    setBusy(null);
  }

  async function signOut() {
    setBusy('out');
    if (await run(() => api.logout())) navigate('/signin', { replace: true });
    setBusy(null);
  }

  return (
    <>
      <PageHead title="Settings" sub={`Signed in as ${account.email}`} />
      {readOnly && <div className="banner banner-warn" role="status">Your trial has ended, so settings cannot be changed until you choose a plan. You can still sign out.</div>}
      <div className="grid-300">
        <Card title="Time zone">
          <form className="stack-lg" onSubmit={(e) => void saveZone(e)}>
            <div className="field">
              <label htmlFor={ids.tz}>Your family's time zone</label>
              <select id={ids.tz} className="select" value={tz} disabled={readOnly} onChange={(e) => setTz(e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <p className="small muted">Bedtimes, daily limits and the midnight reset all use this time zone.</p>
            <div><button type="submit" className="btn btn-primary" disabled={readOnly || busy === 'tz' || tz === account.timezone}>{busy === 'tz' ? 'Saving…' : 'Save time zone'}</button></div>
          </form>
        </Card>

        <Card title="Parent PIN" action={<span className={`pill ${account.hasPin ? 'pill-deep' : 'pill-off'}`}>{account.hasPin ? 'PIN is set' : 'No PIN yet'}</span>}>
          <form className="stack-lg" onSubmit={(e) => void savePin(e)} noValidate>
            <p className="small muted">Type this PIN on a kid's device to skip a lock, such as bedtime, for a short while. Use 4 to 8 digits and keep it to yourself.</p>
            <div className="form-grid">
              <div className="field">
                <label htmlFor={ids.pin}>{account.hasPin ? 'New PIN' : 'PIN'}</label>
                <input id={ids.pin} className="input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin} disabled={readOnly}
                  aria-invalid={pinError ? true : undefined} aria-describedby={pinError ? ids.err : undefined}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
              </div>
              <div className="field">
                <label htmlFor={ids.pin2}>Type it again</label>
                <input id={ids.pin2} className="input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin2} disabled={readOnly}
                  onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} />
              </div>
            </div>
            {pinError && <div id={ids.err} className="hint-error" role="alert">{pinError}</div>}
            <div><button type="submit" className="btn btn-primary" disabled={readOnly || busy === 'pin' || !pin}>{busy === 'pin' ? 'Saving…' : account.hasPin ? 'Change PIN' : 'Set PIN'}</button></div>
          </form>
        </Card>

        <Card title="Sign out">
          <p className="small muted">Signing out here does not change anything on your kids' devices.</p>
          <div><button type="button" className="btn btn-ghost" disabled={busy === 'out'} onClick={() => void signOut()}>{busy === 'out' ? 'Signing out…' : 'Sign out'}</button></div>
        </Card>
      </div>
    </>
  );
}
