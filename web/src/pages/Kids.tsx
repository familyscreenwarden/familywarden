import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import type { AppPlatform, Contact, ContactInput, Kid, KidApp, KidDetail, KidPatch, NewApp } from '../api/types';
import { SafeSwitches } from '../components/SafeSwitches';
import { Card, Confirm, ErrorBox, ICON, Icon, Loading, PageHead, Progress, Switch } from '../components/ui';
import { KID_COLORS, safeColor, textOn } from '../lib/color';
import { formatClockShort, formatLimitOption, formatMinutes, joinList, possessive } from '../lib/format';
import { FirstRun } from './Dashboard';
import { KidSections } from '../components/KidNav';

const DAY_LIMITS = [30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360, 480];
const APP_LIMITS = [15, 30, 45, 60, 90, 120, 180];

function withCurrent(list: number[], current: number | null): number[] {
  if (current == null || list.includes(current)) return list;
  return [...list, current].sort((a, b) => a - b);
}

/** /kids: go to the first kid, or show the first-run screen. */
export function KidsIndex() {
  const { api } = useApp();
  const kids = useLoad(() => api.kids(), []);
  if (!kids.data) {
    return (
      <>
        <PageHead title="Kids and rules" />
        {kids.error ? <ErrorBox message={kids.error} onRetry={() => void kids.reload()} /> : <Loading label="Loading kids" />}
      </>
    );
  }
  const first = kids.data.kids[0];
  return first ? <Navigate to={`/kids/${first.id}`} replace /> : <FirstRun />;
}

function ColorPicker({ value, onChange, name }: { value: string; onChange: (c: string) => void; name: string }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Colour">
      {KID_COLORS.map((c, i) => (
        <button key={c} type="button" role="radio" aria-checked={value.toLowerCase() === c} aria-label={`Colour ${i + 1}`}
          className="swatch" style={{ background: c, color: textOn(c) }} onClick={() => onChange(c)}>
          {(name.trim()[0] ?? '').toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function NewKidPage() {
  const { api, run } = useApp();
  const navigate = useNavigate();
  const kids = useLoad(() => api.kids(), []);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = kids.data?.kids.length ?? 0;
  const chosen = color ?? KID_COLORS[count % KID_COLORS.length] ?? KID_COLORS[0];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) { setError('Please type the kid\'s name.'); return; }
    setError(null);
    setBusy(true);
    const before = new Set(kids.data?.kids.map((k) => k.id) ?? []);
    const ok = await run(() => api.createKid({ name: clean, color: chosen }), `${clean} was added.`);
    if (ok) {
      // The spec does not fix the response of POST /api/kids, so find the new kid in the list.
      let created: Kid | undefined;
      try { created = (await api.kids()).kids.find((k) => !before.has(k.id)); } catch { created = undefined; }
      navigate(count === 0 ? '/devices?add=1' : created ? `/kids/${created.id}` : '/kids');
    }
    setBusy(false);
  }

  return (
    <>
      <PageHead title="Add a kid" sub="Each kid gets their own daily time, bedtime and allowed apps." />
      <Card className="first-run">
        <form className="stack-lg" onSubmit={(e) => void submit(e)} noValidate>
          <div className="field">
            <label htmlFor="kid-name">Kid's name</label>
            <input id="kid-name" className="input" value={name} maxLength={40} autoComplete="off" autoFocus
              aria-invalid={error ? true : undefined} aria-describedby={error ? 'kid-name-err' : undefined}
              onChange={(e) => setName(e.target.value)} />
            {error && <div id="kid-name-err" className="hint-error" role="alert">{error}</div>}
          </div>
          <div className="field">
            <span className="label">Colour on charts</span>
            <ColorPicker value={chosen} onChange={setColor} name={name} />
          </div>
          <p className="small muted">New kids start with 2 hours on school days, 3 hours on weekends and bedtime on. You can change everything afterwards.</p>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add kid'}</button>
            <Link to={count ? '/kids' : '/'} className="btn btn-ghost">Cancel</Link>
          </div>
        </form>
      </Card>
    </>
  );
}

export function KidPage() {
  const { id = '' } = useParams();
  const { api, run } = useApp();
  const detail = useLoad(() => api.kid(id), [id]);
  const kids = useLoad(() => api.kids(), [id]);
  const devices = useLoad(() => api.devices(), [id]);
  const [busy, setBusy] = useState<string | null>(null);

  async function save(key: string, action: () => Promise<unknown>, okText: string): Promise<boolean> {
    setBusy(key);
    const ok = await run(action, okText);
    await detail.reload();
    setBusy(null);
    return ok;
  }

  const d = detail.data;
  const kidList = kids.data?.kids ?? [];

  if (!d) {
    return (
      <>
        <PageHead title="Kids and rules" />
        {detail.error ? (
          <>
            <ErrorBox message={detail.error} onRetry={() => void detail.reload()} />
            <p><Link to="/kids">Back to kids</Link></p>
          </>
        ) : <Loading label="Loading rules" />}
      </>
    );
  }

  const kid = d.kid;
  const mine = (devices.data?.devices ?? []).filter((x) => x.kidId === kid.id).map((x) => x.name);
  const sub = mine.length
    ? `Apply to ${joinList(mine)} and any device you add for ${kid.name}`
    : `Apply to every device you add for ${kid.name}`;

  return (
    <>
      <PageHead title={`${possessive(kid.name)} rules`} sub={sub}>
        <nav className="tabs" aria-label="Kid">
          {kidList.map((k) => {
            const on = k.id === kid.id;
            const bg = safeColor(k.color);
            return (
              <Link key={k.id} to={`/kids/${k.id}`} className={`tab${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}
                style={on ? { background: bg, color: textOn(bg) } : undefined}>{k.name}</Link>
            );
          })}
          <Link to="/kids/new" className="tab">Add a kid</Link>
        </nav>
      </PageHead>
      <KidSections kidId={kid.id} current="rules" />

      <div className="grid-300">
        <DailyTimeCard d={d} busy={busy} onSave={(patch, text) => void save('time', () => api.updateKid(kid.id, patch), text)} />
        <BedtimeCard key={`${kid.id}-${kid.bedSchoolStart}-${kid.bedSchoolEnd}-${kid.bedOtherStart}-${kid.bedOtherEnd}`}
          kid={kid} busy={busy} onSave={(patch, text) => save('bed', () => api.updateKid(kid.id, patch), text)} />
      </div>

      <AppsCard d={d} busy={busy} save={save} />

      <div className="grid-260">
        <Card title="Safe browsing">
          <SafeSwitches kid={kid} onSaved={detail.reload} />
        </Card>
        <ContactsCard d={d} busy={busy} save={save} />
      </div>

      <KidDetailsCard key={`${kid.id}-${kid.name}-${kid.color}`} kid={kid} busy={busy} save={save} />
    </>
  );
}

type SaveFn = (key: string, action: () => Promise<unknown>, okText: string) => Promise<boolean>;

function DailyTimeCard({ d, busy, onSave }: { d: KidDetail; busy: string | null; onSave: (p: KidPatch, okText: string) => void }) {
  const { kid, today } = d;
  const a = useId(), b = useId();
  return (
    <Card title="Daily time">
      <div className="row" style={{ gap: 22 }}>
        <div className="row"><span className="mid-num">{formatMinutes(kid.limitSchoolMinutes)}</span><span className="pill pill-peri">School days</span></div>
        <div className="row"><span className="mid-num">{formatMinutes(kid.limitWeekendMinutes)}</span><span className="pill pill-green">Weekends</span></div>
      </div>
      <div className="row-between">
        <label htmlFor={a}>School days</label>
        <select id={a} className="select w-180" value={kid.limitSchoolMinutes} disabled={busy === 'time'}
          onChange={(e) => onSave({ limitSchoolMinutes: Number(e.target.value) }, `School days: ${formatMinutes(Number(e.target.value))} a day.`)}>
          {withCurrent(DAY_LIMITS, kid.limitSchoolMinutes).map((m) => <option key={m} value={m}>{formatLimitOption(m)}</option>)}
        </select>
      </div>
      <div className="row-between">
        <label htmlFor={b}>Weekends</label>
        <select id={b} className="select w-180" value={kid.limitWeekendMinutes} disabled={busy === 'time'}
          onChange={(e) => onSave({ limitWeekendMinutes: Number(e.target.value) }, `Weekends: ${formatMinutes(Number(e.target.value))} a day.`)}>
          {withCurrent(DAY_LIMITS, kid.limitWeekendMinutes).map((m) => <option key={m} value={m}>{formatLimitOption(m)}</option>)}
        </select>
      </div>
      <p className="small">Today: {formatMinutes(today.usedMinutes)} used of {formatMinutes(today.limitMinutes)}, {formatMinutes(today.leftMinutes)} left.</p>
      <p className="small muted">Time only counts while an app or website is open. The home screen and family calls are free.</p>
    </Card>
  );
}

function BedtimeCard({ kid, busy, onSave }: { kid: Kid; busy: string | null; onSave: (p: KidPatch, okText: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState({
    bedSchoolStart: kid.bedSchoolStart, bedSchoolEnd: kid.bedSchoolEnd, bedOtherStart: kid.bedOtherStart, bedOtherEnd: kid.bedOtherEnd,
  });
  const dirty = (Object.keys(draft) as (keyof typeof draft)[]).some((k) => draft[k] !== kid[k]);
  const valid = Object.values(draft).every((v) => /^\d{2}:\d{2}$/.test(v));
  const ids = { ss: useId(), se: useId(), os: useId(), oe: useId() };

  const timeInput = (key: keyof typeof draft, id: string, label: string) => (
    <>
      <label htmlFor={id} className="sr-only">{label}</label>
      <input id={id} type="time" className="input w-auto" value={draft[key]} disabled={busy === 'bed'}
        onChange={(e) => setDraft((x) => ({ ...x, [key]: e.target.value }))} />
    </>
  );

  return (
    <Card title="Bedtime" action={(
      <Switch checked={kid.bedtimeEnabled} disabled={busy === 'bed'} label={`Bedtime for ${kid.name}`}
        onChange={(v) => void onSave({ bedtimeEnabled: v }, `Bedtime is ${v ? 'on' : 'off'} for ${kid.name}.`)} />
    )}>
      <div className="row" style={{ gap: 22, opacity: kid.bedtimeEnabled ? 1 : 0.6 }}>
        <div className="row"><span className="mid-num">{formatClockShort(kid.bedSchoolStart)}</span><span className="pill pill-peri">School nights</span></div>
        <div className="row"><span className="mid-num">{formatClockShort(kid.bedOtherStart)}</span><span className="pill pill-deep">Other nights</span></div>
      </div>
      {!kid.bedtimeEnabled && <p className="small">Bedtime is off. The times below are kept for when you turn it on again.</p>}
      <form className="stack-lg" onSubmit={(e) => {
        e.preventDefault();
        if (dirty && valid) void onSave(draft, 'Bedtime saved.');
      }}>
        <div className="row-between" role="group" aria-label="School nights">
          <span>School nights</span>
          <span className="row" style={{ gap: 6 }}>
            {timeInput('bedSchoolStart', ids.ss, 'School nights, bedtime starts')}
            <span className="muted">to</span>
            {timeInput('bedSchoolEnd', ids.se, 'School nights, bedtime ends')}
          </span>
        </div>
        <div className="row-between" role="group" aria-label="Other nights">
          <span>Other nights</span>
          <span className="row" style={{ gap: 6 }}>
            {timeInput('bedOtherStart', ids.os, 'Other nights, bedtime starts')}
            <span className="muted">to</span>
            {timeInput('bedOtherEnd', ids.oe, 'Other nights, bedtime ends')}
          </span>
        </div>
        {dirty && (
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={!valid || busy === 'bed'}>{busy === 'bed' ? 'Saving…' : 'Save bedtime'}</button>
            <button type="button" className="btn btn-ghost" disabled={busy === 'bed'} onClick={() => setDraft({
              bedSchoolStart: kid.bedSchoolStart, bedSchoolEnd: kid.bedSchoolEnd, bedOtherStart: kid.bedOtherStart, bedOtherEnd: kid.bedOtherEnd,
            })}>Undo</button>
            {!valid && <span className="hint-error" role="alert">Please fill in all four times.</span>}
          </div>
        )}
      </form>
      <p className="small muted">School nights are Sunday to Thursday; other nights are Friday and Saturday. At bedtime the device shows a good-night screen. A parent PIN skips it for 30 minutes.</p>
    </Card>
  );
}

function whereLabel(a: Pick<KidApp, 'kind' | 'platform'>): string {
  if (a.kind === 'site') return 'Website';
  return a.platform === 'windows' ? 'PC' : a.platform === 'android' ? 'Phone' : 'Any device';
}

function limitValue(a: Pick<KidApp, 'free' | 'limitMinutes'>): string {
  return a.free ? 'free' : a.limitMinutes == null ? 'none' : String(a.limitMinutes);
}

function limitPatch(value: string): { free: boolean; limitMinutes: number | null } {
  if (value === 'free') return { free: true, limitMinutes: null };
  if (value === 'none') return { free: false, limitMinutes: null };
  return { free: false, limitMinutes: Number(value) };
}

function LimitOptions({ current }: { current: number | null }) {
  return (
    <>
      <option value="none">No own limit</option>
      <option value="free">Free, never counts</option>
      {withCurrent(APP_LIMITS, current).map((m) => <option key={m} value={m}>{formatMinutes(m)} a day</option>)}
    </>
  );
}

function AppsCard({ d, busy, save }: { d: KidDetail; busy: string | null; save: SaveFn }) {
  const { api } = useApp();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<KidApp | null>(null);
  const { kid, apps, today } = d;

  return (
    <Card title="Apps and websites" action={(
      <button type="button" className="btn btn-secondary" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
        {adding ? 'Close' : 'Add an app or site'}
      </button>
    )}>
      {adding && <AddAppForm kidId={kid.id} busy={busy === 'app-add'} save={save} onDone={() => setAdding(false)} />}
      {apps.length === 0 ? (
        <p className="empty">Nothing here yet. Add an app or website, or pair a device: the apps it finds show up here turned off, so you can allow them.</p>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Apps and websites table">
          <table className="table" style={{ minWidth: 700 }}>
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Where</th><th scope="col">Limit</th><th scope="col">Today</th><th scope="col" className="right">Allowed</th><th scope="col"><span className="sr-only">Remove</span></th></tr>
            </thead>
            <tbody>
              {apps.map((a) => {
                const rowBusy = busy === `app-${a.id}`;
                const cap = a.limitMinutes ?? today.limitMinutes;
                const todayText = a.allowed ? formatMinutes(a.usedMinutes) : 'Blocked';
                return (
                  <tr key={a.id}>
                    <th scope="row" className="strong" style={{ textAlign: 'left', fontSize: 14, color: 'var(--text)', padding: '8px 12px 8px 0', borderTop: '1px solid var(--line)' }}>
                      <div style={{ overflowWrap: 'anywhere' }}>{a.name}</div>
                      {a.name !== a.identifier && <div className="tiny muted" style={{ fontWeight: 400, overflowWrap: 'anywhere' }}>{a.identifier}</div>}
                    </th>
                    <td className="muted">{whereLabel(a)}</td>
                    <td>
                      <select className="select w-auto" aria-label={`Limit for ${a.name}`} value={limitValue(a)} disabled={rowBusy || !a.allowed}
                        onChange={(e) => void save(`app-${a.id}`, () => api.updateApp(a.id, limitPatch(e.target.value)), `${a.name}: limit saved.`)}>
                        <LimitOptions current={a.limitMinutes} />
                      </select>
                      {kid.youtubeRestricted && /youtube/i.test(a.identifier) && a.kind === 'site' && <div className="tiny muted">Restricted Mode</div>}
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <Progress thin used={a.allowed ? a.usedMinutes : 0} limit={cap} label={`${a.name} today: ${todayText}`} />
                        <span className="muted" style={{ whiteSpace: 'nowrap' }}>{todayText}</span>
                      </div>
                    </td>
                    <td className="right">
                      <Switch checked={a.allowed} disabled={rowBusy} label={`Allow ${a.name}`}
                        onChange={(v) => void save(`app-${a.id}`, () => api.updateApp(a.id, { allowed: v }), `${a.name} is ${v ? 'allowed' : 'blocked'}.`)} />
                    </td>
                    <td className="right">
                      <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove ${a.name}`} disabled={rowBusy} onClick={() => setRemoving(a)}>
                        <Icon d={ICON.trash} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Confirm open={removing !== null} title={`Remove ${removing?.name ?? ''}?`} confirmLabel="Remove" danger
        busy={removing !== null && busy === `app-${removing.id}`}
        body={`It comes off ${possessive(kid.name)} list. If a device finds it again, it comes back turned off.`}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          const a = removing;
          void save(`app-${a.id}`, () => api.deleteApp(a.id), `${a.name} was removed.`).then(() => setRemoving(null));
        }} />
    </Card>
  );
}

/** "https://www.Example.org/path" -> "example.org" */
function cleanHost(input: string): string {
  return input.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
}

function AddAppForm({ kidId, busy, save, onDone }: { kidId: string; busy: boolean; save: SaveFn; onDone: () => void }) {
  const { api } = useApp();
  const [kind, setKind] = useState<'app' | 'site'>('site');
  const [platform, setPlatform] = useState<AppPlatform>('windows');
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [limit, setLimit] = useState('none');
  const [error, setError] = useState<string | null>(null);
  const ids = { kind: useId(), platform: useId(), name: useId(), ident: useId(), limit: useId(), err: useId() };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ident = kind === 'site' ? cleanHost(identifier) : identifier.trim();
    if (!ident) { setError(kind === 'site' ? 'Please type the website address, like khanacademy.org.' : 'Please type the program or package name.'); return; }
    if (kind === 'site' && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ident)) { setError('That does not look like a website address. Try something like khanacademy.org.'); return; }
    setError(null);
    const body: NewApp = {
      kind, identifier: ident, name: name.trim() || ident, allowed: true,
      platform: kind === 'site' ? 'any' : platform, ...limitPatch(limit),
    };
    if (await save('app-add', () => api.createApp(kidId, body), `${body.name} was added and allowed.`)) onDone();
  }

  return (
    <form className="inset stack-lg" onSubmit={(e) => void submit(e)} noValidate aria-label="Add an app or site">
      <div className="form-grid">
        <div className="field">
          <label htmlFor={ids.kind}>What is it?</label>
          <select id={ids.kind} className="select" value={kind} onChange={(e) => setKind(e.target.value === 'app' ? 'app' : 'site')}>
            <option value="site">Website</option>
            <option value="app">App</option>
          </select>
        </div>
        {kind === 'app' && (
          <div className="field">
            <label htmlFor={ids.platform}>Device</label>
            <select id={ids.platform} className="select" value={platform} onChange={(e) => setPlatform(e.target.value === 'android' ? 'android' : 'windows')}>
              <option value="windows">Windows PC</option>
              <option value="android">Android phone</option>
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor={ids.ident}>{kind === 'site' ? 'Website address' : platform === 'windows' ? 'Program file name' : 'Android package name'}</label>
          <input id={ids.ident} className="input" value={identifier} autoComplete="off" autoCapitalize="none" spellCheck={false}
            placeholder={kind === 'site' ? 'khanacademy.org' : platform === 'windows' ? 'minecraft.exe' : 'com.example.app'}
            aria-invalid={error ? true : undefined} aria-describedby={error ? ids.err : undefined}
            onChange={(e) => setIdentifier(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.name}>Name to show (optional)</label>
          <input id={ids.name} className="input" value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.limit}>Limit</label>
          <select id={ids.limit} className="select" value={limit} onChange={(e) => setLimit(e.target.value)}>
            <LimitOptions current={null} />
          </select>
        </div>
      </div>
      {error && <div id={ids.err} className="hint-error" role="alert">{error}</div>}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add and allow'}</button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function contactAbility(c: Pick<Contact, 'canCall' | 'canText'>): string {
  if (c.canCall && c.canText) return 'Call and text';
  if (c.canCall) return 'Call only';
  if (c.canText) return 'Text only';
  return 'No calls or texts';
}

function ContactsCard({ d, busy, save }: { d: KidDetail; busy: string | null; save: SaveFn }) {
  const { api } = useApp();
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [removing, setRemoving] = useState<Contact | null>(null);
  const { kid, contacts } = d;

  return (
    <Card title="Phone: family contacts">
      <p className="small muted">These people can be called or texted from the phone. Who can still be reached when the phone is locked is set under <Link to={`/kids/${kid.id}/phone`}>Phone and chores</Link>. Emergency calls always work.</p>
      {contacts.length === 0 && editing === null && <p className="empty">No family contacts yet.</p>}
      {contacts.map((c) => (editing !== 'new' && editing?.id === c.id ? (
        <ContactForm key={c.id} initial={c} busy={busy === 'contact'} onCancel={() => setEditing(null)}
          onSubmit={async (v) => { if (await save('contact', () => api.updateContact(c.id, v), `${v.name} was saved.`)) setEditing(null); }} />
      ) : (
        <div key={c.id} className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
          <div className="grow">
            <div style={{ overflowWrap: 'anywhere' }}>{c.name}</div>
            <div className="tiny muted">{c.phone} · {contactAbility(c)}</div>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Icon d={ICON.edit} /></button>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove ${c.name}`} onClick={() => setRemoving(c)}><Icon d={ICON.trash} /></button>
        </div>
      )))}
      {editing === 'new' ? (
        <ContactForm busy={busy === 'contact'} onCancel={() => setEditing(null)}
          onSubmit={async (v) => { if (await save('contact', () => api.createContact(kid.id, v), `${v.name} was added.`)) setEditing(null); }} />
      ) : (
        <button type="button" className="btn btn-ghost" onClick={() => setEditing('new')}>Add a contact</button>
      )}
      <Confirm open={removing !== null} title={`Remove ${removing?.name ?? ''}?`} confirmLabel="Remove" danger busy={busy === 'contact'}
        body={`${kid.name} will no longer be able to call or text this person when the phone is locked.`}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          const c = removing;
          void save('contact', () => api.deleteContact(c.id), `${c.name} was removed.`).then(() => setRemoving(null));
        }} />
    </Card>
  );
}

function ContactForm({ initial, busy, onSubmit, onCancel }: {
  initial?: Contact; busy: boolean; onSubmit: (v: ContactInput) => void | Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [canCall, setCanCall] = useState(initial?.canCall ?? true);
  const [canText, setCanText] = useState(initial?.canText ?? true);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), phone: useId(), err: useId() };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !phone.trim()) { setError('Please fill in a name and a phone number.'); return; }
    if (!/\d/.test(phone)) { setError('The phone number needs digits.'); return; }
    setError(null);
    void onSubmit({ name: name.trim(), phone: phone.trim(), canCall, canText });
  }

  return (
    <form className="inset stack" onSubmit={submit} noValidate aria-label={initial ? `Edit ${initial.name}` : 'Add a contact'}>
      <div className="field">
        <label htmlFor={ids.name}>Name</label>
        <input id={ids.name} className="input" value={name} maxLength={40} autoComplete="off" autoFocus onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.phone}>Phone number</label>
        <input id={ids.phone} className="input" type="tel" value={phone} maxLength={30} autoComplete="off" onChange={(e) => setPhone(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 18 }}>
        <label className="check"><input type="checkbox" checked={canCall} onChange={(e) => setCanCall(e.target.checked)} />Can call</label>
        <label className="check"><input type="checkbox" checked={canText} onChange={(e) => setCanText(e.target.checked)} />Can text</label>
      </div>
      {error && <div id={ids.err} className="hint-error" role="alert">{error}</div>}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save contact'}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function KidDetailsCard({ kid, busy, save }: { kid: Kid; busy: string | null; save: SaveFn }) {
  const { api, run } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState(kid.name);
  const [color, setColor] = useState(kid.color);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const nameId = useId();
  const dirty = name.trim() !== kid.name || color.toLowerCase() !== kid.color.toLowerCase();

  useEffect(() => { setName(kid.name); setColor(kid.color); }, [kid.name, kid.color]);

  async function remove() {
    setDeleting(true);
    const ok = await run(() => api.deleteKid(kid.id), `${kid.name} was removed.`);
    setDeleting(false);
    setConfirm(false);
    if (ok) navigate('/kids');
  }

  return (
    <Card title="Name and colour">
      <form className="stack-lg" onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && dirty) void save('details', () => api.updateKid(kid.id, { name: name.trim(), color }), 'Name and colour saved.');
      }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor={nameId}>Name</label>
            <input id={nameId} className="input" value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <span className="label">Colour on charts</span>
            <ColorPicker value={color} onChange={setColor} name={name} />
          </div>
        </div>
        <div className="row-between">
          <button type="submit" className="btn btn-primary" disabled={!dirty || !name.trim() || busy === 'details'}>
            {busy === 'details' ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)}>Remove {kid.name}</button>
        </div>
      </form>
      <Confirm open={confirm} title={`Remove ${kid.name}?`} confirmLabel={`Remove ${kid.name}`} danger busy={deleting}
        body={`This deletes ${possessive(kid.name)} rules, contacts and history. It cannot be undone. To keep a device, move it to another kid first on the Devices page.`}
        onConfirm={() => void remove()} onCancel={() => setConfirm(false)} />
    </Card>
  );
}
