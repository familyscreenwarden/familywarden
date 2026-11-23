import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApp } from '../app';
import { errorMessage } from '../api/client';
import { Logo } from '../components/ui';

export function SignIn() {
  const { api } = useApp();
  const [params] = useSearchParams();
  const expired = params.get('error') === 'expired';
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; devLink?: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const clean = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) { setError('Please type your email address, like name@example.com.'); return; }
    setError(null);
    setBusy(true);
    try {
      const res = await api.requestLink(clean);
      setSent({ email: clean, devLink: typeof res?.devLink === 'string' ? res.devLink : undefined });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <div className="signin-card">
        <div className="row" style={{ gap: 12 }}>
          <Logo />
          <div className="brand-name">Family<br />Screen Warden</div>
        </div>
        {sent ? (
          <>
            <h1>Check your email</h1>
            <p role="status">
              We sent a sign-in link to <strong style={{ overflowWrap: 'anywhere' }}>{sent.email}</strong>. Open it on this device to sign in.
              The link works once and expires after 15 minutes.
            </p>
            {sent.devLink && (
              <div className="banner banner-info stack" style={{ alignItems: 'flex-start' }}>
                <span className="pill pill-warn">Development shortcut</span>
                <span className="small">This server is in development mode, so the link is also shown here:</span>
                <a href={sent.devLink} style={{ overflowWrap: 'anywhere' }}>Open the sign-in link</a>
              </div>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => setSent(null)}>Use a different email</button>
          </>
        ) : (
          <>
            <div>
              <h1>Sign in</h1>
              <p className="muted" style={{ marginTop: 6 }}>Type your email and we will send you a sign-in link. No password needed. New here? The same form starts your 30-day free trial, no card needed.</p>
            </div>
            {expired && (
              <div className="banner banner-warn" role="alert">That sign-in link has expired or was already used. Ask for a new one below.</div>
            )}
            <form className="stack-lg" onSubmit={(e) => void submit(e)} noValidate>
              <div className="field">
                <label htmlFor="email">Email address</label>
                <input id="email" className="input" type="email" inputMode="email" autoComplete="email" autoFocus value={email}
                  aria-invalid={error ? true : undefined} aria-describedby={error ? 'email-err' : undefined}
                  onChange={(e) => setEmail(e.target.value)} />
                {error && <div id="email-err" className="hint-error" role="alert">{error}</div>}
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Email me a sign-in link'}</button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
