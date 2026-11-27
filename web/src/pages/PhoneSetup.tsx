import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useApp, useLoad } from '../app';
import type { Apk, Device, Kid, SetupQr, UnlockCode, WifiInput } from '../api/types';
import { Card, Confirm, ErrorBox, ICON, Icon, Loading } from '../components/ui';
import { timeAgo } from '../lib/format';

/** An SVG the server made (a QR code), shown as a picture. Never put into the page as markup. */
function QrImage({ svg, label }: { svg: string; label: string }) {
  return <img className="qr" alt={label} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} />;
}

function clock(d: Date): string {
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** "Add a phone": pick the kid, optionally the Wi-Fi, and get the QR code Android's setup screen scans. */
export function PhoneSetup({ kids, kidId, onKid, devices, onClose, onCheck }: {
  kids: Kid[]; kidId: string; onKid: (id: string) => void; devices: Device[]; onClose: () => void; onCheck: () => Promise<void>;
}) {
  const { api, run } = useApp();
  const app = useLoad(() => api.androidApp(), []);
  const [useWifi, setUseWifi] = useState(false);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [security, setSecurity] = useState<WifiInput['security']>('WPA');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<SetupQr | null>(null);
  const [quick, setQuick] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef<Set<string>>(new Set(devices.map((d) => d.id)));
  const ids = { kid: useId(), ssid: useId(), pass: useId(), sec: useId(), err: useId() };
  const kid = kids.find((k) => k.id === kidId);

  useEffect(() => {
    if (!qr) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [qr]);

  const paired = qr ? devices.find((d) => !known.current.has(d.id) && d.platform === 'android') : undefined;
  const expires = qr ? new Date(qr.expiresAt) : null;
  const minLeft = expires ? Math.max(0, Math.ceil((expires.getTime() - now) / 60000)) : 0;
  const expired = Boolean(qr) && minLeft <= 0;

  async function make(e?: FormEvent) {
    e?.preventDefault();
    if (!kidId) return;
    if (useWifi && !ssid.trim()) { setError('Please type the name of your Wi-Fi, or untick "Put the Wi-Fi in the QR code".'); return; }
    setError(null);
    setBusy(true);
    known.current = new Set(devices.map((d) => d.id));
    let fresh: SetupQr | null = null;
    const wifi: WifiInput | null = useWifi ? { ssid: ssid.trim(), security, ...(security !== 'NONE' && password ? { password } : {}) } : null;
    await run(async () => { fresh = await api.setupQr(kidId, wifi); });
    setNow(Date.now());
    setQr(fresh);
    setBusy(false);
  }

  if (!app.data) {
    return app.error ? <ErrorBox message={app.error} onRetry={() => void app.reload()} /> : <Loading label="Checking the phone app" />;
  }
  if (!app.data.latest) {
    return (
      <div className="banner banner-warn" role="status">
        <span className="grow">The kids' app for Android is not published on this server yet, so a phone has nothing to download. Publish it from GitHub (Actions, "Android app", Run workflow with Publish ticked), then come back here.</span>
        <button type="button" className="btn btn-ghost" onClick={() => void app.reload()}>Check again</button>
      </div>
    );
  }

  if (!qr) {
    return (
      <form className="stack-lg" onSubmit={(e) => void make(e)} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor={ids.kid}>Whose phone is it?</label>
            <select id={ids.kid} className="select" value={kidId} onChange={(e) => onKid(e.target.value)}>
              {kids.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={useWifi} onChange={(e) => setUseWifi(e.target.checked)} />
          Put the Wi-Fi in the QR code, so the phone connects by itself
        </label>
        {useWifi && (
          <div className="form-grid">
            <div className="field">
              <label htmlFor={ids.ssid}>Wi-Fi name</label>
              <input id={ids.ssid} className="input" value={ssid} maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false}
                aria-invalid={error ? true : undefined} aria-describedby={error ? ids.err : undefined} onChange={(e) => setSsid(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={ids.sec}>Security</label>
              <select id={ids.sec} className="select" value={security} onChange={(e) => setSecurity(e.target.value as WifiInput['security'])}>
                <option value="WPA">WPA / WPA2 (most home Wi-Fi)</option>
                <option value="WEP">WEP (old routers)</option>
                <option value="NONE">Open, no password</option>
              </select>
            </div>
            {security !== 'NONE' && (
              <div className="field">
                <label htmlFor={ids.pass}>Wi-Fi password</label>
                <input id={ids.pass} className="input" type="password" value={password} maxLength={64} autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
          </div>
        )}
        {useWifi && <p className="small muted">The Wi-Fi password only goes into the QR code on this screen. It is not saved.</p>}
        {error && <div id={ids.err} className="hint-error" role="alert">{error}</div>}
        <div className="banner banner-warn small">Full setup needs a factory reset, which erases everything on the phone. Back up what you want to keep first. Android 9 or newer.</div>
        <div><button type="submit" className="btn btn-primary" disabled={busy || !kidId}>{busy ? 'Making the QR code…' : 'Make the setup QR code'}</button></div>
        <p className="small muted">The phone will download version {app.data.latest.version} of the app.</p>
      </form>
    );
  }

  if (paired) {
    return (
      <div className="banner banner-info" role="status">
        <span className="grow"><strong>{paired.name}</strong> is set up and follows {paired.kidName}'s rules.</span>
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <div className="qr-wrap">
        <QrImage svg={quick ? qr.linkSvg : qr.svg}
          label={quick ? `Quick-install QR code for ${kid?.name ?? 'your kid'}'s phone` : `Setup QR code for ${kid?.name ?? 'your kid'}'s phone`} />
        <div className="stack grow" style={{ minWidth: 0 }}>
          <div className="small muted">{quick ? 'Quick install' : 'Full setup'} for {kid?.name ?? 'your kid'}'s phone</div>
          {quick ? (
            <ol className="steps">
              <li>Open the camera on the phone and point it at this code. Open the link it shows.</li>
              <li>Tap Download, open the file and install it. Then tap "Open the app" on that page.</li>
              <li>If the app asks, the setup code is <strong className="mono">{qr.code}</strong>.</li>
            </ol>
          ) : (
            <ol className="steps">
              <li>Factory-reset the phone (this erases it).</li>
              <li>On the first welcome screen, tap the same spot 6 times. A QR scanner opens.</li>
              <li>Scan this code. The phone downloads the app and sets itself up for {kid?.name ?? 'your kid'}.</li>
              <li>Allow usage access and call screening when the phone asks, then tap Start.</li>
            </ol>
          )}
          <div className="small" role="status">
            {expired
              ? <span className="hint-error">This code has expired. Make a new one.</span>
              : <>Works for one phone. Expires at {expires ? clock(expires) : ''}, in {minLeft} min.</>}
          </div>
        </div>
      </div>
      {quick && (
        <div className="banner banner-info small">Quick install is for trying it out on a phone you do not want to reset. The app counts time and shows the launcher, but it cannot lock the phone down.</div>
      )}
      <div className="row">
        <button type="button" className="btn btn-ghost" onClick={() => void onCheck()}>Check for the phone now</button>
        <button type="button" className="btn btn-ghost" onClick={() => setQuick((q) => !q)}>{quick ? 'Show the full setup code' : 'Just trying it out? Quick install'}</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void make()}>{busy ? 'Making…' : 'Make a new code'}</button>
        <button type="button" className="btn btn-ghost" onClick={() => setQr(null)}>Back</button>
      </div>
    </div>
  );
}

/** An emergency code for a phone: 8 digits the phone checks by itself, also with no internet. */
export function EmergencyCode({ device }: { device: Device }) {
  const { api, run } = useApp();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<UnlockCode | null>(null);

  async function get() {
    setBusy(true);
    let fresh: UnlockCode | null = null;
    await run(async () => { fresh = await api.unlockCode(device.id); });
    setCode(fresh);
    setBusy(false);
  }

  if (code) {
    return (
      <div className="inset stack" role="status">
        <div className="small muted">Emergency code for {device.name}</div>
        <div className="code code-small" aria-label={`Emergency code: ${code.code.split('').join(' ')}`}>{code.code.slice(0, 4)} {code.code.slice(4)}</div>
        <div className="small">On the phone: Grown-up, then type this code. It unlocks the phone for 60 minutes, works once, also without internet, and runs out in 24 hours.</div>
        <div><button type="button" className="btn btn-ghost" onClick={() => setCode(null)}>Hide</button></div>
      </div>
    );
  }
  return (
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void get()} aria-label={`Emergency code for ${device.name}`}>
      {busy ? 'Getting a code…' : 'Emergency code'}
    </button>
  );
}

function megabytes(bytes: number): string {
  return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

const PUSH_LABEL: Record<string, { text: string; cls: string }> = {
  waiting: { text: 'Waiting for the phone', cls: 'pill-peri' },
  installing: { text: 'Installing', cls: 'pill-peri' },
  done: { text: 'Installed', cls: 'pill-deep' },
  failed: { text: 'Did not install', cls: 'pill-warn' },
};

/** APK files a parent uploads and sends to kids' phones, with how each install went. */
export function PhoneApps({ kids, devices }: { kids: Kid[]; devices: Device[] }) {
  const { api, run } = useApp();
  // Refreshed every 10 seconds, so "Waiting for the phone" turns into "Installed" without a reload.
  const apks = useLoad(() => api.apks(), [], 10000);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Apk | null>(null);
  const [target, setTarget] = useState<Record<string, string>>({});
  const ids = { name: useId(), file: useId(), err: useId() };
  const list = apks.data?.apks;
  const phoneKids = kids.filter((k) => devices.some((d) => d.platform === 'android' && d.kidId === k.id));

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) { setError('Please choose the .apk file.'); return; }
    if (!name.trim()) { setError('Please give the app a name.'); return; }
    if (apks.data && file.size > apks.data.maxBytes) { setError(`That file is too big (${megabytes(apks.data.maxBytes)} at most).`); return; }
    setError(null);
    setBusy('upload');
    const ok = await run(() => api.uploadApk(name.trim(), file), `${name.trim()} was uploaded. Now send it to a phone.`);
    await apks.reload();
    setBusy(null);
    if (ok) { setAdding(false); setName(''); setFile(null); }
  }

  async function push(a: Apk) {
    const kidId = target[a.id] ?? phoneKids[0]?.id;
    const kid = phoneKids.find((k) => k.id === kidId);
    if (!kid) return;
    setBusy(`push-${a.id}`);
    await run(() => api.pushApk(a.id, [kid.id]), `${a.name} is on its way to ${kid.name}'s phone. It installs by itself and is then allowed.`);
    await apks.reload();
    setBusy(null);
  }

  return (
    <Card title="Apps to install on phones" action={(
      <button type="button" className="btn btn-secondary" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : 'Upload an app file'}</button>
    )}>
      <p className="small muted">For apps that are not in the Play Store: upload the .apk file and send it to a kid's phone. It installs by itself and is allowed once it is on the phone. Play Store apps are installed on the phone itself, from the Grown-up menu.</p>
      {adding && (
        <form className="inset stack-lg" onSubmit={(e) => void upload(e)} noValidate aria-label="Upload an app file">
          <div className="form-grid">
            <div className="field">
              <label htmlFor={ids.file}>App file (.apk)</label>
              <input id={ids.file} className="input file-input" type="file" accept=".apk,application/vnd.android.package-archive"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f && !name) setName(f.name.replace(/\.apk$/i, '').replace(/[-_.]+/g, ' ').slice(0, 80));
                }} />
            </div>
            <div className="field">
              <label htmlFor={ids.name}>Name to show</label>
              <input id={ids.name} className="input" value={name} maxLength={80} autoComplete="off"
                aria-invalid={error ? true : undefined} aria-describedby={error ? ids.err : undefined} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          {error && <div id={ids.err} className="hint-error" role="alert">{error}</div>}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy === 'upload'}>{busy === 'upload' ? 'Uploading…' : 'Upload'}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
      {!list && (apks.error ? <ErrorBox message={apks.error} onRetry={() => void apks.reload()} /> : <Loading label="Loading app files" />)}
      {list && list.length === 0 && !adding && <p className="empty">No app files yet.</p>}
      {list && list.map((a) => (
        <div key={a.id} className="inset stack">
          <div className="row-between" style={{ alignItems: 'flex-start' }}>
            <div className="grow">
              <div style={{ fontSize: 15, fontWeight: 500, overflowWrap: 'anywhere' }}>{a.name}</div>
              <div className="tiny muted" style={{ overflowWrap: 'anywhere' }}>{[a.package, a.fileName, megabytes(a.size), `uploaded ${timeAgo(a.createdAt)}`].filter(Boolean).join(' · ')}</div>
            </div>
            <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove ${a.name}`} onClick={() => setRemoving(a)}><Icon d={ICON.trash} /></button>
          </div>
          {phoneKids.length === 0 ? (
            <div className="small muted">No kid has an Android phone yet. Add a phone first.</div>
          ) : (
            <div className="row">
              <label className="sr-only" htmlFor={`${ids.name}-${a.id}`}>Send {a.name} to</label>
              <select id={`${ids.name}-${a.id}`} className="select w-180" value={target[a.id] ?? phoneKids[0]?.id ?? ''}
                onChange={(e) => setTarget((t) => ({ ...t, [a.id]: e.target.value }))}>
                {phoneKids.map((k) => <option key={k.id} value={k.id}>{k.name}'s phone</option>)}
              </select>
              <button type="button" className="btn btn-secondary" disabled={busy === `push-${a.id}`} onClick={() => void push(a)}>
                {busy === `push-${a.id}` ? 'Sending…' : 'Install on the phone'}
              </button>
            </div>
          )}
          {a.pushes.length > 0 && (
            <ul className="plain-list" aria-label={`Installs of ${a.name}`}>
              {a.pushes.slice(0, 6).map((p) => {
                const label = PUSH_LABEL[p.status] ?? { text: p.status, cls: 'pill-off' };
                return (
                  <li key={p.id} className="small">
                    <span className={`pill ${label.cls}`}>{label.text}</span>
                    <span className="grow" style={{ overflowWrap: 'anywhere' }}>{p.deviceName}, {timeAgo(p.at)}{p.status === 'failed' && p.message ? `. The phone said: ${p.message}` : ''}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
      <Confirm open={removing !== null} title={`Remove ${removing?.name ?? ''}?`} confirmLabel="Remove the file" danger busy={busy === 'remove'}
        body="The file is deleted from this console. Phones that already installed the app keep it, and it stays in the kid's app list."
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          const a = removing;
          setBusy('remove');
          void run(() => api.deleteApk(a.id), `${a.name} was removed.`).then(async () => { await apks.reload(); setBusy(null); setRemoving(null); });
        }} />
    </Card>
  );
}
