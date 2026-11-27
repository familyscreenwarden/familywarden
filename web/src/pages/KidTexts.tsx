import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import type { PhoneText, TextThread } from '../api/types';
import { KidSections, KidTabs } from '../components/KidNav';
import { RequestRow } from '../components/RequestRow';
import { Card, ErrorBox, Loading, PageHead, StaleNote } from '../components/ui';
import { plural, possessive, timeAgo } from '../lib/format';

/** /kids/:id/texts: a copy of the kid's texts to read, texts held from unknown numbers, and who the kid may text. */
export function KidTextsPage() {
  const { id = '' } = useParams();
  const { api, run } = useApp();
  const detail = useLoad(() => api.kid(id), [id], 60000);
  const kids = useLoad(() => api.kids(), [id]);
  const texts = useLoad(() => api.kidTexts(id), [id], 30000);
  const requests = useLoad(() => api.requests('pending'), [id], 30000);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<{ textId: string; phone: string } | null>(null);

  const kid = detail.data?.kid;
  const t = texts.data;
  const error = detail.error ?? texts.error;

  // On a wide screen the newest chat is open from the start; on a phone the list comes first.
  useEffect(() => {
    if (!open && t?.threads[0] && window.matchMedia('(min-width: 861px)').matches) setOpen(t.threads[0].thread);
  }, [t, open]);
  useEffect(() => { setOpen(null); setAdding(null); }, [id]);

  if (!kid || !t || !detail.data) {
    return (
      <>
        <PageHead title="Texts" />
        {error ? (
          <>
            <ErrorBox message={error} onRetry={() => { void detail.reload(); void texts.reload(); }} />
            <p><Link to="/kids">Back to kids</Link></p>
          </>
        ) : <Loading label="Loading texts" />}
      </>
    );
  }

  const contacts = detail.data.contacts;
  const family = contacts.filter((c) => c.canCall);
  const friends = contacts.filter((c) => !c.canCall && c.canText);
  const asking = (requests.data?.requests ?? []).filter((r) => r.kind === 'contact' && r.kidId === kid.id);
  const current = t.threads.find((th) => th.thread === open) ?? null;

  async function act(action: () => Promise<unknown>, okText: string): Promise<boolean> {
    setBusy(true);
    const ok = await run(action, okText);
    await Promise.all([texts.reload(), detail.reload(), requests.reload()]);
    setBusy(false);
    return ok;
  }

  return (
    <>
      <PageHead title={`${possessive(kid.name)} texts`}
        sub={`A copy of the texts on ${possessive(kid.name)} phone, to read only. ${kid.name} is not told when you look. Kept for ${t.keepDays} days.`}>
        <KidTabs kids={kids.data?.kids ?? []} currentId={kid.id} section="texts" />
      </PageHead>
      <KidSections kidId={kid.id} current="texts" />
      {texts.error && <StaleNote message={texts.error} />}

      {asking.length > 0 && (
        <Card title="Asking to text a friend">
          {asking.map((r) => <RequestRow key={r.id} request={r} onDone={async () => { await Promise.all([requests.reload(), detail.reload()]); }} />)}
        </Card>
      )}

      {t.held.length > 0 && (
        <Card title="Held texts">
          <p className="small muted">These came from numbers that are not on {possessive(kid.name)} list, so the phone did not show them. Add the sender as a friend and the text shows on the phone, or block the number.</p>
          {t.held.map((h) => (
            <div key={h.id} className="inset stack">
              <div className="request">
                <div className="request-body">
                  <div className="request-meta"><span>{h.from ?? 'Unknown number'}, {timeAgo(h.at)}</span><span className="pill pill-warn">Held</span></div>
                  {h.body && <div style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{h.body}</div>}
                  <Attachments text={h} kidName={kid.name} />
                </div>
                <button type="button" className="btn btn-secondary" disabled={busy || !h.from} aria-expanded={adding?.textId === h.id}
                  onClick={() => setAdding((a) => (a?.textId === h.id ? null : { textId: h.id, phone: h.from ?? '' }))}>Add as a friend</button>
                <button type="button" className="btn btn-danger" disabled={busy || !h.from}
                  onClick={() => void act(() => api.blockNumber(kid.id, h.from ?? ''), `${h.from} is blocked.`)}>Block number</button>
                <button type="button" className="btn btn-ghost" disabled={busy}
                  onClick={() => void act(() => api.deleteHeldText(h.id), 'The text was deleted.')}>Delete</button>
              </div>
              {adding?.textId === h.id && (
                <FriendForm phone={adding.phone} busy={busy} onCancel={() => setAdding(null)}
                  onSubmit={async (name) => {
                    const ok = await act(
                      () => api.request('POST', `/api/kids/${encodeURIComponent(kid.id)}/contacts`, { name, phone: adding.phone, canCall: false, canText: true, always: false }),
                      `${name} is a friend now. The text shows on ${possessive(kid.name)} phone in about a minute.`,
                    );
                    if (ok) setAdding(null);
                  }} />
              )}
            </div>
          ))}
        </Card>
      )}

      <Card title="Chats">
        {t.threads.length === 0 ? (
          <p className="empty">No texts yet. They show up here about a minute after {kid.name} sends or gets one on the phone.</p>
        ) : (
          <div className={`texts-panes${current ? ' has-open' : ''}`}>
            <ul className="thread-list" aria-label="Chats">
              {t.threads.map((th) => (
                <li key={th.thread}><ThreadButton thread={th} kidName={kid.name} on={th.thread === open} onOpen={() => setOpen(th.thread)} /></li>
              ))}
            </ul>
            <div className="thread-view">
              {current ? (
                <>
                  <div className="thread-view-head">
                    <button type="button" className="btn btn-ghost thread-back" onClick={() => setOpen(null)}>Back to chats</button>
                    <div style={{ minWidth: 0 }}>
                      <div className="thread-title">{current.names.join(', ')}</div>
                      <div className="tiny muted">{plural(current.count, 'text', 'texts')}</div>
                    </div>
                  </div>
                  <ThreadTexts key={current.thread} kidId={kid.id} thread={current} kidName={kid.name} />
                </>
              ) : <p className="empty thread-pick">Choose a chat to read it.</p>}
            </div>
          </div>
        )}
      </Card>

      <div className="grid-300">
        <Card title={`Who ${kid.name} can text`} action={<Link to={`/kids/${kid.id}`} className="small">Add or edit contacts</Link>}>
          <div className="stack">
            <div>
              <div className="label">Family: texts and calls. Which of them also work while the phone is locked is set under <Link to={`/kids/${kid.id}/phone`}>Phone and chores</Link>.</div>
              {family.length === 0 ? <p className="empty">No family contacts yet.</p> : (
                <ul className="plain-list" style={{ marginTop: 6 }}>
                  {family.map((c) => <li key={c.id}><span>{c.name}</span><span className="muted small">{c.phone}</span></li>)}
                </ul>
              )}
            </div>
            <div>
              <div className="label">Friends: not at bedtime, when time is up, or while the phone is locked</div>
              {friends.length === 0 ? <p className="empty">No friends yet. {kid.name} can ask from the phone, and you answer under Requests.</p> : (
                <ul className="plain-list" style={{ marginTop: 6 }}>
                  {friends.map((c) => (
                    <li key={c.id}>
                      <span>{c.name}</span><span className="muted small grow">{c.phone}</span>
                      <button type="button" className="btn btn-ghost" disabled={busy}
                        onClick={() => void act(() => api.deleteContact(c.id), `${c.name} was removed. ${kid.name} can no longer text them.`)}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>
        <BlockedCard kidName={kid.name} blocked={t.blocked} busy={busy}
          onBlock={(phone) => act(() => api.blockNumber(kid.id, phone), `${phone} is blocked.`)}
          onUnblock={(b) => void act(() => api.unblockNumber(kid.id, b.num), `${b.phone} is no longer blocked.`)} />
      </div>
    </>
  );
}

function ThreadButton({ thread, kidName, on, onOpen }: { thread: TextThread; kidName: string; on: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={`thread-item${on ? ' on' : ''}`} aria-current={on ? 'true' : undefined} onClick={onOpen}>
      <span className="row-between" style={{ flexWrap: 'nowrap' }}>
        <span className="thread-title">{thread.names.join(', ')}</span>
        <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>{timeAgo(thread.at)}</span>
      </span>
      <span className="tiny muted thread-last">
        {thread.last.dir === 'out' ? `${kidName}: ` : thread.names.length > 1 && thread.last.fromName ? `${thread.last.fromName}: ` : ''}{thread.last.body}
      </span>
    </button>
  );
}

function ThreadTexts({ kidId, thread, kidName }: { kidId: string; thread: TextThread; kidName: string }) {
  const { api } = useApp();
  const data = useLoad(() => api.textThread(kidId, thread.thread), [kidId, thread.thread, thread.count], 30000);
  const box = useRef<HTMLOListElement>(null);
  const n = data.data?.texts.length ?? 0;
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [n]);
  if (!data.data) return data.error ? <ErrorBox message={data.error} onRetry={() => void data.reload()} /> : <Loading label="Loading the chat" />;
  return (
    <ol className="bubbles chat-box" ref={box} tabIndex={0} aria-label={`Texts with ${thread.names.join(', ')}`}
      onLoadCapture={() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }}>
      {data.data.texts.map((m) => (
        <li key={m.id} className={`bubble ${m.dir === 'out' ? 'out' : 'in'}`}>
          <div className="tiny muted">
            {m.dir === 'out' ? kidName : (m.fromName ?? m.from ?? 'Unknown')} · {timeAgo(m.at)}
            {m.status === 'waiting' ? ' · arrived while the phone was locked' : ''}
          </div>
          {m.body && <div style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{m.body}</div>}
          <Attachments text={m} kidName={kidName} />
        </li>
      ))}
    </ol>
  );
}

/** Pictures in a text are shown; other attachments (a clip, a sound) are offered as a download. */
function Attachments({ text, kidName }: { text: PhoneText; kidName: string }) {
  if (text.media.length === 0) return null;
  return (
    <>
      {text.media.map((x, i) => {
        if (!x.url) return <div key={i} className="tiny muted">Photo still on its way from the phone</div>;
        if (/^image\/(jpeg|png|gif|webp)$/.test(x.type)) {
          return <img key={i} className="bubble-img" src={x.url} alt={`Photo in a text ${text.dir === 'out' ? `from ${kidName}` : `to ${kidName}`}`} loading="lazy" />;
        }
        return <a key={i} className="small" href={x.url} download>Download the {x.type.startsWith('video/') ? 'video' : x.type.startsWith('audio/') ? 'sound clip' : 'attachment'}</a>;
      })}
    </>
  );
}

function FriendForm({ phone, busy, onSubmit, onCancel }: { phone: string; busy: boolean; onSubmit: (name: string) => void | Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const nameId = useId();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) void onSubmit(name.trim());
  }
  return (
    <form className="friend-form" onSubmit={submit}>
      <div className="field grow">
        <label htmlFor={nameId}>Name for {phone}</label>
        <input id={nameId} className="input" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} placeholder="For example Jake" />
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Add friend</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
    </form>
  );
}

function BlockedCard({ kidName, blocked, busy, onBlock, onUnblock }: {
  kidName: string; blocked: { num: string; phone: string; at: string }[]; busy: boolean;
  onBlock: (phone: string) => Promise<boolean>; onUnblock: (b: { num: string; phone: string }) => void;
}) {
  const [phone, setPhone] = useState('');
  const inputId = useId();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (phone.trim() && await onBlock(phone.trim())) setPhone('');
  }
  return (
    <Card title="Blocked numbers">
      <p className="small muted">Texts from these numbers are dropped on the phone. {kidName} never sees them, and neither do you.</p>
      {blocked.length === 0 ? <p className="empty">No blocked numbers.</p> : (
        <ul className="plain-list">
          {blocked.map((b) => (
            <li key={b.num}>
              <span className="grow">{b.phone}</span>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onUnblock(b)}>Unblock</button>
            </li>
          ))}
        </ul>
      )}
      <form className="friend-form" onSubmit={(e) => void submit(e)}>
        <div className="field grow">
          <label htmlFor={inputId}>Block a number</label>
          <input id={inputId} className="input" inputMode="tel" value={phone} maxLength={32} onChange={(e) => setPhone(e.target.value)} placeholder="555 010 0199" />
        </div>
        <button type="submit" className="btn btn-ghost" disabled={busy || !phone.trim()}>Block</button>
      </form>
    </Card>
  );
}
