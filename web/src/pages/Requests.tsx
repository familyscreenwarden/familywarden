import { useApp, useLoad } from '../app';
import { RequestRow } from '../components/RequestRow';
import { Card, ErrorBox, Loading, PageHead, StaleNote } from '../components/ui';
import { timeAgo } from '../lib/format';
import { requestCopy } from '../lib/requests';

export function RequestsPage() {
  const { api } = useApp();
  const all = useLoad(() => api.requests('all'), [], 30000);
  const list = all.data?.requests ?? [];
  const pending = list.filter((r) => r.status === 'pending');
  const history = list.filter((r) => r.status !== 'pending');

  return (
    <>
      <PageHead title="Requests" sub="Kids can ask for more time, a new app or a website. You answer here." />
      {!all.data && (all.error ? <ErrorBox message={all.error} onRetry={() => void all.reload()} /> : <Loading label="Loading requests" />)}
      {all.data && (
        <>
          {all.error && <StaleNote message={all.error} />}
          <Card title="Waiting for you">
            {pending.length === 0
              ? <p className="empty">Nothing is waiting.</p>
              : pending.map((r) => <RequestRow key={r.id} request={r} onDone={all.reload} />)}
          </Card>
          <Card title="Earlier requests">
            {history.length === 0 ? <p className="empty">No answered requests yet.</p> : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Earlier requests table">
                <table className="table" style={{ minWidth: 520 }}>
                  <thead><tr><th scope="col">Request</th><th scope="col">Device</th><th scope="col">Asked</th><th scope="col" className="right">Answer</th></tr></thead>
                  <tbody>
                    {history.map((r) => (
                      <tr key={r.id}>
                        <td style={{ padding: '13px 12px 13px 0' }}>{requestCopy(r).text}</td>
                        <td className="muted">{r.deviceName ?? 'Unknown device'}</td>
                        <td className="muted" style={{ whiteSpace: 'nowrap' }}>{timeAgo(r.createdAt)}</td>
                        <td className="right">
                          <span className={`pill ${r.status === 'approved' ? 'pill-deep' : 'pill-off'}`}>{r.status === 'approved' ? 'Approved' : 'Declined'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
