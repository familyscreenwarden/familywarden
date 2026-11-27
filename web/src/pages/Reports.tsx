import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import type { Kid } from '../api/types';
import { DayBars } from '../components/charts';
import { Card, ErrorBox, Loading, PageHead, Progress } from '../components/ui';
import { dayLong, formatMinutes, plural, timeAgo } from '../lib/format';

export function ReportsPage() {
  const { api } = useApp();
  const kids = useLoad(() => api.kids(), []);
  const list = kids.data?.kids;
  const [kidId, setKidId] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 30>(7);
  const kidSel = useId(), daySel = useId();

  useEffect(() => {
    if (list && list.length > 0 && !list.some((k) => k.id === kidId)) setKidId(list[0]?.id ?? null);
  }, [list, kidId]);
  const kid = list?.find((k) => k.id === kidId) ?? null;

  return (
    <>
      <PageHead title="Reports" sub="Screen time per day, per app, and the websites that were blocked.">
        {list && list.length > 0 && (
          <>
            <div className="field">
              <label htmlFor={kidSel} className="sr-only">Kid</label>
              <select id={kidSel} className="select w-auto" value={kidId ?? ''} onChange={(e) => setKidId(e.target.value)}>
                {list.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={daySel} className="sr-only">Time range</label>
              <select id={daySel} className="select w-auto" value={days} onChange={(e) => setDays(e.target.value === '30' ? 30 : 7)}>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
              </select>
            </div>
          </>
        )}
      </PageHead>
      {!list && (kids.error ? <ErrorBox message={kids.error} onRetry={() => void kids.reload()} /> : <Loading label="Loading kids" />)}
      {list && list.length === 0 && (
        <Card className="first-run">
          <p>Reports appear once a kid has a device. Start by adding a kid.</p>
          <div><Link to="/kids/new" className="btn btn-primary">Add a kid</Link></div>
        </Card>
      )}
      {kid && <KidReport key={`${kid.id}-${days}`} kid={kid} days={days} />}
    </>
  );
}

function KidReport({ kid, days }: { kid: Kid; days: 7 | 30 }) {
  const { api } = useApp();
  const report = useLoad(() => api.reports(kid.id, days), [kid.id, days]);
  const [day, setDay] = useState('all');
  const pick = useId();
  const r = report.data;

  const apps = useMemo(() => {
    if (!r) return [];
    const totals = new Map<string, number>();
    for (const d of r.days) {
      if (day !== 'all' && d.day !== day) continue;
      for (const a of d.byApp) totals.set(a.name, (totals.get(a.name) ?? 0) + a.minutes);
    }
    return [...totals.entries()].map(([name, minutes]) => ({ name, minutes })).sort((a, b) => b.minutes - a.minutes);
  }, [r, day]);

  if (!r) return report.error ? <ErrorBox message={report.error} onRetry={() => void report.reload()} /> : <Loading label="Loading the report" />;

  const total = r.days.reduce((n, d) => n + d.minutes, 0);
  const average = r.days.length ? Math.round(total / r.days.length) : 0;
  const topApp = Math.max(1, ...apps.map((a) => a.minutes));
  const blockedTotal = r.blocked.reduce((n, b) => n + b.count, 0);

  return (
    <>
      <Card title={`${kid.name}: screen time per day`}>
        <div className="row" style={{ gap: 22 }}>
          <div className="row"><span className="mid-num">{formatMinutes(total)}</span><span className="pill pill-peri">Last {days} days</span></div>
          <div className="row"><span className="mid-num">{formatMinutes(average)}</span><span className="pill pill-deep">Daily average</span></div>
        </div>
        {total === 0 ? <p className="empty">No screen time recorded in these {days} days.</p> : (
          <div className="table-wrap">
            <DayBars days={r.days} color={kid.color} selected={day === 'all' ? null : day} />
          </div>
        )}
        <details>
          <summary className="small" style={{ cursor: 'pointer', minHeight: 24 }}>Show the days as a list</summary>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead><tr><th scope="col">Day</th><th scope="col" className="right">Screen time</th></tr></thead>
              <tbody>
                {[...r.days].reverse().map((d) => (
                  <tr key={d.day}><td>{dayLong(d.day)}</td><td className="right">{formatMinutes(d.minutes)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Card>

      <div className="grid-300">
        <Card title="Apps and websites" action={(
          <>
            <label htmlFor={pick} className="sr-only">Day</label>
            <select id={pick} className="select-mini" style={{ minHeight: 44 }} value={day} onChange={(e) => setDay(e.target.value)}>
              <option value="all">All {days} days</option>
              {[...r.days].reverse().map((d) => <option key={d.day} value={d.day}>{dayLong(d.day)}</option>)}
            </select>
          </>
        )}>
          {apps.length === 0 ? <p className="empty">Nothing was used {day === 'all' ? 'in these days' : 'on this day'}.</p> : apps.map((a) => (
            <div key={a.name}>
              <div className="bar-label"><span style={{ overflowWrap: 'anywhere' }}>{a.name}</span><span style={{ whiteSpace: 'nowrap' }}>{formatMinutes(a.minutes)}</span></div>
              <Progress plain used={a.minutes} limit={topApp} label={`${a.name}: ${formatMinutes(a.minutes)}`} />
            </div>
          ))}
        </Card>

        <Card title="Blocked sites" action={<span className="tiny muted">{plural(blockedTotal, 'try', 'tries')}</span>}>
          {r.blocked.length === 0 ? <p className="empty">No blocked website tries in these {days} days.</p> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Blocked sites table">
              <table className="table">
                <thead><tr><th scope="col">Website</th><th scope="col" className="right">Tries</th><th scope="col" className="right">Last try</th></tr></thead>
                <tbody>
                  {r.blocked.map((b) => (
                    <tr key={b.host}>
                      <td style={{ overflowWrap: 'anywhere', padding: '13px 12px 13px 0' }}>{b.host}</td>
                      <td className="right">{b.count}</td>
                      <td className="right muted" style={{ whiteSpace: 'nowrap' }}>{timeAgo(b.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted">To allow a website, add it under <Link to={`/kids/${kid.id}`}>{kid.name}'s rules</Link>.</p>
        </Card>
      </div>
    </>
  );
}
