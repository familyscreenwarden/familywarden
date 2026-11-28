import { Link } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import type { KidSafety } from '../api/types';
import { Avatar, Card, ErrorBox, Loading, PageHead } from '../components/ui';
import { plural } from '../lib/format';
import { WHO_NAME, webSummary } from '../lib/levels';

/** /safe-browsing: every kid's level and website rules at a glance. The rules are changed on each kid's "Levels and web" page. */
export function SafeBrowsingPage() {
  const { api } = useApp();
  const data = useLoad(async () => {
    const { kids } = await api.kids();
    const safety = await Promise.all(kids.map((k) => api.kidSafety(k.id)));
    return kids.map((kid, i) => ({ kid, safety: safety[i] as KidSafety }));
  }, []);
  const list = data.data;

  return (
    <>
      <PageHead title="Safe browsing" sub="Each kid's level and website rules, the same on every phone and PC they have." />
      {!list && (data.error ? <ErrorBox message={data.error} onRetry={() => void data.reload()} /> : <Loading label="Loading kids" />)}
      {list && list.length === 0 && (
        <Card className="first-run">
          <p>Add a kid first, then set their level and website rules here.</p>
          <div><Link to="/kids/new" className="btn btn-primary">Add a kid</Link></div>
        </Card>
      )}
      {list && list.length > 0 && (
        <div className="grid-300">
          {list.map(({ kid, safety: s }) => {
            const level = s.levels.find((l) => l.id === s.level);
            return (
              <section key={kid.id} className="card" aria-label={`Safe browsing for ${kid.name}`}>
                <div className="row-between">
                  <div className="row"><Avatar name={kid.name} color={kid.color} /><h2 style={{ fontSize: 18, fontWeight: 500 }}>{kid.name}</h2></div>
                  <span className={`pill ${level ? 'pill-peri' : 'pill-off'}`}>{level ? `${level.name}${s.changes.length > 0 ? ', changed' : ''}` : 'No level picked'}</span>
                </div>
                <ul className="notes">
                  <li>{webSummary(s.web.mode, s.settings.safeSearch, s.settings.youTube)}</li>
                  {s.web.mode === 'filtered' && <li>{plural(s.web.categories.length, 'kind', 'kinds')} of sites blocked.</li>}
                  <li>{plural(s.web.allowed.length, 'website', 'websites')} always allowed, {s.web.blocked.length} always blocked.</li>
                  <li>Private browsing is {s.blockPrivate ? 'blocked' : 'allowed'}. Texts: {WHO_NAME[s.settings.texting].toLowerCase()}.</li>
                  <li>{s.blockedToday.length === 0 ? 'Nothing was blocked in the last day.' : `${plural(s.blockedToday.length, 'website was', 'websites were')} blocked in the last day.`}</li>
                </ul>
                <div><Link to={`/kids/${kid.id}/levels`} className="btn btn-secondary">Levels and web<span className="sr-only"> for {kid.name}</span></Link></div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
