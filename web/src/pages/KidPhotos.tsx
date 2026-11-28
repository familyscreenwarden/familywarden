import { useEffect, useId, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import type { KidMediaItem } from '../api/types';
import { KidSections, KidTabs } from '../components/KidNav';
import { Card, Confirm, ErrorBox, ICON, Icon, Loading, PageHead, Progress, StaleNote } from '../components/ui';
import { possessive } from '../lib/format';
import { KIND_WORD, MEDIA_FILTERS, clipLength, fileSize, filterMedia, linkEnds, mediaName, takenAt } from '../lib/media';
import type { MediaFilter } from '../lib/media';

/** /kids/:id/photos: what the kid took and made with the phone's Camera and Movie Maker. Copies, for the parents. */
export function KidPhotosPage() {
  const { id = '' } = useParams();
  const { api, run } = useApp();
  const detail = useLoad(() => api.kid(id), [id]);
  const kids = useLoad(() => api.kids(), [id]);
  const media = useLoad(() => api.kidMedia(id), [id], 30000);
  const [filter, setFilter] = useState<MediaFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kid = detail.data?.kid;
  const m = media.data;
  const error = detail.error ?? media.error;

  if (!kid || !m) {
    return (
      <>
        <PageHead title="Photos and videos" />
        {error ? (
          <>
            <ErrorBox message={error} onRetry={() => { void detail.reload(); void media.reload(); }} />
            <p><Link to="/kids">Back to kids</Link></p>
          </>
        ) : <Loading label="Loading photos and videos" />}
      </>
    );
  }

  const shown = filterMedia(m.items, filter);
  const open = m.items.find((x) => x.id === openId) ?? null;
  const full = m.usedBytes >= m.quotaBytes * 0.9;

  async function act(action: () => Promise<unknown>, okText: string): Promise<boolean> {
    setBusy(true);
    const ok = await run(action, okText);
    await media.reload();
    setBusy(false);
    return ok;
  }

  return (
    <>
      <PageHead title={`${possessive(kid.name)} photos and videos`}
        sub={`Copies of what ${kid.name} takes and makes on the phone. Kept for ${m.keepDays} days, also after ${kid.name} deletes them on the phone.`}>
        <KidTabs kids={kids.data?.kids ?? []} currentId={kid.id} section="photos" />
      </PageHead>
      <KidSections kidId={kid.id} current="photos" />
      {media.error && <StaleNote message={media.error} />}

      <Card>
        <div className="row-between">
          <div className="tabs" role="group" aria-label="Show">
            {MEDIA_FILTERS.map((f) => {
              const count = filterMedia(m.items, f.value).length;
              return (
                <button key={f.value} type="button" className={`tab tab-filter${filter === f.value ? ' on' : ''}`} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                  {f.label}<span className="tab-count">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="media-room">
            <div className="tiny muted">{fileSize(m.usedBytes)} of {fileSize(m.quotaBytes)} used</div>
            <Progress used={m.usedBytes} limit={m.quotaBytes} thin plain={!full} label={`${fileSize(m.usedBytes)} of ${fileSize(m.quotaBytes)} used`} />
          </div>
        </div>
        {full && (
          <div className="banner banner-warn small" role="status">
            The room for {possessive(kid.name)} photos and videos is almost used up. New ones are not copied once it is full. Delete some to make room.
          </div>
        )}
        {m.items.length === 0 && (
          <p className="empty">Nothing yet. What {kid.name} takes with the phone's Camera or makes in Movie Maker shows up here about a minute later.</p>
        )}
        {m.items.length > 0 && shown.length === 0 && <p className="empty">No {MEDIA_FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} yet.</p>}
        {shown.length > 0 && (
          <ul className="media-grid">
            {shown.map((item) => (
              <li key={item.id}><Tile item={item} kidName={kid.name} onOpen={() => setOpenId(item.id)} /></li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Good to know">
        <ul className="notes">
          <li>These are copies. Deleting one here does not delete it on the phone, and {kid.name} deleting one on the phone does not delete it here.</li>
          <li>{kid.name} can send a video or movie to family as a link. Anyone who has the link can watch that one video for {m.linkDays} days, without signing in. You can end a link here at any time.</li>
          <li>Only you, signed in to this console, can see this page.</li>
        </ul>
      </Card>

      <Viewer item={open} kidName={kid.name} busy={busy} onClose={() => setOpenId(null)}
        onEndLink={(item) => void act(() => api.endMediaLink(item.id), 'The link no longer works.')}
        onDelete={async (item) => { if (await act(() => api.deleteMedia(item.id), `The ${KIND_WORD[item.kind]} was deleted from the console.`)) setOpenId(null); }} />
    </>
  );
}

function Tile({ item, kidName, onOpen }: { item: KidMediaItem; kidName: string; onOpen: () => void }) {
  const name = mediaName(item, kidName);
  const isPhoto = item.kind === 'photo';
  return (
    <button type="button" className="media-tile" onClick={onOpen}
      aria-label={`Open ${isPhoto ? 'photo' : `${KIND_WORD[item.kind]}, ${clipLength(item.durationSec)}`}: ${name}, ${takenAt(item.at)}`}>
      {isPhoto
        ? <img src={item.url} alt="" loading="lazy" />
        : <video src={`${item.url}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true" />}
      {!isPhoto && (
        <span className="media-play" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </span>
      )}
      <span className="media-tags">
        {!isPhoto && <span className="pill pill-dark">{item.kind === 'movie' ? 'Movie' : 'Video'} {clipLength(item.durationSec)}</span>}
        {item.linkShared && <span className="pill pill-warn">Link</span>}
        {item.deletedOnPhone && <span className="pill pill-dark">Deleted on phone</span>}
      </span>
      <span className="media-caption">
        <span className="media-title">{item.title || takenAt(item.at)}</span>
        {item.title && <span className="tiny">{takenAt(item.at)}</span>}
      </span>
    </button>
  );
}

function Viewer({ item, kidName, busy, onClose, onEndLink, onDelete }: {
  item: KidMediaItem | null; kidName: string; busy: boolean; onClose: () => void;
  onEndLink: (item: KidMediaItem) => void; onDelete: (item: KidMediaItem) => void | Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (item && !el.open) el.showModal();
    if (!item && el.open) el.close();
    if (!item) setConfirming(false);
  }, [item]);

  return (
    <>
      <dialog ref={ref} className="dialog dialog-media" aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(); }}
        onClick={(e) => { if (e.target === ref.current) onClose(); }}>
        {item && (
          <>
            <div className="row-between" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
              <h2 id={titleId} style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{mediaName(item, kidName)}</h2>
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}><Icon d={ICON.close} /></button>
            </div>
            {item.kind === 'photo'
              ? <img className="media-full" src={item.url} alt={item.title || `Photo ${kidName} took`} />
              : <video key={item.id} className="media-full" src={item.url} controls playsInline preload="metadata" />}
            <div className="small muted">
              {takenAt(item.at)}{item.kind !== 'photo' && item.durationSec > 0 ? ` · ${clipLength(item.durationSec)}` : ''} · {fileSize(item.size)}{item.deviceName ? ` · ${item.deviceName}` : ''}
            </div>
            {(item.deletedOnPhone || item.linkShared) && (
              <div className="stack" style={{ marginTop: 10 }}>
                {item.deletedOnPhone && <div className="small"><span className="pill pill-off">Deleted on the phone</span> {kidName} deleted it there. This copy stays until you delete it or its days here run out.</div>}
                {item.linkShared && (
                  <div className="small"><span className="pill pill-warn">Shared with a link</span> {kidName} made a link for it. Anyone who has the link can watch it; the link {linkEnds(item.linkExpiresAt)}.</div>
                )}
              </div>
            )}
            <div className="dialog-actions">
              <a className="btn btn-ghost" href={`${item.url}?download=1`} download>Download</a>
              {item.linkShared && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onEndLink(item)}>End the link</button>}
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirming(true)}><Icon d={ICON.trash} /> Delete</button>
            </div>
          </>
        )}
      </dialog>
      <Confirm open={confirming && !!item} danger busy={busy} title={`Delete this ${item ? KIND_WORD[item.kind] : 'photo'}?`} confirmLabel="Delete"
        body={item ? (
          <>It is removed from the console{item.linkShared ? ', and its link stops working' : ''}. {item.deletedOnPhone ? `It is already gone from ${possessive(kidName)} phone.` : `It stays on ${possessive(kidName)} phone.`} This cannot be undone.</>
        ) : ''}
        onCancel={() => setConfirming(false)}
        onConfirm={() => { if (item) void Promise.resolve(onDelete(item)).then(() => setConfirming(false)); }} />
    </>
  );
}
