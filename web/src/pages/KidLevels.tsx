import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import type { KidSafety, Level, LevelId, TextingWho, WebMode, WebPatch } from '../api/types';
import { KidSections, KidTabs } from '../components/KidNav';
import { Card, Confirm, ErrorBox, Loading, PageHead, StaleNote, Switch } from '../components/ui';
import { dayShort, plural, possessive, timeAgo } from '../lib/format';
import { MODE_NAME, WHO_NAME, cleanSite, levelLines, modeHelp, toggleCategory } from '../lib/levels';

const LEVEL_PILL: Record<LevelId, string> = { little: 'pill-green', big: 'pill-peri', teen: 'pill-warn' };
const MODES: WebMode[] = ['sites', 'filtered', 'open'];
const WHO: TextingWho[] = ['family', 'friends', 'anyone'];

/**
 * /kids/:id/levels: the kid's level (Little kid, Big kid, Teen) and safe browsing. One set of website rules for
 * every phone and PC the kid has. Each change is saved at once.
 */
export function KidLevelsPage() {
  const { id = '' } = useParams();
  const { api, run } = useApp();
  const kids = useLoad(() => api.kids(), [id]);
  const safety = useLoad(() => api.kidSafety(id), [id], 30000);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Level | null>(null);
  const d = safety.data;

  useEffect(() => { setConfirm(null); }, [id]);

  async function act(action: () => Promise<unknown>, okText?: string): Promise<boolean> {
    setBusy(true);
    const ok = await run(action, okText);
    await safety.reload();
    setBusy(false);
    return ok;
  }

  if (!d) {
    return (
      <>
        <PageHead title="Levels and web" />
        {safety.error ? (
          <>
            <ErrorBox message={safety.error} onRetry={() => void safety.reload()} />
            <div><Link to="/kids" className="btn btn-ghost">Back to kids</Link></div>
          </>
        ) : <Loading label="Loading levels and website rules" />}
      </>
    );
  }

  const name = d.kid.name;
  const current = d.levels.find((l) => l.id === d.level) ?? null;
  const saveWeb = (patch: WebPatch, okText?: string) => act(() => api.saveWeb(id, patch), okText);

  return (
    <>
      <PageHead title={name} sub="Levels and web: one set of rules for every phone and PC this kid has. Changes are saved as you make them.">
        {current
          ? <span className={`pill ${LEVEL_PILL[current.id]}`}>{current.name}{d.changes.length > 0 ? ', changed' : ''}</span>
          : <span className="pill pill-off">No level picked</span>}
      </PageHead>
      {kids.data && kids.data.kids.length > 1 && <KidTabs kids={kids.data.kids} currentId={id} section="levels" />}
      <KidSections kidId={id} current="levels" />
      {safety.error && <StaleNote message={safety.error} />}

      <Card title={`How locked down should ${name} be?`}>
        <p className="small muted">
          A level sets screen time, bedtime, websites, SafeSearch and who {name} can text, all at once, on {d.devices.length > 0 ? d.devices.map((x) => x.name).join(' and ') : 'every device'}.
          You can still change any one setting afterwards. Apps, the website list and wake-up times stay the way you set them.
        </p>
        <div className="level-grid">
          {d.levels.map((l) => {
            const on = d.level === l.id;
            return (
              <section key={l.id} className={`level-card${on ? ' on' : ''}`} aria-label={`${l.name}, ${l.ages}`}>
                <div className="row-between">
                  <div>
                    <h3 className="level-name">{l.name}</h3>
                    <div className="tiny muted">{l.ages}</div>
                  </div>
                  <div className="row">
                    {d.suggested === l.id && <span className="pill pill-off">For {possessive(name)} age</span>}
                    {on && <span className={`pill ${LEVEL_PILL[l.id]}`}>In use</span>}
                  </div>
                </div>
                <ul className="notes">
                  {levelLines(l.settings, d.categories).map((t) => <li key={t}>{t}</li>)}
                </ul>
                <button type="button" className={`btn ${on ? 'btn-ghost' : 'btn-secondary'}`} disabled={busy || (on && d.changes.length === 0)} onClick={() => setConfirm(l)}>
                  {on ? (d.changes.length > 0 ? `Put everything back to ${l.name}` : 'Using this level') : `Use ${l.name}`}
                </button>
              </section>
            );
          })}
        </div>
      </Card>

      <div className="grid-300">
        <Card title={current ? `Changes from ${current.name}` : 'Changes from a level'}>
          {!current && <p className="empty">Pick a level first. Until then {possessive(name)} settings are the ones you set by hand.</p>}
          {current && d.changes.length === 0 && <p className="empty">None: everything is as {current.name} sets it.</p>}
          {current && d.changes.length > 0 && (
            <ul className="plain-list">
              {d.changes.map((c) => (
                <li key={c.key} className="setting-row">
                  <div className="grow">
                    <div>{c.label}</div>
                    <div className="tiny muted">{current.name}: {c.level}. Now: {c.now}.</div>
                  </div>
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(() => api.useLevel(id, current.id, c.key), `${c.label}: back to ${current.name}.`)}>
                    Put back<span className="sr-only">: {c.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <GrowCard key={`${id}-${d.birthday ?? ''}`} d={d} busy={busy}
          onBirthday={(b) => act(() => api.saveBirthday(id, b), b ? 'Birthday saved.' : 'Birthday removed.')}
          onTexting={(who) => act(() => api.saveTexting(id, who), `${name} can text: ${WHO_NAME[who].toLowerCase()}.`)} />
      </div>

      <Card title="Safe browsing">
        {d.devices.length > 0 ? (
          <ul className="device-chips" aria-label={`${possessive(name)} devices`}>
            {d.devices.map((x) => (
              <li key={x.id} className="inset">
                <div className="strong">{x.name}</div>
                <div className="tiny muted">
                  {x.platform === 'android' ? 'Every app on the phone, Chrome and website tiles' : 'Browsers on the PC'}. {x.lastSeenAt ? `Checked in ${timeAgo(x.lastSeenAt)}` : 'Not seen yet'}.
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="empty">No devices yet: the rules are ready for when you add one.</p>}

        <div className="seg" role="radiogroup" aria-label={`Websites ${name} can open`}>
          {MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={d.web.mode === m} className={`seg-btn${d.web.mode === m ? ' on' : ''}`} disabled={busy}
              onClick={() => { if (d.web.mode !== m) void saveWeb({ mode: m }, `Websites for ${name}: ${MODE_NAME[m].toLowerCase()}.`); }}>
              {MODE_NAME[m]}
            </button>
          ))}
        </div>
        <p className="small muted">
          {modeHelp(d.web.mode, name)}{' '}
          {d.web.mode === 'sites' && <Link to={`/kids/${id}`}>See the list of apps and websites</Link>}
        </p>

        <div>
          <SettingSwitch label="SafeSearch" help="Google, Bing and DuckDuckGo show filtered results." checked={d.settings.safeSearch} busy={busy} name={name}
            onChange={(v) => void saveWeb({ safeSearch: v }, `SafeSearch is ${v ? 'on' : 'off'} for ${name}.`)} />
          <SettingSwitch label="YouTube Restricted Mode" help="YouTube hides videos marked as mature." checked={d.settings.youTube} busy={busy} name={name}
            onChange={(v) => void saveWeb({ youTube: v }, `YouTube Restricted Mode is ${v ? 'on' : 'off'} for ${name}.`)} />
          <SettingSwitch label="Block private browsing" help="Private or incognito windows cannot be opened." checked={d.blockPrivate} busy={busy} name={name}
            onChange={(v) => void saveWeb({ blockPrivate: v }, `Block private browsing is ${v ? 'on' : 'off'} for ${name}.`)} />
        </div>

        {d.web.mode === 'filtered' && (
          <div className="stack">
            <div>
              <h3 className="label-head">Blocked kinds of sites</h3>
              <p className="tiny muted">Well-known sites of each kind. Block anything else from "Blocked today" or by name.</p>
            </div>
            <div className="check-grid">
              {d.categories.map((c) => {
                const on = d.web.categories.includes(c.id);
                return (
                  <label key={c.id} className="check">
                    <input type="checkbox" checked={on} disabled={busy}
                      onChange={() => void saveWeb({ categories: toggleCategory(d.web.categories, c.id) }, `${c.name}: ${on ? 'not blocked' : 'blocked'} for ${name}.`)} />
                    <span>{c.name} <span className="tiny muted">({plural(c.sites, 'site', 'sites')})</span></span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      <div className="grid-300">
        <SitesCard d={d} busy={busy} onRule={(host, allow, remove) => act(
          () => api.siteRule(id, host, allow, remove),
          remove ? `${host} is off the list.` : allow ? `${host} is always allowed for ${name}.` : `${host} is always blocked for ${name}.`,
        )} />

        <Card title="Blocked today">
          <p className="tiny muted">Websites that were refused in the last 24 hours, on any of {possessive(name)} devices.</p>
          {d.blockedToday.length === 0 && <p className="empty">Nothing was blocked in the last day.</p>}
          {d.blockedToday.length > 0 && (
            <ul className="plain-list">
              {d.blockedToday.map((b) => (
                <li key={b.host} className="setting-row">
                  <div className="grow">
                    <div className="host">{b.host}</div>
                    <div className="tiny muted">{[b.category, b.devices.join(', '), timeAgo(b.at)].filter(Boolean).join(' · ')}</div>
                  </div>
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(() => api.siteRule(id, b.host, true), `${b.host} is always allowed for ${name}.`)}>
                    Allow<span className="sr-only"> {b.host}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Confirm open={confirm !== null} title={confirm ? `Use ${confirm.name} for ${name}?` : ''} busy={busy}
        body={confirm ? (
          <>
            <p>This sets, on all of {possessive(name)} devices:</p>
            <ul className="notes" style={{ marginTop: 8 }}>{levelLines(confirm.settings, d.categories).map((t) => <li key={t}>{t}</li>)}</ul>
          </>
        ) : null}
        confirmLabel={confirm ? `Use ${confirm.name}` : 'Use'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const l = confirm;
          if (!l) return;
          void act(() => api.useLevel(id, l.id), `${name} is on ${l.name} on all devices.`).then(() => setConfirm(null));
        }} />
    </>
  );
}

function SettingSwitch({ label, help, checked, busy, name, onChange }: { label: string; help: string; checked: boolean; busy: boolean; name: string; onChange: (v: boolean) => void }) {
  return (
    <div className="setting-row">
      <div>
        <div>{label}</div>
        <div className="tiny muted">{help}</div>
      </div>
      <Switch checked={checked} disabled={busy} label={`${label} for ${name}`} onChange={onChange} />
    </div>
  );
}

function GrowCard({ d, busy, onBirthday, onTexting }: {
  d: KidSafety; busy: boolean; onBirthday: (b: string | null) => Promise<boolean>; onTexting: (who: TextingWho) => Promise<boolean>;
}) {
  const ids = { birthday: useId(), who: useId() };
  const [birthday, setBirthday] = useState(d.birthday ?? '');
  const name = d.kid.name;
  const today = new Date().toISOString().slice(0, 10);

  function submit(e: FormEvent) {
    e.preventDefault();
    void onBirthday(birthday || null);
  }

  return (
    <Card title={`Grow up with ${name}`}>
      <p className="small muted">Add {possessive(name)} birthday and the next level is suggested when they reach it. Nothing changes until you say so.</p>
      <form className="friend-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor={ids.birthday}>Birthday</label>
          <input id={ids.birthday} className="input" type="date" min="1990-01-01" max={today} value={birthday} onChange={(e) => setBirthday(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-ghost" disabled={busy || birthday === (d.birthday ?? '')}>Save birthday</button>
      </form>
      {d.next && <p className="small">{d.next.level.name} is suggested from {dayShort(d.next.on)}, {d.next.on.slice(0, 4)}.</p>}
      <div className="field">
        <label htmlFor={ids.who}>Who {name} can text</label>
        <select id={ids.who} className="select" value={d.settings.texting} disabled={busy} onChange={(e) => void onTexting(e.target.value as TextingWho)}>
          {WHO.map((w) => <option key={w} value={w}>{WHO_NAME[w]}</option>)}
        </select>
        <div className="tiny muted">On the phone, in its Texts app. You can read the texts on the Texts page whichever you pick.</div>
      </div>
    </Card>
  );
}

function SitesCard({ d, busy, onRule }: { d: KidSafety; busy: boolean; onRule: (host: string, allow: boolean, remove: boolean) => Promise<boolean> }) {
  const inputId = useId();
  const [site, setSite] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function add(allow: boolean) {
    const host = cleanSite(site);
    if (!host) { setError('Please type a website address, like khanacademy.org.'); return; }
    setError(null);
    if (await onRule(host, allow, false)) setSite('');
  }

  return (
    <Card title="Always allowed, always blocked">
      <div className="stack">
        <div>
          <h3 className="label-head">Always allowed ({d.web.allowed.length})</h3>
          {d.web.allowed.length === 0 && <p className="empty">No websites yet.</p>}
          <ul className="site-chips">
            {d.web.allowed.map((h) => (
              <li key={h} className="site-chip allow">
                <span className="host">{h}</span>
                <button type="button" disabled={busy} onClick={() => void onRule(h, true, true)}>Take off<span className="sr-only"> {h}</span></button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="label-head">Always blocked ({d.web.blocked.length})</h3>
          {d.web.blocked.length === 0 && <p className="empty">No websites blocked by name.</p>}
          <ul className="site-chips">
            {d.web.blocked.map((h) => (
              <li key={h} className="site-chip block">
                <span className="host">{h}</span>
                <button type="button" disabled={busy} onClick={() => void onRule(h, false, true)}>Unblock<span className="sr-only"> {h}</span></button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <form className="friend-form" noValidate onSubmit={(e) => { e.preventDefault(); void add(true); }}>
        <div className="field">
          <label htmlFor={inputId}>Website</label>
          <input id={inputId} className="input" value={site} placeholder="khanacademy.org" inputMode="url" autoCapitalize="none" autoComplete="off"
            aria-invalid={error ? true : undefined} onChange={(e) => setSite(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || !site.trim()}>Allow</button>
        <button type="button" className="btn btn-danger" disabled={busy || !site.trim()} onClick={() => void add(false)}>Block</button>
      </form>
      {error && <p className="hint-error" role="alert">{error}</p>}
    </Card>
  );
}
