import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import type { Chore, ChoreInput, ChoreRepeat, KidPhone, LauncherTheme, PhoneRules, TimeCode } from '../api/types';
import { KidSections, KidTabs } from '../components/KidNav';
import { Card, Confirm, ErrorBox, ICON, Icon, Loading, PageHead, Switch } from '../components/ui';
import { textOn } from '../lib/color';
import { plural, possessive, timeAgo } from '../lib/format';

type SaveFn = (key: string, action: () => Promise<unknown>, okText: string) => Promise<boolean>;

const CHORE_MINUTES = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
const REPEAT_LABEL: Record<ChoreRepeat, string> = { once: 'One time', daily: 'Every day', weekly: 'Every week' };
const TODAY_LABEL: Record<Chore['today'], { text: string; cls: string }> = {
  todo: { text: 'To do', cls: 'pill-off' },
  waiting: { text: 'Waiting for you', cls: 'pill-warn' },
  done: { text: 'Done', cls: 'pill-deep' },
  hidden: { text: 'Finished', cls: 'pill-off' },
};
/** The four colours of the kid's launcher. The names are the ones the app and the server use. */
const THEMES: { value: LauncherTheme; label: string; color: string }[] = [
  { value: 'galaxy', label: 'Green', color: '#34d399' },
  { value: 'ocean', label: 'Periwinkle', color: '#6f82de' },
  { value: 'jungle', label: 'Teal', color: '#2dd4bf' },
  { value: 'sunset', label: 'Coral', color: '#fb7185' },
];

/** /kids/:id/phone: what the kid's Android phone adds to the rules, and chores for extra time. */
export function KidPhonePage() {
  const { id = '' } = useParams();
  const { api, run } = useApp();
  const detail = useLoad(() => api.kid(id), [id]);
  const kids = useLoad(() => api.kids(), [id]);
  const phone = useLoad(() => api.kidPhone(id), [id], 30000);
  const chores = useLoad(() => api.chores(id), [id], 30000);
  const [busy, setBusy] = useState<string | null>(null);

  const save: SaveFn = async (key, action, okText) => {
    setBusy(key);
    const ok = await run(action, okText);
    await Promise.all([phone.reload(), chores.reload()]);
    setBusy(null);
    return ok;
  };

  const kid = detail.data?.kid;
  const p = phone.data;
  const error = detail.error ?? phone.error ?? chores.error;

  if (!kid || !p || !chores.data) {
    return (
      <>
        <PageHead title="Phone and chores" />
        {error ? (
          <>
            <ErrorBox message={error} onRetry={() => { void detail.reload(); void phone.reload(); void chores.reload(); }} />
            <p><Link to="/kids">Back to kids</Link></p>
          </>
        ) : <Loading label="Loading the phone settings" />}
      </>
    );
  }

  return (
    <>
      <PageHead title={`${possessive(kid.name)} phone and chores`} sub={p.phones.length ? `Applies to ${p.phones.map((d) => d.name).join(', ')}` : `${kid.name} has no Android phone yet. These settings apply as soon as you add one.`}>
        <KidTabs kids={kids.data?.kids ?? []} currentId={kid.id} section="phone" />
      </PageHead>
      <KidSections kidId={kid.id} current="phone" />

      <ChoresCard kidId={kid.id} kidName={kid.name} chores={chores.data.chores} busy={busy} save={save} />

      <div className="grid-300">
        <PhonesCard kidName={kid.name} phone={p} />
        <TimeCodeCard kidId={kid.id} kidName={kid.name} codes={p.timeCodes} onChanged={phone.reload} />
      </div>

      <div className="grid-300">
        <PhoneRulesCard key={JSON.stringify(p.rules)} kidId={kid.id} kidName={kid.name} rules={p.rules} busy={busy} save={save} />
        <div className="stack-lg">
          <LookCard kidId={kid.id} kidName={kid.name} phone={p} busy={busy} save={save} />
          <ContactRulesCard kidId={kid.id} kidName={kid.name} phone={p} busy={busy} save={save} />
        </div>
      </div>

      <Card title="Texts, photos and videos">
        <p className="small muted">Copies of what {kid.name} writes, takes and makes on the phone, for you to look at.</p>
        <div className="row-between" style={{ justifyContent: 'flex-start' }}>
          <Link to={`/kids/${kid.id}/texts`} className="btn btn-ghost">Read {possessive(kid.name)} texts</Link>
          <Link to={`/kids/${kid.id}/photos`} className="btn btn-ghost">See {possessive(kid.name)} photos and videos</Link>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- chores

function ChoresCard({ kidId, kidName, chores, busy, save }: { kidId: string; kidName: string; chores: Chore[]; busy: string | null; save: SaveFn }) {
  const { api } = useApp();
  const [editing, setEditing] = useState<Chore | 'new' | null>(null);
  const [removing, setRemoving] = useState<Chore | null>(null);

  return (
    <Card title="Chores for extra time" action={(
      <button type="button" className="btn btn-secondary" aria-expanded={editing === 'new'} onClick={() => setEditing((v) => (v === 'new' ? null : 'new'))}>
        {editing === 'new' ? 'Close' : 'Add a chore'}
      </button>
    )}>
      <p className="small muted">{kidName} sees these on the home screen and taps one when it is done. You say yes or not yet on the dashboard or under <Link to="/requests">Requests</Link>. Yes adds the minutes to that day's time.</p>
      {editing === 'new' && (
        <ChoreForm busy={busy === 'chore'} onCancel={() => setEditing(null)}
          onSubmit={async (v) => { if (await save('chore', () => api.createChore(kidId, v), `Chore added: ${v.name}.`)) setEditing(null); }} />
      )}
      {chores.length === 0 && editing !== 'new' && <p className="empty">No chores yet. Add one, for example "Empty the dishwasher" for 15 minutes.</p>}
      {chores.map((c) => (editing !== 'new' && editing?.id === c.id ? (
        <ChoreForm key={c.id} initial={c} busy={busy === 'chore'} onCancel={() => setEditing(null)}
          onSubmit={async (v) => { if (await save('chore', () => api.updateChore(c.id, v), `Chore saved: ${v.name}.`)) setEditing(null); }} />
      ) : (
        <div key={c.id} className="inset chore-row" style={{ opacity: c.active ? 1 : 0.65 }}>
          <div className="grow">
            <div style={{ fontSize: 15, overflowWrap: 'anywhere' }}>{c.name}</div>
            <div className="tiny muted">{c.minutes > 0 ? `${plural(c.minutes, 'minute', 'minutes')} of extra time` : 'No extra time'} · {REPEAT_LABEL[c.repeat]}</div>
          </div>
          {c.active
            ? <span className={`pill ${TODAY_LABEL[c.today].cls}`}>{TODAY_LABEL[c.today].text}</span>
            : <span className="pill pill-off">Switched off</span>}
          <Switch checked={c.active} disabled={busy === `chore-${c.id}`} label={`Show "${c.name}" to ${kidName}`}
            onChange={(v) => void save(`chore-${c.id}`, () => api.updateChore(c.id, { active: v }), v ? `${kidName} can see "${c.name}" again.` : `"${c.name}" is switched off.`)} />
          <button type="button" className="btn btn-ghost btn-icon" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Icon d={ICON.edit} /></button>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove ${c.name}`} onClick={() => setRemoving(c)}><Icon d={ICON.trash} /></button>
        </div>
      )))}
      <Confirm open={removing !== null} title={`Remove "${removing?.name ?? ''}"?`} confirmLabel="Remove chore" danger busy={busy === 'chore'}
        body={`The chore comes off ${possessive(kidName)} list. Time already earned with it stays.`}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          const c = removing;
          void save('chore', () => api.deleteChore(c.id), `"${c.name}" was removed.`).then(() => setRemoving(null));
        }} />
    </Card>
  );
}

function ChoreForm({ initial, busy, onSubmit, onCancel }: { initial?: Chore; busy: boolean; onSubmit: (v: ChoreInput) => void | Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [minutes, setMinutes] = useState(initial?.minutes ?? 15);
  const [repeat, setRepeat] = useState<ChoreRepeat>(initial?.repeat ?? 'daily');
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), min: useId(), rep: useId(), err: useId() };
  const options = CHORE_MINUTES.includes(minutes) ? CHORE_MINUTES : [...CHORE_MINUTES, minutes].sort((a, b) => a - b);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Please type what the chore is.'); return; }
    setError(null);
    void onSubmit({ name: name.trim(), minutes, repeat });
  }

  return (
    <form className="inset stack-lg" onSubmit={submit} noValidate aria-label={initial ? `Edit ${initial.name}` : 'Add a chore'}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={ids.name}>Chore</label>
          <input id={ids.name} className="input" value={name} maxLength={80} autoComplete="off" autoFocus placeholder="Empty the dishwasher"
            aria-invalid={error ? true : undefined} aria-describedby={error ? ids.err : undefined} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.min}>Extra time when you say yes</label>
          <select id={ids.min} className="select" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {options.map((m) => <option key={m} value={m}>{m === 0 ? 'None' : plural(m, 'minute', 'minutes')}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.rep}>How often</label>
          <select id={ids.rep} className="select" value={repeat} onChange={(e) => setRepeat(e.target.value as ChoreRepeat)}>
            <option value="daily">Every day</option>
            <option value="weekly">Every week (once, Monday to Sunday)</option>
            <option value="once">One time</option>
          </select>
        </div>
      </div>
      {error && <div id={ids.err} className="hint-error" role="alert">{error}</div>}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save chore'}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the phones, bonus time

function PhonesCard({ kidName, phone }: { kidName: string; phone: KidPhone }) {
  return (
    <Card title="Phone" action={<Link to="/devices?add=phone" className="small">Add a phone</Link>}>
      {phone.phones.length === 0 && <p className="empty">{kidName} has no Android phone yet.</p>}
      {phone.phones.map((d) => {
        const facts = [d.model, d.osVersion, d.appVersion ? `app ${d.appVersion}` : null].filter(Boolean).join(' · ');
        const warn: string[] = [];
        if (d.deviceOwner === false) warn.push('Quick install: the app counts time but cannot lock the phone down. For full lock-down, set the phone up with the setup QR code after a factory reset.');
        if (d.usageAccess === false) warn.push('Usage access is off on the phone, so time only counts for apps opened from the home screen. Turn it on in the phone\'s setup screen.');
        return (
          <div key={d.id} className="stack" style={{ gap: 6 }}>
            <div className="row-between">
              <div className="grow">
                <div style={{ fontSize: 15, fontWeight: 500, overflowWrap: 'anywhere' }}>{d.name}</div>
                <div className="tiny muted">{facts || 'Android phone'}</div>
              </div>
              {d.battery != null && <span className="pill pill-off">Battery {d.battery}%{d.charging ? ', charging' : ''}</span>}
            </div>
            <div className="small muted">{d.lastSeenAt ? `Last seen ${timeAgo(d.lastSeenAt)}` : 'Not seen yet'}</div>
            {warn.map((w) => <div key={w} className="banner banner-warn small">{w}</div>)}
          </div>
        );
      })}
      <p className="small muted">An emergency code for a locked phone is on the <Link to="/devices">Devices</Link> page.</p>
    </Card>
  );
}

function TimeCodeCard({ kidId, kidName, codes, onChanged }: { kidId: string; kidName: string; codes: TimeCode[]; onChanged: () => Promise<void> }) {
  const { api, run } = useApp();
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  const sel = useId();

  async function make(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await run(() => api.timeCode(kidId, minutes), `A ${minutes}-minute code for ${kidName} is ready.`);
    await onChanged();
    setBusy(false);
  }

  return (
    <Card title="Bonus time codes">
      <p className="small muted">A code {kidName} types on the device ("I have a code") to get extra time today. Handy as a reward, or when you are not near the console. Each code works once and lasts 24 hours.</p>
      <form className="row" onSubmit={(e) => void make(e)}>
        <label htmlFor={sel} className="sr-only">Minutes</label>
        <select id={sel} className="select w-180" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
        </select>
        <button type="submit" className="btn btn-secondary" disabled={busy}>{busy ? 'Making…' : 'Make a code'}</button>
      </form>
      {codes.length === 0 ? <p className="empty">No unused codes.</p> : (
        <ul className="plain-list" aria-label="Unused codes">
          {codes.map((c) => (
            <li key={c.code}>
              <span className="code code-small" aria-label={`Code ${c.code.split('').join(' ')}`}>{c.code}</span>
              <span className="small muted">{c.minutes} minutes, unused</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- phone rules

const LOCKS: { key: keyof Omit<PhoneRules, 'emergencyNumber' | 'playMinutes'>; label: string; help: string }[] = [
  { key: 'blockSettings', label: 'Phone settings', help: 'Opens only from the Grown-up menu, for 15 minutes.' },
  { key: 'blockReset', label: 'Factory reset', help: 'The phone cannot be erased from its settings.' },
  { key: 'blockSafeBoot', label: 'Safe mode', help: 'The phone cannot be started without the app.' },
  { key: 'blockInstalls', label: 'Installing apps', help: 'Only from the Grown-up menu or sent from this console.' },
  { key: 'blockAccounts', label: 'Adding accounts', help: 'No new Google or other accounts.' },
  { key: 'blockUsb', label: 'USB file transfer and debugging', help: 'A computer cannot reach into the phone.' },
];

function PhoneRulesCard({ kidId, kidName, rules, busy, save }: { kidId: string; kidName: string; rules: PhoneRules; busy: string | null; save: SaveFn }) {
  const { api } = useApp();
  const [emergency, setEmergency] = useState(rules.emergencyNumber);
  const [error, setError] = useState<string | null>(null);
  const ids = { em: useId(), play: useId(), err: useId() };
  const saving = busy === 'rules';
  const put = (next: PhoneRules, okText: string) => save('rules', () => api.savePhoneRules(kidId, next), okText);

  function saveEmergency(e: FormEvent) {
    e.preventDefault();
    if (!/^[0-9]{2,6}$/.test(emergency)) { setError('Use the emergency number, 2 to 6 digits, like 911 or 112.'); return; }
    setError(null);
    void put({ ...rules, emergencyNumber: emergency }, `Emergency number set to ${emergency}.`);
  }

  return (
    <Card title="Phone lock-downs">
      <p className="small muted">What {kidName} cannot do on the phone. These work on phones set up with the setup QR code.</p>
      {LOCKS.map((l) => (
        <div key={l.key} className="row-between" style={{ flexWrap: 'nowrap' }}>
          <div className="grow">
            <div>{l.label}</div>
            <div className="tiny muted">{l.help}</div>
          </div>
          <Switch checked={rules[l.key]} disabled={saving} label={`Block: ${l.label}`}
            onChange={(v) => void put({ ...rules, [l.key]: v }, `${l.label}: ${v ? 'blocked' : 'allowed'}.`)} />
        </div>
      ))}
      <div className="row-between">
        <label htmlFor={ids.play}>Play Store stays open for</label>
        <select id={ids.play} className="select w-180" value={rules.playMinutes} disabled={saving}
          onChange={(e) => void put({ ...rules, playMinutes: Number(e.target.value) }, `The Play Store stays open for ${e.target.value} minutes.`)}>
          {[...new Set([5, 10, 15, 20, 30, 45, 60, rules.playMinutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m} minutes</option>)}
        </select>
      </div>
      <p className="tiny muted">A parent opens the Play Store on the phone with the parent PIN. Whatever is installed in that time is allowed.</p>
      <form className="row-between" onSubmit={saveEmergency} noValidate>
        <label htmlFor={ids.em}>Emergency number</label>
        <span className="row" style={{ gap: 8 }}>
          <input id={ids.em} className="input w-90" inputMode="numeric" value={emergency} maxLength={6} autoComplete="off"
            aria-invalid={error ? true : undefined} aria-describedby={error ? ids.err : undefined}
            onChange={(e) => setEmergency(e.target.value.replace(/\D/g, ''))} />
          <button type="submit" className="btn btn-ghost" disabled={saving || emergency === rules.emergencyNumber}>Save</button>
        </span>
      </form>
      {error && <div id={ids.err} className="hint-error" role="alert">{error}</div>}
      <p className="tiny muted">The emergency number can always be called, also when the phone is locked.</p>
    </Card>
  );
}

// ---------------------------------------------------------------- launcher colours

function LookCard({ kidId, kidName, phone, busy, save }: { kidId: string; kidName: string; phone: KidPhone; busy: string | null; save: SaveFn }) {
  const { api } = useApp();
  const look = phone.launcher;
  const saving = busy === 'look';
  return (
    <Card title="Home screen colours" action={(
      <Switch checked={look.lookLocked} disabled={saving} label={`Lock the colours for ${kidName}`}
        onChange={(v) => void save('look', () => api.saveLauncher(kidId, { ...look, lookLocked: v }), v ? `Only you can change ${possessive(kidName)} colours now.` : `${kidName} can pick the colours again.`)} />
    )}>
      <p className="small muted">{look.lookLocked ? `Locked: ${kidName} cannot change the colours on the phone.` : `${kidName} can change the colours on the phone. Turn the switch on to lock your choice.`}</p>
      <div className="swatches" role="radiogroup" aria-label="Colour of the home screen">
        {THEMES.map((t) => (
          <button key={t.value} type="button" role="radio" aria-checked={look.theme === t.value} disabled={saving}
            className="swatch swatch-wide" style={{ background: t.color, color: textOn(t.color) }}
            onClick={() => void save('look', () => api.saveLauncher(kidId, { ...look, theme: t.value }), `Home screen colour: ${t.label.toLowerCase()}.`)}>
            {t.label}
          </button>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- who can be reached when the phone is locked

function ContactRulesCard({ kidId, kidName, phone, busy, save }: { kidId: string; kidName: string; phone: KidPhone; busy: string | null; save: SaveFn }) {
  const { api } = useApp();
  return (
    <Card title="Calls and texts" action={<Link to={`/kids/${kidId}`} className="small">Add or edit contacts</Link>}>
      <p className="small muted">
        People {kidName} can reach. With "Call" on, a contact is family: calls and texts both ways, and with "When locked" on also when time is up, at
        bedtime, or when you locked the phone. With only "Text" on, a contact is a friend: {kidName} can text and call them, but never while the phone
        is locked. Texts from anyone else are held for you under <Link to={`/kids/${kidId}/texts`}>Texts</Link>. Emergency calls always work.
      </p>
      {phone.contacts.length === 0 ? <p className="empty">No family contacts yet. Add them on the "Time, apps and websites" page.</p> : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Call and text rules table">
          <table className="table" style={{ minWidth: 420 }}>
            <thead><tr><th scope="col">Contact</th><th scope="col">Call</th><th scope="col">Text</th><th scope="col" className="right">When locked</th></tr></thead>
            <tbody>
              {phone.contacts.map((c) => {
                const rowBusy = busy === `contact-${c.id}`;
                const set = (patch: Partial<{ canCall: boolean; canText: boolean; always: boolean }>, text: string) =>
                  void save(`contact-${c.id}`, () => api.request('PATCH', `/api/contacts/${encodeURIComponent(c.id)}`, patch), text);
                return (
                  <tr key={c.id}>
                    <th scope="row" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--text)', padding: '8px 12px 8px 0', borderTop: '1px solid var(--line)' }}>
                      <div style={{ overflowWrap: 'anywhere' }}>{c.name}</div>
                      <div className="tiny muted">{c.phone}</div>
                    </th>
                    <td><Switch checked={c.canCall} disabled={rowBusy} label={`${kidName} can call ${c.name}`} onChange={(v) => set({ canCall: v }, `${c.name}: calls ${v ? 'allowed' : 'off'}.`)} /></td>
                    <td><Switch checked={c.canText} disabled={rowBusy} label={`${kidName} can text ${c.name}`} onChange={(v) => set({ canText: v }, `${c.name}: texts ${v ? 'allowed' : 'off'}.`)} /></td>
                    <td className="right"><Switch checked={c.always} disabled={rowBusy} label={`${c.name} can be reached when the phone is locked`} onChange={(v) => set({ always: v }, v ? `${c.name} can be reached when the phone is locked.` : `${c.name} cannot be reached while the phone is locked.`)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
