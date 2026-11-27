import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import type { Device, Kid, PairingCode, Platform } from '../api/types';
import { STATUS_COLOR } from '../components/charts';
import { Card, Confirm, ErrorBox, Loading, PageHead, StaleNote } from '../components/ui';
import { timeAgo } from '../lib/format';
import { EmergencyCode, PhoneApps, PhoneSetup } from './PhoneSetup';

const PLATFORM: Record<Platform, string> = { windows: 'Windows PC', android: 'Android phone' };

export function DevicesPage() {
  const { api } = useApp();
  const [params, setParams] = useSearchParams();
  const adding = params.get('add') === '1' || params.get('add') === 'phone';
  const addingPhone = params.get('add') === 'phone';
  const devices = useLoad(() => api.devices(), [], adding ? 10000 : 30000);
  const kids = useLoad(() => api.kids(), []);
  const list = devices.data?.devices;
  const kidList = kids.data?.kids;
  const error = devices.error ?? kids.error;

  const setAdding = (on: boolean | 'phone') => setParams(on ? { add: on === 'phone' ? 'phone' : '1' } : {}, { replace: true });

  return (
    <>
      <PageHead title="Devices" sub="Windows PCs and Android phones. Each device follows the rules of one kid.">
        {kidList && kidList.length > 0 && !adding && (
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setAdding('phone')}>Add a phone</button>
            <button type="button" className="btn btn-ghost" onClick={() => setAdding(true)}>Add a PC</button>
          </>
        )}
      </PageHead>

      {(!list || !kidList) && (error
        ? <ErrorBox message={error} onRetry={() => { void devices.reload(); void kids.reload(); }} />
        : <Loading label="Loading devices" />)}

      {list && kidList && (
        <>
          {devices.error && <StaleNote message={devices.error} />}
          {kidList.length === 0 ? (
            <Card className="first-run">
              <p>Add a kid first. Then you can pair their PC or phone.</p>
              <div><Link to="/kids/new" className="btn btn-primary">Add a kid</Link></div>
            </Card>
          ) : (
            <>
              {adding && <AddDevice key={addingPhone ? 'phone' : 'pc'} start={addingPhone ? 'android' : 'windows'} kids={kidList} devices={list} onClose={() => setAdding(false)} onPaired={devices.reload} />}
              {list.length === 0 && !adding && (
                <Card className="first-run">
                  <p style={{ fontSize: 16 }}>No devices yet.</p>
                  <p className="muted">Set up an Android phone with a QR code, or pair a Windows PC with a code from this console. iPhone, iPad, Mac and Chromebook are not supported.</p>
                  <div className="row">
                    <button type="button" className="btn btn-primary" onClick={() => setAdding('phone')}>Add a phone</button>
                    <button type="button" className="btn btn-ghost" onClick={() => setAdding(true)}>Add a PC</button>
                  </div>
                </Card>
              )}
              {list.length > 0 && (
                <div className="grid-300">
                  {list.map((d) => <DeviceCard key={d.id} device={d} kids={kidList} onChanged={devices.reload} />)}
                </div>
              )}
              <PhoneApps kids={kidList} devices={list} />
            </>
          )}
        </>
      )}
    </>
  );
}

function DeviceCard({ device, kids, onChanged }: { device: Device; kids: Kid[]; onChanged: () => Promise<void> }) {
  const { api, run } = useApp();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const nameId = useId(), kidId = useId();
  const st = STATUS_COLOR[device.status];
  const facts = [PLATFORM[device.platform], device.model, device.osVersion, device.appVersion ? `app ${device.appVersion}` : null].filter(Boolean);

  async function act(action: () => Promise<unknown>, okText: string): Promise<boolean> {
    setBusy(true);
    const ok = await run(action, okText);
    await onChanged();
    setBusy(false);
    return ok;
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    if (clean === device.name) { setRenaming(false); return; }
    if (await act(() => api.updateDevice(device.id, { name: clean }), `Renamed to ${clean}.`)) setRenaming(false);
  }

  return (
    <section className="card" aria-label={device.name}>
      {renaming ? (
        <form className="stack" onSubmit={(e) => void rename(e)}>
          <div className="field">
            <label htmlFor={nameId}>Device name</label>
            <input id={nameId} className="input" value={name} maxLength={60} autoFocus autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save name'}</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setName(device.name); setRenaming(false); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <h2 style={{ fontSize: 18, fontWeight: 500, overflowWrap: 'anywhere' }}>{device.name}</h2>
            <div className="small muted">{facts.join(' · ')}</div>
          </div>
          <span className="row small" style={{ gap: 6 }}>
            <span className="dot" style={{ background: st.dot }} aria-hidden="true" />{st.label}
          </span>
        </div>
      )}
      <div className="small muted">
        {device.status === 'off' ? `Last seen ${timeAgo(device.lastSeenAt)}` : `Online, seen ${timeAgo(device.lastSeenAt)}`}
      </div>
      <div className="row-between">
        <label htmlFor={kidId}>Follows the rules of</label>
        <select id={kidId} className="select w-180" value={device.kidId} disabled={busy}
          onChange={(e) => {
            const target = kids.find((k) => k.id === e.target.value);
            if (target) void act(() => api.updateDevice(device.id, { kidId: target.id }), `${device.name} now follows ${target.name}'s rules.`);
          }}>
          {!kids.some((k) => k.id === device.kidId) && <option value={device.kidId}>{device.kidName}</option>}
          {kids.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
      </div>
      {!renaming && (
        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={() => setRenaming(true)} aria-label={`Rename ${device.name}`}>Rename</button>
          <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)} aria-label={`Remove ${device.name}`}>Remove</button>
          {device.platform === 'android' && <Link to={`/kids/${device.kidId}/phone`} className="btn btn-ghost">Phone rules</Link>}
        </div>
      )}
      {!renaming && device.platform === 'android' && <EmergencyCode device={device} />}
      <Confirm open={confirm} title={`Remove ${device.name}?`} confirmLabel="Remove device" danger busy={busy}
        body="The device is unpaired from your family and stops getting rule changes from this console. To use it again you need to pair it with a new code."
        onCancel={() => setConfirm(false)}
        onConfirm={() => void act(() => api.deleteDevice(device.id), `${device.name} was removed.`).then(() => setConfirm(false))} />
    </section>
  );
}

function clock(d: Date): string {
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

function AddDevice({ kids, devices, onClose, onPaired, start }: {
  kids: Kid[]; devices: Device[]; onClose: () => void; onPaired: () => Promise<void>; start: Platform;
}) {
  const { api, run } = useApp();
  const [kidId, setKidId] = useState(kids[kids.length - 1]?.id ?? '');
  const [platform, setPlatform] = useState<Platform>(start);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef<Set<string>>(new Set(devices.map((d) => d.id)));
  const kidSel = useId();
  const kid = kids.find((k) => k.id === kidId);

  useEffect(() => {
    if (!code) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [code]);

  const paired = code ? devices.find((d) => !known.current.has(d.id)) : undefined;
  const expires = code ? new Date(code.expiresAt) : null;
  const msLeft = expires ? expires.getTime() - now : 0;
  const expired = Boolean(code) && msLeft <= 0;
  const minLeft = Math.max(0, Math.ceil(msLeft / 60000));

  async function getCode() {
    if (!kidId) return;
    setBusy(true);
    known.current = new Set(devices.map((d) => d.id));
    let fresh: PairingCode | null = null;
    await run(async () => { fresh = await api.pairingCode(kidId, platform); });
    setNow(Date.now());
    setCode(fresh);
    setBusy(false);
  }

  return (
    <Card title={platform === 'android' ? 'Add a phone' : 'Add a PC'} action={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {platform === 'android' && (
        <PhoneSetup kids={kids} kidId={kidId} onKid={setKidId} devices={devices} onClose={onClose} onCheck={onPaired} />
      )}
      {platform === 'windows' && !code && (
        <form className="stack-lg" onSubmit={(e) => { e.preventDefault(); void getCode(); }}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor={kidSel}>Whose device is it?</label>
              <select id={kidSel} className="select" value={kidId} onChange={(e) => setKidId(e.target.value)}>
                {kids.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </div>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label" style={{ padding: 0, marginBottom: 6 }}>What kind of device?</legend>
              <div className="row" style={{ gap: 18 }}>
                {(['windows', 'android'] as const).map((p) => (
                  <label key={p} className="check">
                    <input type="radio" name="platform" value={p} checked={platform === p} onChange={() => setPlatform(p)} />
                    {PLATFORM[p]}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <p className="small muted">iPhone, iPad, Mac and Chromebook are not supported.</p>
          <div><button type="submit" className="btn btn-primary" disabled={busy || !kidId}>{busy ? 'Getting a code…' : 'Get a pairing code'}</button></div>
        </form>
      )}

      {platform === 'windows' && code && (
        <div className="stack-lg">
          {paired ? (
            <div className="banner banner-info" role="status">
              <span className="grow"><strong>{paired.name}</strong> is paired and follows {paired.kidName}'s rules.</span>
              <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          ) : (
            <>
              <div>
                <div className="small muted">Pairing code for {kid?.name ?? 'your kid'}'s {PLATFORM[platform]}</div>
                <div className="code" aria-label={`Pairing code: ${code.code.split('').join(' ')}`}>{code.code}</div>
                <div className="small" role="status">
                  {expired
                    ? <span className="hint-error">This code has expired. Get a new one.</span>
                    : <>Works once. Expires at {expires ? clock(expires) : ''}, in {minLeft} min.</>}
                </div>
              </div>
              <ol className="steps">
                {platform === 'windows' ? (
                  <>
                    <li>On the kid's PC, install the Family Screen Warden app for Windows from familyscreenwarden.com.</li>
                    <li>Open the app and type this code when it asks.</li>
                    <li>The PC shows up in the list below when it has paired.</li>
                  </>
                ) : (
                  <>
                    <li>Factory-reset the phone. This erases it, so back up what you want to keep first.</li>
                    <li>On the first welcome screen after the reset, scan the Family Screen Warden setup QR code from familyscreenwarden.com. This sets the phone up in device-owner mode.</li>
                    <li>Type this code when the app asks. The phone shows up in the list below when it has paired.</li>
                  </>
                )}
              </ol>
              <div className="row">
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void getCode()}>{busy ? 'Getting a code…' : 'Get a new code'}</button>
                <button type="button" className="btn btn-ghost" onClick={() => void onPaired()}>Check for the device now</button>
                <button type="button" className="btn btn-ghost" onClick={() => setCode(null)}>Back</button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
