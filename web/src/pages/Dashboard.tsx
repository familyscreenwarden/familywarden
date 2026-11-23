import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useLoad, useMedia } from '../app';
import type { DashKid, Dashboard, LockReason } from '../api/types';
import { HalfDonut, Lollipop, MiniLines, STATUS_COLOR, WeekChart } from '../components/charts';
import { RequestRow } from '../components/RequestRow';
import { Avatar, Card, Confirm, ErrorBox, KidPill, Loading, PageHead, Progress, StaleNote } from '../components/ui';
import { lineColor, safeColor, textOn } from '../lib/color';
import { formatClock, formatLeft, formatMinutes, plural } from '../lib/format';

const PLATFORM = { windows: 'Windows', android: 'Android' } as const;

function pillText(name: string, reason: LockReason): string {
  switch (reason) {
    case 'time': return `${name}, time is up`;
    case 'bedtime': return `${name}, bedtime`;
    case 'parent': return `${name}, locked`;
    case 'paused': return `${name}, paused`;
    default: return name;
  }
}

export function DashboardPage() {
  const { api, run } = useApp();
  const dash = useLoad(() => api.dashboard(), [], 30000);
  const [confirmPause, setConfirmPause] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const d = dash.data;

  async function act(key: string, action: () => Promise<unknown>, okText: string) {
    setBusy(key);
    await run(action, okText);
    await dash.reload();
    setBusy(null);
  }

  async function setPaused(paused: boolean) {
    await act('pause', () => api.pauseAll(paused), paused ? 'All screens are paused.' : 'Screens are running again.');
    setConfirmPause(false);
  }

  if (!d) {
    return (
      <>
        <PageHead title="Dashboard" />
        {dash.error ? <ErrorBox message={dash.error} onRetry={() => void dash.reload()} /> : <Loading label="Loading the dashboard" />}
      </>
    );
  }

  if (d.kids.length === 0) return <FirstRun />;

  const familyPct = Math.max(0, Math.min(100, Math.round(d.familyPercent)));

  return (
    <>
      <PageHead title="Dashboard">
        <span className="small" style={{ fontWeight: 600 }} id="family-time">Family time today</span>
        <div className="family-bar" role="img" aria-label={`${familyPct} percent of today's family screen time used`}>
          <div style={{ width: `${familyPct}%` }} />
        </div>
        <span className="small">{familyPct}%</span>
        {d.pausedAll ? (
          <button type="button" className="btn btn-primary" disabled={busy === 'pause'} onClick={() => void setPaused(false)}>
            Resume all screens
          </button>
        ) : (
          <button type="button" className="btn btn-danger" onClick={() => setConfirmPause(true)}>Pause all screens</button>
        )}
      </PageHead>

      {dash.error && <StaleNote message={dash.error} />}
      {d.pausedAll && (
        <div className="banner banner-warn" role="status">
          <span className="grow">All screens are paused. Family calls and emergency calls still work.</span>
        </div>
      )}

      <div className="dash-top">
        <div className="dash-left">
          <TimeLeftCard d={d} />
          <DevicesCard d={d} />
        </div>
        <div className="dash-right">
          <WeekCard d={d} />
          <Card title="Waiting for you" action={<Link to="/requests" className="small">All requests</Link>}>
            {d.requests.length === 0
              ? <p className="empty">Nothing is waiting. When a kid asks for more time or a new app, it shows up here.</p>
              : d.requests.map((r) => <RequestRow key={r.id} request={r} onDone={dash.reload} />)}
          </Card>
        </div>
      </div>

      <div className="grid-260">
        <Card title="Daily limits" action={<span className="tiny muted">Resets at midnight</span>}>
          {d.kids.map((k) => (
            <LimitRow key={k.id} label={`${k.name}, all screens`} used={k.usedMinutes} limit={k.limitMinutes} />
          ))}
          {d.appLimits.map((a, i) => (
            <LimitRow key={`${a.kidId}-${a.appName}-${i}`} label={`${a.kidName}, ${a.appName}`} used={a.usedMinutes} limit={a.limitMinutes} />
          ))}
        </Card>

        <Card title="Kids" action={<Link to="/kids/new" className="small">Add a kid</Link>}>
          {d.kids.map((k) => (
            <KidActions key={k.id} kid={k} busy={busy}
              onGrant={() => void act(`grant-${k.id}`, () => api.grant(k.id, 15), `${k.name} got 15 more minutes.`)}
              onLock={(locked) => void act(`lock-${k.id}`, () => api.lock(k.id, locked), locked ? `${k.name} is locked.` : `${k.name} is unlocked.`)} />
          ))}
        </Card>

        <BlockedCard d={d} />
      </div>

      <Confirm open={confirmPause} title="Pause all screens?" confirmLabel="Pause all screens" danger busy={busy === 'pause'}
        body="Every kid's device locks until you resume. Family calls and emergency calls still work."
        onConfirm={() => void setPaused(true)} onCancel={() => setConfirmPause(false)} />
    </>
  );
}

function TimeLeftCard({ d }: { d: Dashboard }) {
  return (
    <Card title="Time left today">
      <div className="stack" style={{ gap: 6 }}>
        {d.kids.map((k) => (
          <div key={k.id} className="row" style={{ flexWrap: 'nowrap' }}>
            <span className="big-num">{formatLeft(k.leftMinutes)}</span>
            <KidPill color={k.color}>{pillText(k.name, k.lockReason)}</KidPill>
            <span className="sr-only">{formatMinutes(k.leftMinutes)} left for {k.name}</span>
          </div>
        ))}
      </div>
      {d.week.length > 1 && <MiniLines week={d.week} kids={d.kids} />}
    </Card>
  );
}

function DevicesCard({ d }: { d: Dashboard }) {
  const count = (s: 'in_use' | 'locked' | 'off') => d.devices.filter((x) => x.status === s).length;
  return (
    <Card title="Devices" action={<Link to="/devices?add=1" className="small">Add a device</Link>}>
      {d.devices.length === 0 ? (
        <p className="empty">No devices yet. Add a Windows PC or an Android phone to start.</p>
      ) : (
        <ul className="stack" style={{ gap: 8, listStyle: 'none', margin: 0, padding: 0 }}>
          {d.devices.map((dev) => (
            <li key={dev.id} className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="dot" style={{ background: STATUS_COLOR[dev.status].dot }} aria-hidden="true" />
              <span className="grow" style={{ overflowWrap: 'anywhere' }}>{STATUS_COLOR[dev.status].label}: {dev.name}</span>
              <span className="muted">{PLATFORM[dev.platform]}</span>
            </li>
          ))}
        </ul>
      )}
      <HalfDonut inUse={count('in_use')} locked={count('locked')} off={count('off')} />
    </Card>
  );
}

function WeekCard({ d }: { d: Dashboard }) {
  const compact = useMedia('(max-width: 560px)');
  return (
    <Card title="Screen time this week" action={(
      <div className="legend" aria-hidden="true">
        {d.kids.map((k) => (
          <span key={k.id}><span className="dot" style={{ background: lineColor(k.color) }} />{k.name}</span>
        ))}
      </div>
    )}>
      <div className="chips">
        {d.kids.map((k) => {
          const bg = safeColor(k.color);
          return (
            <div key={k.id} className="chip" style={{ background: bg, color: textOn(bg) }}>
              <div className="tiny">{k.name} today</div>
              <div className="v">{formatMinutes(k.usedMinutes)}</div>
            </div>
          );
        })}
      </div>
      {d.week.length > 0
        ? <WeekChart week={d.week} kids={d.kids} compact={compact} />
        : <p className="empty">No screen time recorded yet this week.</p>}
    </Card>
  );
}

function LimitRow({ label, used, limit }: { label: string; used: number; limit: number }) {
  const value = `${formatMinutes(used)} of ${formatMinutes(limit)}`;
  return (
    <div>
      <div className="bar-label"><span>{label}</span><span style={{ textAlign: 'right' }}>{value}</span></div>
      <Progress used={used} limit={limit} label={`${label}: ${value}`} />
    </div>
  );
}

function KidActions({ kid, busy, onGrant, onLock }: {
  kid: DashKid; busy: string | null; onGrant: () => void; onLock: (locked: boolean) => void;
}) {
  const parentLocked = kid.lockReason === 'parent';
  const status = [kid.statusText?.replace(/\.$/, '')];
  if (kid.bedtimeTonight && !/bedtime/i.test(kid.statusText ?? '')) status.push(`Bedtime ${formatClock(kid.bedtimeTonight)}`);
  return (
    <div className="inset stack">
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <Avatar name={kid.name} color={kid.color} />
        <div className="grow">
          <div style={{ fontSize: 15, fontWeight: 500, overflowWrap: 'anywhere' }}>{kid.name}</div>
          <div className="tiny muted">{status.filter(Boolean).join('. ')}</div>
        </div>
      </div>
      <div className="row btn-row-tight" style={{ gap: 8 }}>
        <button type="button" className="btn btn-secondary" disabled={busy === `grant-${kid.id}`} onClick={onGrant}
          aria-label={`Give ${kid.name} 15 more minutes`}>+15 min</button>
        <button type="button" className="btn btn-ghost" disabled={busy === `lock-${kid.id}`} onClick={() => onLock(!parentLocked)}
          aria-label={parentLocked ? `Unlock ${kid.name}` : `Lock ${kid.name} now`}>
          {parentLocked ? 'Unlock' : 'Lock now'}
        </button>
        <Link to={`/kids/${kid.id}`} className="btn btn-ghost" aria-label={`Rules for ${kid.name}`}>Rules</Link>
      </div>
    </div>
  );
}

function BlockedCard({ d }: { d: Dashboard }) {
  const total = d.blocked.reduce((n, b) => n + b.count, 0);
  return (
    <Card title="Blocked sites">
      {d.blocked.length > 0 && <Lollipop days={d.blocked} />}
      <p className="small muted">
        {total === 0 ? 'No blocked website tries this week.' : `${plural(total, 'try', 'tries')} this week.`}{' '}
        <Link to="/reports">See which sites in Reports</Link>
      </p>
    </Card>
  );
}

export function FirstRun() {
  return (
    <>
      <PageHead title="Welcome to Family Screen Warden" />
      <Card className="first-run">
        <p style={{ fontSize: 16 }}>Two steps and your first device is protected.</p>
        <ol className="steps">
          <li><strong>Add a kid.</strong> Each kid gets their own daily time, bedtime and allowed apps.</li>
          <li><strong>Add a device.</strong> Pair a Windows PC or an Android phone with a code from this console.</li>
        </ol>
        <div className="row">
          <Link to="/kids/new" className="btn btn-primary">Add a kid</Link>
          <Link to="/help" className="btn btn-ghost">How setup works</Link>
        </div>
        <p className="small muted">Your 30-day free trial is running. No card needed.</p>
      </Card>
    </>
  );
}
