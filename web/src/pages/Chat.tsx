import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useApp, useLoad } from '../app';
import type { ChatMessage } from '../api/types';
import { Card, Confirm, ErrorBox, ICON, Icon, Loading, PageHead, StaleNote } from '../components/ui';
import { safeColor } from '../lib/color';
import { timeAgo } from '../lib/format';

/** Family chat: kids write from the home screen of their device, parents read and write here. */
export function ChatPage() {
  const { api, run } = useApp();
  const chat = useLoad(() => api.chat(), [], 10000);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ChatMessage | null>(null);
  const input = useId();
  const end = useRef<HTMLLIElement>(null);
  const list = chat.data?.messages;
  const max = chat.data?.maxLength ?? 300;
  const lastId = list?.[list.length - 1]?.id;

  // Keep the newest message in view when one arrives.
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [lastId]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const clean = text.trim();
    if (!clean) return;
    setBusy(true);
    if (await run(() => api.sendChat(clean))) setText('');
    await chat.reload();
    setBusy(false);
  }

  return (
    <>
      <PageHead title="Family chat" sub="Your kids write from the home screen of their device. Only your family is in this chat." />
      {!list && (chat.error ? <ErrorBox message={chat.error} onRetry={() => void chat.reload()} /> : <Loading label="Loading the chat" />)}
      {list && (
        <Card title="Messages">
          {chat.error && <StaleNote message={chat.error} />}
          {list.length === 0 ? <p className="empty">No messages yet. Say hello: your kids see it on their home screen.</p> : (
            <ol className="bubbles chat-box" aria-label="Family chat messages" tabIndex={0}>
              {list.map((m, i) => (
                <li key={m.id} ref={i === list.length - 1 ? end : undefined} className={`bubble ${m.kidId ? 'in' : 'out'}`}>
                  <div className="chat-meta">
                    <span className="tiny muted">
                      {m.kidId && <span className="dot" style={{ background: safeColor(m.color ?? '#8e9ac0'), marginRight: 6 }} aria-hidden="true" />}
                      {m.kidId ? m.from : 'You (parent)'} · {timeAgo(m.at)}
                    </span>
                    <button type="button" className="link-btn tiny" aria-label={`Remove the message from ${m.from}: ${m.text.slice(0, 40)}`} onClick={() => setRemoving(m)}>
                      <Icon d={ICON.trash} size={14} />
                    </button>
                  </div>
                  <div style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{m.text}</div>
                </li>
              ))}
            </ol>
          )}
          <form className="chat-form" onSubmit={(e) => void send(e)}>
            <label htmlFor={input} className="sr-only">Message to the family</label>
            <input id={input} className="input" value={text} maxLength={max} autoComplete="off" placeholder="Write to the family" onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button>
          </form>
          <p className="tiny muted">Messages can be {max} characters long. Kids see the last 7 days on their device; this page shows the last 30.</p>
        </Card>
      )}
      <Confirm open={removing !== null} title="Remove this message?" confirmLabel="Remove message" danger busy={busy}
        body={<>It disappears here and on your kids' devices: “{removing?.text.slice(0, 120)}”</>}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          const m = removing;
          setBusy(true);
          void run(() => api.deleteChat(m.id), 'The message was removed.').then(async () => { await chat.reload(); setBusy(false); setRemoving(null); });
        }} />
    </>
  );
}
