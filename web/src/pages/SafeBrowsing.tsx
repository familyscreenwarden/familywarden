import { Link } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import { SafeSwitches } from '../components/SafeSwitches';
import { Avatar, Card, ErrorBox, Loading, PageHead } from '../components/ui';

export function SafeBrowsingPage() {
  const { api } = useApp();
  const kids = useLoad(() => api.kids(), []);
  const list = kids.data?.kids;

  return (
    <>
      <PageHead title="Safe browsing" sub="Website rules for each kid. Changes are saved as you switch them." />
      {!list && (kids.error ? <ErrorBox message={kids.error} onRetry={() => void kids.reload()} /> : <Loading label="Loading kids" />)}
      {list && list.length === 0 && (
        <Card className="first-run">
          <p>Add a kid first, then set their website rules here.</p>
          <div><Link to="/kids/new" className="btn btn-primary">Add a kid</Link></div>
        </Card>
      )}
      {list && list.length > 0 && (
        <div className="grid-300">
          {list.map((k) => (
            <section key={k.id} className="card" aria-label={`Safe browsing for ${k.name}`}>
              <div className="row-between">
                <div className="row"><Avatar name={k.name} color={k.color} /><h2 style={{ fontSize: 18, fontWeight: 500 }}>{k.name}</h2></div>
                <Link to={`/kids/${k.id}`} className="small">Allowed websites</Link>
              </div>
              <SafeSwitches kid={k} onSaved={kids.reload} showHelp />
            </section>
          ))}
        </div>
      )}
    </>
  );
}
