import { useState } from 'react';
import { useApp } from '../app';
import type { ChoreApproval } from '../api/types';
import { timeAgo } from '../lib/format';
import { choreCopy } from '../lib/requests';

/** One chore a kid marked as done, with Yes and No. Yes adds the chore's minutes to the kid's time today. */
export function ChoreRow({ approval, onDone }: { approval: ChoreApproval; onDone: () => void | Promise<void> }) {
  const { api, run, bumpBadge } = useApp();
  const [busy, setBusy] = useState(false);
  const copy = choreCopy(approval);

  async function decide(approve: boolean) {
    setBusy(true);
    const ok = await run(
      () => api.decideChore(approval.id, approve),
      approve
        ? (approval.minutes > 0 ? `${approval.kidName} got ${approval.minutes} more minutes for: ${approval.choreName}` : `Approved: ${approval.choreName}`)
        : `Declined: ${approval.choreName}. ${approval.kidName} can try again.`,
    );
    if (ok) bumpBadge();
    await onDone();
    setBusy(false);
  }

  return (
    <div className="inset request">
      <div className="request-body">
        <div className="request-meta">
          <span>{approval.deviceName ? `${approval.deviceName}, ` : ''}{timeAgo(approval.createdAt)}</span>
          <span className="pill pill-green">Chore</span>
        </div>
        <div style={{ fontSize: 15, overflowWrap: 'anywhere' }}>{copy.text}</div>
        <div className="tiny muted">{copy.reward}</div>
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide(true)}
        aria-label={`Yes, done: ${copy.text}`}>Yes, done</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void decide(false)}
        aria-label={`Not yet: ${copy.text}`}>Not yet</button>
    </div>
  );
}
