// The kids' texting app (Family Screen Warden, TextsActivity). The phone sends the state (window.__texts) and this page
// sends commands (ScreenWardenTexts.post). Opened in a browser it shows made-up texts (?view=chat|new|ask, &bed).
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const BRIDGE = window.ScreenWardenTexts;
const post = (o) => (BRIDGE ? BRIDGE.post(JSON.stringify(o)) : demo(o));

let S = { chats: [], contacts: { family: [], friends: [], asked: [] }, locked: false };
let view = 'list';
let picked = new Set();
let picks = [];
let draftNums = null;

// ---------------------------------------------------------------------------------------------- little helpers
const TINTS = 6; // the launcher's six brand tints (texts.css .tint0 to .tint5), picked by name
function tint(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `tint${h % TINTS}`; }
const initial = (n) => (String(n).trim().match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
function av(people, small) {
  const cls = small ? 'av sm' : 'av';
  if (people.length > 1 && !small) {
    const [a, b] = people;
    return `<div class="av duo"><i class="${tint(a.name)}">${esc(initial(a.name))}</i><i class="${tint(b.name)}">${esc(initial(b.name))}</i></div>`;
  }
  const p = people[0] ?? { name: '?' };
  return `<div class="${cls} ${tint(p.name)}">${esc(initial(p.name))}</div>`;
}
function when(ms) {
  const d = new Date(ms), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function dayLabel(ms) {
  const d = new Date(ms);
  const days = Math.floor((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400000);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today ${t}`;
  if (days === 1) return `Yesterday ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${t}`;
}
let toastT;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 3200); }
function show(v) {
  view = v;
  for (const s of document.querySelectorAll('.view')) s.classList.toggle('on', s.id === `v-${v}`);
}
const backAt = () => {
  if (S.lockReason === 'bedtime' && S.until) return `back at ${new Date(S.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (S.lockReason === 'time') return 'back tomorrow';
  return 'back when a grown-up unlocks the phone';
};

// ---------------------------------------------------------------------------------------------- the chats
function renderList() {
  const lc = $('lockcard');
  lc.classList.toggle('hidden', !S.locked);
  if (S.locked) {
    $('lock-title').textContent = S.lockReason === 'bedtime' ? "It's bedtime" : S.lockReason === 'time' ? "Time's up for today" : 'The phone is locked';
    $('lock-text').textContent = `You can still text family. Friends are ${backAt()}.`;
  }
  const q = $('q').value.trim().toLowerCase();
  const chats = S.chats.filter((c) => !q || c.title.toLowerCase().includes(q) || (c.last.body ?? '').toLowerCase().includes(q));
  const fam = chats.filter((c) => c.family);
  const fr = chats.filter((c) => !c.family);
  const row = (c) => {
    const wait = c.status === 'waiting';
    const last = wait ? (c.unread ? `${c.unread} new text${c.unread > 1 ? 's' : ''}, waiting` : `Texting is ${backAt()}`) : c.last.photo && !c.last.body ? 'Photo' : c.last.body;
    const by = !wait && c.last.dir === 'out' ? 'You: ' : !wait && c.people.length > 1 && c.last.fromName ? `${c.last.fromName.split(' ')[0]}: ` : '';
    const tail = wait ? '<svg class="lockico" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>' : c.unread ? `<span class="badge">${c.unread}</span>` : '';
    return `<button class="chat ${c.unread && !wait ? 'unread' : ''} ${wait ? 'wait' : ''}" data-thread="${esc(c.thread)}">${av(c.people)}
      <div class="mid"><div class="l1"><b>${esc(c.title)}</b><span>${wait ? '' : esc(when(c.last.at))}</span></div><div class="l2">${esc(by + (last ?? ''))}</div></div>${tail}</button>`;
  };
  const asked = (S.contacts.asked ?? []).filter((a) => a.status === 'pending');
  const denied = (S.contacts.asked ?? []).filter((a) => a.status === 'denied');
  let h = fam.map(row).join('');
  if (fr.length || asked.length || denied.length) h += `<div class="sec">Friends${S.locked ? ` · ${backAt()}` : ''}</div>` + fr.map(row).join('');
  h += asked.map((a) => `<div class="chat asked"><div class="av plain"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div>
    <div class="mid"><div class="l1"><b>${esc(a.name)}</b></div><div class="l2">Waiting for a grown-up to say yes</div></div></div>`).join('');
  h += denied.map((a) => `<div class="chat wait"><div class="av plain">${esc(initial(a.name))}</div>
    <div class="mid"><div class="l1"><b>${esc(a.name)}</b></div><div class="l2">A grown-up said no</div></div></div>`).join('');
  if (!chats.length && !asked.length) h += `<div class="empty">${q ? 'Nothing found.' : 'No texts yet. Tap “New text” to text your family.'}</div>`;
  if (S.held) h += '<div class="note">A number that isn\'t on your list texted you. It went to your grown-ups instead.</div>';
  $('chats').innerHTML = h;
}

// ---------------------------------------------------------------------------------------------- one chat
let shownThread = null;
function renderChat() {
  const o = S.open;
  if (!o) return;
  const fresh = shownThread !== o.thread;
  shownThread = o.thread;
  $('c-title').textContent = o.title;
  $('c-sub').textContent = o.people.length > 1 ? o.people.map((p) => p.name).join(', ') + ' and you' : '';
  $('c-call').classList.toggle('hidden', o.people.length !== 1);
  $('t').placeholder = `Text ${o.people.length > 1 ? o.title : o.people[0]?.name ?? ''}`;
  const box = $('msgs');
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  let h = '';
  let lastAt = 0;
  const group = o.people.length > 1;
  for (const m of o.texts) {
    if (m.at - lastAt > 3600_000) h += `<div class="day">${esc(dayLabel(m.at))}</div>`;
    lastAt = m.at;
    const pics = m.media.filter((x) => x.type.startsWith('image/')).map((x) => `<img class="pic" src="${esc(x.url)}" alt="Photo" loading="lazy">`).join('');
    const other = m.media.filter((x) => !x.type.startsWith('image/')).length ? '<div class="bub">[A video or sound clip]</div>' : '';
    const body = m.body ? `<div class="bub">${esc(m.body)}</div>` : '';
    const st = m.dir === 'out' ? (m.sent === 'sending' ? '<span class="st">Sending…</span>' : m.sent === 'failed' ? `<span class="st fail">Didn't send · <button data-retry="${esc(m.id)}">Try again</button></span>` : '') : '';
    if (m.dir === 'out') h += `<div class="m out"><div class="col">${pics}${body}${other}${st}</div></div>`;
    else h += `<div class="m">${group ? av([{ name: m.fromName ?? '?' }], true) : ''}<div class="col">${group ? `<span class="name">${esc(m.fromName ?? '')}</span>` : ''}${pics}${body}${other}</div></div>`;
  }
  if (!o.texts.length) h += '<div class="empty">Say hi!</div>';
  box.innerHTML = h;
  if (fresh || atEnd) box.scrollTop = box.scrollHeight;
}

function openThread(t, nums) {
  draftNums = nums ?? S.chats.find((c) => c.thread === t)?.nums ?? null;
  post({ cmd: 'open', thread: t });
}

// ---------------------------------------------------------------------------------------------- new text
function renderPeople() {
  const fam = S.contacts.family ?? [];
  const fr = S.contacts.friends ?? [];
  const row = (p, can) => `<button class="person ${picked.has(p.key) ? 'on' : ''}" data-key="${esc(p.key)}" ${can ? '' : 'disabled'}>${av([p])}<b>${esc(p.name)}</b>${can ? '' : `<small>${esc(backAt())}</small>`}<span class="tick"></span></button>`;
  let h = '<div class="sec">Family</div>' + (fam.length ? fam.map((p) => row(p, !S.locked || p.always)).join('') : '<div class="empty">No family contacts yet. A grown-up adds them in the parent console.</div>');
  h += '<div class="sec">Friends</div>' + (fr.length ? fr.map((p) => row(p, !S.locked)).join('') : '<div class="empty small">No friends yet. Tap “Ask to add a friend”.</div>');
  $('people').innerHTML = h;
  $('n-go').disabled = !picked.size;
  $('n-go').textContent = picked.size > 1 ? `Group text (${picked.size})` : 'Text';
}

// ---------------------------------------------------------------------------------------------- the composer
function renderPicks() {
  $('picks').classList.toggle('hidden', !picks.length);
  $('picks').innerHTML = picks.map((p) => `<div class="p"><img src="${esc(p.url)}" alt="Photo to send"><button data-unpick="${esc(p.id)}" aria-label="Remove photo">×</button></div>`).join('');
}
const EMOJI = ['😀', '😂', '😍', '🥰', '😎', '🤔', '😢', '😡', '👍', '👎', '🙏', '👏', '❤️', '💜', '🎉', '🔥', '⭐', '🐶', '🐱', '🦄', '🍕', '🌮', '⚽', '🎮'];
$('emoji').innerHTML = EMOJI.map((e) => `<button data-emoji="${e}">${e}</button>`).join('');
const ta = $('t');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });

function sendNow() {
  const o = S.open;
  if (!o) return;
  const text = ta.value.trim();
  if (!text && !picks.length) return;
  const nums = draftNums ?? S.chats.find((c) => c.thread === o.thread)?.nums ?? o.thread.split(',');
  post({ cmd: 'send', nums, text, photos: picks.map((p) => p.id) });
}

// ---------------------------------------------------------------------------------------------- events
document.addEventListener('click', (e) => {
  const t = e.target.closest('button,[data-close]');
  if (!t) return;
  if (t.hasAttribute('data-close')) return t.closest('.sheet').classList.remove('show');
  if (t.dataset.thread) return openThread(t.dataset.thread);
  if (t.dataset.key) { picked.has(t.dataset.key) ? picked.delete(t.dataset.key) : picked.add(t.dataset.key); return renderPeople(); }
  if (t.dataset.quick) { ta.value = (ta.value ? ta.value + ' ' : '') + t.dataset.quick; ta.focus(); return; }
  if (t.dataset.emoji) { ta.value += t.dataset.emoji; return; }
  if (t.dataset.retry) return post({ cmd: 'retry', id: t.dataset.retry });
  if (t.dataset.unpick) { post({ cmd: 'unpick', id: t.dataset.unpick }); picks = picks.filter((p) => p.id !== t.dataset.unpick); return renderPicks(); }
  if (t.dataset.photo) { post({ cmd: 'pick', id: t.dataset.photo }); $('sheet-gallery').classList.remove('show'); return; }
  switch (t.dataset.act) {
    case 'home': return post({ cmd: 'home' });
    case 'back': return back();
    case 'new': picked = new Set(); renderPeople(); return show('new');
    case 'start': {
      const all = [...(S.contacts.family ?? []), ...(S.contacts.friends ?? [])];
      const chosen = all.filter((p) => picked.has(p.key));
      if (!chosen.length) return;
      const thread = chosen.map((p) => p.key).sort().join(',');
      return openThread(thread, chosen.map((p) => p.phone));
    }
    case 'ask': $('a-msg').textContent = ''; $('a-name').value = ''; $('a-phone').value = ''; $('a-note').value = ''; $('sheet-ask').classList.add('show'); return;
    case 'ask-send': {
      const name = $('a-name').value.trim(), phone = $('a-phone').value.trim();
      if (!name || phone.replace(/\D/g, '').length < 3) { $('a-msg').textContent = 'Type your friend\'s name and phone number.'; return; }
      $('a-msg').textContent = 'Sending…';
      return post({ cmd: 'ask', name, phone, note: $('a-note').value.trim() });
    }
    case 'send': return sendNow();
    case 'gallery': $('grid').innerHTML = '<div class="empty wide">Loading pictures…</div>'; $('sheet-gallery').classList.add('show'); return post({ cmd: 'gallery' });
    case 'camera': return post({ cmd: 'camera' });
    case 'emoji': return $('emoji').classList.toggle('hidden');
    case 'call': { const n = (draftNums ?? S.chats.find((c) => c.thread === S.open?.thread)?.nums ?? [])[0]; if (n) post({ cmd: 'call', num: n }); return; }
  }
});
$('q').addEventListener('input', renderList);

function back() {
  const sh = document.querySelector('.sheet.show');
  if (sh) { sh.classList.remove('show'); return true; }
  if (view === 'chat') { post({ cmd: 'close' }); shownThread = null; picks = []; renderPicks(); $('emoji').classList.add('hidden'); show('list'); return true; }
  if (view === 'new') { show('list'); return true; }
  return false;
}
window.__back = back;

// ---------------------------------------------------------------------------------------------- from the phone
window.__texts = (m) => {
  switch (m.type) {
    case 'state':
      S = m;
      renderList();
      if (view === 'new') renderPeople();
      if (m.open) { if (view !== 'chat') { show('chat'); ta.value = ta.value || ''; } renderChat(); }
      else if (view === 'chat') show('list');
      break;
    case 'go':
      if (m.text) ta.value = m.text;
      if (m.thread) openThread(m.thread, m.nums);
      else if (m.newText) { if (view === 'chat') { post({ cmd: 'close' }); shownThread = null; } picked = new Set(); renderPeople(); show('new'); }
      break;
    case 'sent': ta.value = ''; ta.style.height = 'auto'; picks = []; renderPicks(); $('emoji').classList.add('hidden'); break;
    case 'toast': toast(m.text); break;
    case 'gallery':
      $('grid').innerHTML = m.photos.length ? m.photos.map((id) => `<button data-photo="${id}" aria-label="Photo"><img src="https://gallery.screenwarden/${id}" alt="" loading="lazy"></button>`).join('') : '<div class="empty wide">No pictures on this phone yet. Use the camera button.</div>';
      break;
    case 'picked': picks.push({ id: m.id, url: m.url }); renderPicks(); break;
    case 'asked': $('a-msg').textContent = m.message; setTimeout(() => $('sheet-ask').classList.remove('show'), 1800); toast(m.message); break;
  }
};

post({ cmd: 'hello' });

// ---------------------------------------------------------------------------------------------- a made-up phone (browser preview)
function demo(o) {
  const u = new URLSearchParams(location.search);
  const bed = u.has('bed');
  const now = Date.now();
  const family = [
    { name: 'Mom', phone: '(555) 010-2231', key: '5550102231', always: true },
    { name: 'Dad', phone: '(555) 010-2232', key: '5550102232', always: true },
    { name: 'Grandma', phone: '(555) 010-2233', key: '5550102233', always: true },
  ];
  const friends = [{ name: 'Jake', phone: '(555) 016-4410', key: '5550164410' }];
  const P = (k) => [...family, ...friends].find((p) => p.key === k);
  const chat = (thread, title, last, unread, fam) => ({
    thread, title, unread, family: fam, status: bed && !fam ? 'waiting' : 'shown', nums: thread.split(','), people: thread.split(',').map((k) => ({ key: k, name: P(k)?.name ?? k })), last,
  });
  const group = '5550102231,5550102232,5550102233';
  const D = window.__demo ?? (window.__demo = {
    chats: [
      chat(group, 'Family', { dir: 'in', at: now - 3 * 60000, body: '', photo: true, fromName: 'Mom' }, 2, true),
      chat('5550102231', 'Mom', { dir: 'in', at: now - 95 * 60000, body: "Don't forget your jacket!" }, 0, true),
      chat('5550102232', 'Dad', { dir: 'out', at: now - 26 * 3600000, body: 'Can we get pizza?' }, 0, true),
      chat('5550102233', 'Grandma', { dir: 'in', at: now - 4 * 86400000, body: 'Love you sweetie' }, 0, true),
      chat('5550164410', 'Jake', { dir: 'in', at: now - 3 * 86400000, body: 'see u at practice' }, bed ? 1 : 0, false),
    ],
    texts: [
      { id: 'a', dir: 'in', at: now - 15 * 60000, body: 'Who wants tacos tonight?', fromName: 'Dad', media: [], sent: 'ok' },
      { id: 'b', dir: 'out', at: now - 14 * 60000, body: 'Me!! extra cheese please 🧀', media: [], sent: 'ok' },
      { id: 'c', dir: 'in', at: now - 4 * 60000, body: 'Look who found the cat toy', fromName: 'Mom', media: [{ type: 'image/jpeg', url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="440" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fcd34d"/><stop offset="1" stop-color="#fb7185"/></linearGradient></defs><rect width="440" height="320" fill="url(#g)"/><circle cx="220" cy="175" r="80" fill="#78350f" opacity=".35"/><text x="220" y="300" font-size="22" text-anchor="middle" fill="#fff" font-family="sans-serif">[photo]</text></svg>') }], sent: 'ok' },
      { id: 'd', dir: 'in', at: now - 3 * 60000, body: 'So cute! See you Sunday', fromName: 'Grandma', media: [], sent: 'ok' },
    ],
  });
  const state = (open) => ({
    type: 'state', me: 'Mia', locked: bed, lockReason: bed ? 'bedtime' : undefined, until: bed ? new Date(new Date().setHours(31, 0, 0, 0)).toISOString() : undefined,
    contacts: { family, friends, asked: bed ? [] : [{ name: 'Ava', phone: '(555) 014-2290', key: '5550142290', status: 'pending' }] },
    chats: D.chats, held: !bed,
    open: open ? { thread: open, title: D.chats.find((c) => c.thread === open)?.title ?? 'Family', status: 'shown', people: open.split(',').map((k) => ({ key: k, name: P(k)?.name ?? k })), texts: open === group ? D.texts : [] } : undefined,
  });
  setTimeout(() => {
    if (o.cmd === 'hello') {
      window.__texts(state(null));
      const v = u.get('view');
      if (v === 'chat') window.__texts(state(group));
      if (v === 'new' || v === 'ask') { document.querySelector('[data-act=new]').click(); picked.add('5550102231'); picked.add('5550164410'); renderPeople(); }
      if (v === 'ask') { document.querySelector('[data-act=ask]').click(); $('a-name').value = 'Ava'; $('a-phone').value = '(555) 014-2290'; $('a-note').value = "She's in my class"; }
    }
    if (o.cmd === 'open') window.__texts(state(o.thread));
    if (o.cmd === 'close') window.__texts(state(null));
    if (o.cmd === 'home') toast('(Back to the launcher)');
    if (o.cmd === 'send') { D.texts.push({ id: String(Math.random()), dir: 'out', at: Date.now(), body: o.text, media: [], sent: 'ok' }); window.__texts({ type: 'sent' }); window.__texts(state(o.nums.length > 1 ? group : D.chats[0].thread)); }
    if (o.cmd === 'gallery') window.__texts({ type: 'gallery', photos: [] });
    if (o.cmd === 'ask') window.__texts({ type: 'asked', message: 'Sent to your grown-ups. Once they say yes, you can text your friend.' });
    if (o.cmd === 'camera') toast('(The camera opens on the phone)');
  }, 10);
}
