import { useState } from 'react';
import { useApp } from '../app';
import type { KidRequest } from '../api/types';
import { timeAgo } from '../lib/format';
import { requestCopy } from '../lib/requests';

/** One pending request with its Yes/Allow and No buttons. */
export function RequestRow({ request, onDone }: { request: KidRequest; onDone: () => void | Promise<void> }) {
  const { api, run, bumpBadge } = useApp();
  const [busy, setBusy] = useState(false);
  const copy = requestCopy(request);

  async function decide(approve: boolean) {
    setBusy(true);
    const ok = await run(
      () => api.decide(request.id, approve),
      approve ? `Approved: ${copy.text}` : `Declined: ${copy.text}`,
    );
    if (ok) bumpBadge();
    await onDone();
    setBusy(false);
  }

  return (
    <div className="inset request">
      <div className="request-body">
        <div className="request-meta">
          <span>{request.deviceName ? `${request.deviceName}, ` : ''}{timeAgo(request.createdAt)}</span>
          <span className={`pill ${copy.tagClass}`}>{copy.tag}</span>
        </div>
        <div style={{ fontSize: 15, overflowWrap: 'anywhere' }}>{copy.text}</div>
        {copy.note && <div className="small muted" style={{ overflowWrap: 'anywhere', marginTop: 4 }}>{copy.note}</div>}
        {request.kind === 'contact' && <div className="tiny muted" style={{ marginTop: 4 }}>Allow lets {request.kidName} text and call this number, but not at bedtime, when time is up or while the phone is locked.</div>}
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide(true)}
        aria-label={`${copy.yes}: ${copy.text}`}>{copy.yes}</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void decide(false)}
        aria-label={`No: ${copy.text}`}>No</button>
    </div>
  );
}
