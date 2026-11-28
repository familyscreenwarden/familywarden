// Family Screen Warden launcher: the kid's home screen, on a Windows PC and on an Android phone. The app sends the
// state every second ({type:'state', ...}, through WebView2 on Windows or the Android bridge in android.js);
// everything the kid taps goes back as {cmd:...}. Opened in a normal browser (no app), it shows sample data so the
// look can be checked. The page never talks to the server itself and loads nothing from the internet.
const wv = window.chrome && window.chrome.webview;
const params = new URLSearchParams(location.search);
const MODE = params.has('bar') ? 'bar' : wv ? 'launcher' : 'preview';
document.body.dataset.mode = MODE;
// A kid's Android phone (the app opens index.html?phone): the bar is part of this page, plus family calls and texts.
const PHONE = params.has('phone');
document.body.dataset.phone = PHONE ? '1' : '';
const DEV = PHONE ? 'phone' : 'computer';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const send = (msg) => (wv ? wv.postMessage(msg) : demoHandle(msg));

let S = null; // the latest state
let look = null; // the kid's pending colour change (shown right away, until the server agrees)
let cat = 'all';

// ------------------------------------------------------------------ helpers
/** "20 min", "1 h 05 m" (labels on tiles and in sentences). */
const span = (sec) => {
  const m = Math.max(0, Math.ceil(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m` : `${m} min`;
};
/** "0:55" (the big numbers). */
const clock = (sec) => {
  const m = Math.max(0, Math.ceil(sec / 60));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { weekday: 'long' });
};
const timeOf = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
const CATS = { all: 'All', games: 'Games', school: 'School', web: 'Websites', other: 'More' };
const catOf = (c) => (c === 'game' || c === 'launcher' ? 'games' : c === 'school' ? 'school' : 'other');
// Line drawings for the app's own tiles (Texts, Camera, Movie Maker).
const glyph = (d) => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const GLYPH = {
  texts: glyph('<path d="M4 5h16v11H9l-5 4z"/>'),
  camera: glyph('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  movies: glyph('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'),
};
const TINTS = 6; // tiles take the six brand tints in turn (by their place in the whole list, so a search keeps them)
let toastT = 0;
function toast(t) {
  const e = $('toast');
  e.textContent = t;
  e.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => e.classList.remove('show'), 3200);
}

/** Sets a list's HTML only when it changed (the app sends its state every second). */
function setHtml(el, html) {
  if (el._html === html) return;
  el.innerHTML = html;
  el._html = html;
}
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

// ------------------------------------------------------------------ the tiles (apps and websites)
function items() {
  if (!S) return [];
  const st = S.status || {}, L = S.launcher || {}, tiles = S.tiles || {}, siteIcons = S.siteIcons || {};
  const left = new Map((st.apps || []).map((a) => [a.key, a]));
  const blocked = new Set(st.blockedAppKeys || []);
  const out = [];
  for (const a of L.apps || []) {
    if (a.category === 'system') continue;
    const t = tiles[a.key] || {};
    if (t.found === false) continue; // allowed, but not on this device
    const lim = left.get(a.key);
    const locked = blocked.has(a.key);
    let status = 'Uses your time';
    if (locked) status = PHONE ? 'Used up' : 'Used up for today';
    else if (lim) status = `${span(lim.secondsLeft)} left`;
    else if (a.free) status = 'Free';
    out.push({ key: a.key, name: a.name, cat: catOf(a.category), web: false, icon: t.icon, status, locked, low: !locked && !!lim && lim.secondsLeft <= 5 * 60 });
  }
  for (const s of L.sites || []) {
    const t = siteIcons[s.host] || {};
    out.push({ key: 'site:' + s.host, host: s.host, name: s.tile || s.host, cat: 'web', web: true, icon: t.icon, status: 'Website', locked: false, low: false });
  }
  // A phone: the app's own Texts, Camera and Movie Maker are tiles too, first in the list. They never use time.
  if (PHONE && S.phone?.texts) {
    const n = S.phone.textsUnread || 0;
    out.push({ key: 'sw-texts', name: 'Texts', cat: 'other', web: false, status: n ? `${n} new` : 'Free', locked: false, low: n > 0, own: 1, cmd: 'texts', glyph: GLYPH.texts });
    out.push({ key: 'sw-camera', name: 'Camera', cat: 'other', web: false, status: 'Free', locked: false, low: false, own: 2, cmd: 'camera', glyph: GLYPH.camera });
    out.push({ key: 'sw-movies', name: 'Movie Maker', cat: 'other', web: false, status: 'Free', locked: false, low: false, own: 3, cmd: 'movies', glyph: GLYPH.movies });
  }
  out.sort((a, b) => ((a.own || 9) - (b.own || 9)) || a.name.localeCompare(b.name));
  out.forEach((it, i) => (it.tint = i % TINTS));
  return out;
}

const query = () => $('q').value.trim().toLowerCase();
const match = (it, q, c) => (c === 'all' || it.cat === c) && (!q || `${it.name} ${it.host || ''}`.toLowerCase().includes(q));
const initials = (n) => {
  const w = String(n || '').split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).replace(/^./, (c) => c.toUpperCase());
};

function renderTiles() {
  const q = query(), all = items();
  const cats = Object.keys(CATS).filter((k) => k === 'all' || all.some((i) => i.cat === k));
  if (!cats.includes(cat)) cat = 'all';
  const list = all.filter((i) => match(i, q, cat));
  const tile = (it) => `<button class="tile ${it.locked ? 'locked' : `tint${it.tint}`}" data-open="${esc(it.key)}">
    <span class="ti ${it.icon ? 'img' : ''}">${it.icon ? `<img src="${esc(it.icon)}" alt="">` : it.glyph || esc(initials(it.name))}</span>
    <span class="tt"><span class="tn">${esc(it.name)}</span><span class="ts ${it.low ? 'low' : ''}">${esc(it.status)}</span></span></button>`;
  const askTile = q ? '' : `<button class="tile asktile" data-act="ask-app"><span class="ti">+</span><span class="tt"><span class="tn">Ask for an app</span><span class="ts">${PHONE ? 'Parent decides' : 'A grown-up decides'}</span></span></button>`;
  setHtml($('grid'), list.map(tile).join('') + (list.length || !q ? askTile : ''));
  $('empty').classList.toggle('hidden', !!list.length || !q);
  setHtml($('cats'), cats.length > 2 ? cats.map((k) => `<button class="chip ${k === cat ? 'on' : ''}" data-cat="${k}">${CATS[k]}</button>`).join('') : '');
  // On a phone the chips only help when there are more tiles than fit on the screen.
  $('cats').classList.toggle('hidden', cats.length <= 2 || (PHONE && all.length <= 9));
}

// ------------------------------------------------------------------ header, time, chores, today
function timeNow() {
  const st = S.status || {};
  if (st.state === 'paused') return { big: 'Paused', label: 'The clock is paused', short: 'paused' };
  if (st.state === 'pass') return { big: clock(st.passSecondsLeft || 0), label: 'Unlocked by a grown-up', short: `${clock(st.passSecondsLeft || 0)} unlocked` };
  const left = st.generalSecondsLeft || 0;
  return { big: clock(left), label: 'Time left today', short: `${clock(left)} left` };
}

function choreRows() {
  const chores = S.launcher?.info?.chores || [];
  return chores.map((c) => {
    const done = c.status === 'done', wait = c.status === 'waiting';
    return `<button class="chore ${done ? 'done' : wait ? 'wait' : ''}" data-chore="${esc(c.id)}" ${done || wait ? 'disabled' : ''}>
      <span class="chk" aria-hidden="true">${done ? '✓' : wait ? '…' : ''}</span>
      <span class="ct">${esc(c.title)}<small>${done ? 'Approved' : wait ? 'Waiting for a grown-up' : 'Tap when done'}</small></span>
      ${c.minutes ? `<span class="tag">+${esc(c.minutes)} min</span>` : ''}</button>`;
  }).join('');
}

function renderShared() {
  const st = S.status || {}, info = S.launcher?.info || {}, kid = info.kid || {};
  const name = kid.name || st.kid || '';
  setText($('hello'), name ? `Hi ${name}` : 'Hi');
  const now = new Date();
  setText($('day'), info.dayText || `${now.toLocaleDateString([], { weekday: 'long' })}, ${timeOf(now)}`);
  setText($('avatar'), kid.emoji || (name ? name[0].toUpperCase() : ''));
  $('avatar').classList.toggle('hidden', !kid.emoji && !name);

  // Time left today
  const t = timeNow();
  setText($('t-left'), t.big);
  setText(document.querySelector('#timecard .lbl'), t.label);
  const left = st.generalSecondsLeft || 0;
  const total = Math.max(st.totalSeconds || 0, left, 60);
  const usedPct = st.state === 'ok' || st.state === 'locked' ? Math.round((100 * (total - left)) / total) : 0;
  $('t-bar').style.width = `${Math.max(0, Math.min(100, usedPct))}%`;
  $('t-meter').setAttribute('aria-label', st.state === 'ok' ? `${span(total - left)} of ${span(total)} used` : t.label);
  $('timecard').classList.toggle('low', st.state === 'ok' && left <= 10 * 60);
  setText($('t-note'), PHONE ? 'The home screen and calls are free' : '');
  setText($('t-bed'), info.bedtimeText || '');
  $('offline').classList.toggle('show', !!st.offline);

  // Chores ("Earn more time"): the card on the home screen, and the same list in a dialog (from the lock screen).
  const chores = info.chores || [];
  const rows = choreRows();
  setHtml($('chores'), rows);
  setHtml($('d-chores-list'), rows || '<div class="none">No chores for today.</div>');
  $('chorescard').classList.toggle('hidden', !chores.length);
  setText($('chore-mins'), info.choreMinutes ? `+${info.choreMinutes} min each` : '');
  $('chore-mins').classList.toggle('hidden', !info.choreMinutes);
  const todo = chores.filter((c) => c.status === 'todo').length;
  setText($('d-chores-p'), `Finish a chore, a grown-up checks it, and you get more ${DEV} time.${chores.length ? ` ${todo} left today.` : ''}`);
  $('lock-chores').classList.toggle('hidden', !chores.length);

  renderChat(info);

  // Today: time per limited app
  const today = (st.apps || []).map((a) => {
    const limited = a.kind === 'limit' && a.limitMinutes > 0;
    const used = limited ? Math.max(0, a.limitMinutes * 60 - a.secondsLeft) : 0;
    const text = limited ? `${Math.round(used / 60)} of ${a.limitMinutes} min` : `${span(a.secondsLeft)} left`;
    return `<div class="use ${a.secondsLeft <= 0 ? 'out' : ''}"><span>${esc(a.name)}</span><span>${esc(text)}</span></div>`;
  }).join('');
  setHtml($('today'), today);
  $('todaycard').classList.toggle('hidden', !today);
}

// ------------------------------------------------------------------ family chat
// info.chat = [{ id, who, mine, emoji, color, text, at }] from the server; a message goes out as the launcher action
// { action: 'chat', text }. The card only shows when the server sends a chat list.
let seenChat = null; // the newest message from someone else that the kid has seen (for the "New" tag)
const lastChatId = (chat) => { const m = chat.filter((c) => !c.mine); return m.length ? String(m[m.length - 1].id) : ''; };
function renderChat(info) {
  const has = Array.isArray(info.chat), chat = has ? info.chat : [];
  $('chatcard').classList.toggle('hidden', !has);
  const msg = (c) => `<div class="chat-msg ${c.mine ? 'mine' : ''}"><small><b>${esc(c.mine ? 'You' : c.who)}</b> · ${esc(timeOf(new Date(c.at)))}</small>${esc(c.text)}</div>`;
  setHtml($('chat-peek'), chat.length ? chat.slice(-2).map(msg).join('') : '<div class="none">No messages yet. Say hi to your family.</div>');
  const key = chat.map((c) => c.id).join();
  const list = $('chat-list');
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    setHtml(list, chat.length ? chat.map(msg).join('') : '<div class="none">No messages yet.</div>');
    list.scrollTop = list.scrollHeight;
  }
  if (seenChat === null || $('d-chat').classList.contains('show')) seenChat = lastChatId(chat);
  $('chat-new').classList.toggle('hidden', lastChatId(chat) === seenChat);
}

// ------------------------------------------------------------------ time's up / bedtime / locked by a grown-up
function renderLock() {
  const st = S.status || {};
  const locked = st.state === 'locked';
  $('lock').classList.toggle('show', locked && MODE !== 'bar');
  const night = locked && st.lockReason === 'bedtime';
  $('lock').classList.toggle('night', night);
  if (!locked) return;
  const name = S.launcher?.info?.kid?.name || st.kid || '';
  if (night) {
    setText($('n-clock'), timeOf(new Date()));
    setText($('lock-h'), name ? `Good night, ${name}` : 'Good night');
    const until = st.bedtimeUntil ? new Date(st.bedtimeUntil) : null;
    setText($('lock-p'), until && !isNaN(until) ? `The ${DEV} opens again at ${timeOf(until)}.` : `The ${DEV} opens again in the morning.`);
  } else if (st.lockReason === 'parent') {
    setText($('lock-h'), `A grown-up locked this ${DEV}`);
    setText($('lock-p'), 'It unlocks when they say so, or with a code from them.');
  } else {
    setText($('lock-h'), 'Time is up for today');
    const back = st.dayEndsAt ? new Date(st.dayEndsAt) : null;
    const when = back && !isNaN(back) && back.getTime() > Date.now() ? ` at ${timeOf(back)}` : '';
    setText($('lock-p'), `${name ? `Nice work today, ${name}. ` : ''}Your ${PHONE ? 'apps come' : 'computer time comes'} back tomorrow${when}.`);
  }
}

// ------------------------------------------------------------------ the bar at the bottom (computers)
function renderBar() {
  const st = S.status || {};
  setText($('bar-time'), timeNow().short);
  $('bar-time').classList.toggle('low', st.state === 'ok' && (st.generalSecondsLeft || 0) <= 10 * 60);
  const sys = S.sys || {};
  setText($('bar-wifi'), sys.wifi?.connected === false ? 'No internet' : 'Wi-Fi on');
  $('bar-wifi').classList.toggle('bad', sys.wifi?.connected === false);
  setText($('bar-vol'), sys.volume?.muted ? 'Sound off' : `Sound ${sys.volume?.level ?? 50}%`);
  setText($('bar-clock'), timeOf(new Date()));
  const wins = S.windows || [];
  setHtml($('bar-apps'), wins.map((w) => `<button class="btn mb-app ${w.active ? 'on' : ''}" data-win="${esc(w.id)}" title="${esc(w.title)}">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}<span>${esc(w.title)}</span></button>`).join(''));
}

// ------------------------------------------------------------------ colours
// One look. The server keeps a layout name and a theme name per kid (the names come from the first launcher); the
// layout is ignored here, and the four theme names pick the accent colour. Anything else shows the Warden green.
const THEMES = [['galaxy', 'Warden green', '#34d399'], ['ocean', 'Periwinkle', '#4f61b8'], ['jungle', 'Teal', '#2dd4bf'], ['sunset', 'Coral', '#fb7185']];
let parentPin = null; // the PIN a grown-up just typed (only kept while their menu is open)
function applyLook() {
  const s = S.launcher?.settings || {};
  const T = look?.theme || s.theme || 'galaxy';
  if (look && s.theme === look.theme) look = null;
  document.documentElement.dataset.theme = THEMES.some(([k]) => k === T) && T !== 'galaxy' ? T : 'warden';
}
function renderLookDialog() {
  const s = S.launcher?.settings || {};
  const T = look?.theme || s.theme || 'galaxy';
  const cur = THEMES.some(([k]) => k === T) ? T : 'galaxy';
  const lockedForKid = s.lookLocked && !parentPin;
  $('d-look-p').textContent = lockedForKid ? 'A grown-up picked these colours. Ask them to change it.' : 'The accent colour for your home screen.';
  $('d-themes').innerHTML = THEMES.map(([k, n, c]) => `<button class="btn ${k === cur ? 'on' : ''}" data-theme="${k}" ${lockedForKid ? 'disabled' : ''}><i style="background:${c}"></i>${n}</button>`).join('');
}
function setLook(theme) {
  const s = S.launcher?.settings || {};
  look = { theme };
  applyLook();
  renderLookDialog();
  const act = { action: 'look', layout: s.layout || 'bright', theme };
  send(parentPin ? { cmd: 'parent', code: parentPin, act } : { cmd: 'act', act });
}

// ------------------------------------------------------------------ dialogs
const open = (id) => { closeAll(); document.activeElement?.blur?.(); $(id).classList.add('show'); if (MODE === 'launcher') send({ cmd: 'front' }); };
function closeAll() { document.querySelectorAll('.ov.show').forEach((o) => o.classList.remove('show')); $('pwrmenu').classList.remove('show'); stopPower(); }
let pin = '', pinFor = 'menu';
function openPin(forWhat = 'menu') {
  pin = ''; pinFor = forWhat; $('d-pin-msg').textContent = '';
  $('d-dots').innerHTML = '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>';
  dots(); open('d-pin');
}
function dots() { [...$('d-dots').children].forEach((d, i) => { d.classList.toggle('f', i < pin.length); d.style.display = i < Math.max(4, pin.length) ? '' : 'none'; }); }
const PAD = [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6'], ['7', '7'], ['8', '8'], ['9', '9'], ['del', 'Delete'], ['0', '0'], ['ok', 'OK']];
$('d-pad').innerHTML = PAD.map(([k, n]) => `<button class="btn ${k === 'ok' ? 'pri' : ''}" data-key="${k}">${n}</button>`).join('');
$('d-pad').onclick = (e) => {
  const k = e.target.closest('[data-key]')?.dataset.key;
  if (!k) return;
  if (k === 'del') pin = pin.slice(0, -1);
  else if (k === 'ok') { if (pin.length >= 4) send({ cmd: 'pin', code: pin }); }
  else if (pin.length < 8) pin += k;
  dots();
};
let powerT = 0, powerKind = '';
function power(kind) {
  powerKind = kind;
  if (PHONE) {
    $('d-power-h').textContent = kind === 'sleep' ? 'Turn the screen off?' : 'Restart the phone?';
    $('d-power-p').textContent = kind === 'sleep' ? 'Your apps stay open.' : 'Save your game first! Open apps will close.';
    $('d-power-go').textContent = kind === 'sleep' ? 'Screen off now' : 'Restart now';
  } else {
    $('d-power-h').textContent = kind === 'sleep' ? 'Put the PC to sleep?' : 'Shut down the PC?';
    $('d-power-p').textContent = kind === 'sleep' ? 'Your apps stay open. Your computer time pauses while it sleeps.' : 'Save your game first! Open apps will close. Your computer time stops counting while the PC is off.';
    $('d-power-go').textContent = kind === 'sleep' ? 'Sleep now' : 'Shut down now';
  }
  open('d-power');
  let n = 10;
  $('d-power-c').textContent = n;
  powerT = setInterval(() => { n--; $('d-power-c').textContent = n; if (n <= 0) { stopPower(); closeAll(); send({ cmd: 'power', what: powerKind }); } }, 1000);
}
function stopPower() { clearInterval(powerT); powerT = 0; }
let askWhat = '';
function askText(what) {
  askWhat = what;
  $('d-asktext-h').textContent = what === 'app' ? 'Which app or game?' : 'Which website?';
  $('d-asktext-p').textContent = what === 'app' ? 'Type its name. A grown-up will see it.' : 'Type the website (like coolmath.com).';
  $('d-asktext-in').value = what === 'app' ? (query() || '') : '';
  open('d-asktext');
  setTimeout(() => $('d-asktext-in').focus(), 50);
}
// Dialogs the bar asks for open here (the bar window is too small for them).
function showDialog(name) {
  if (name === 'power-menu') { closeAll(); $('pwrmenu').classList.add('show'); }
  else if (name === 'pin') openPin();
  else if (name === 'volume') { const v = S.sys?.volume || {}; $('d-volume-in').value = v.level ?? 50; $('d-mute').textContent = v.muted ? 'Unmute' : 'Mute'; $('d-volume-p').textContent = v.device || ''; open('d-volume'); }
  else if (name === 'wifi') { const w = S.sys?.wifi || {}; $('d-wifi-p').textContent = w.connected === false ? 'Not connected to the internet. Ask a grown-up.' : w.ssid ? `Connected to ${w.ssid}${w.signal ? ` (${w.signal}% signal)` : ''}.` : 'Connected.'; open('d-wifi'); }
}
// The Phone menu is calls only ('call'). 'text' is the old "Text family" list, for an app without its own Texts screen.
let famMode = 'call';
function openFamily(mode) {
  famMode = mode;
  $('d-family').dataset.mode = mode;
  $('d-family-h').textContent = mode === 'text' ? 'Text family' : 'Phone';
  if (mode === 'text') seenMsgs = lastMsgId();
  render();
  open('d-family');
}

// ------------------------------------------------------------------ taps
document.addEventListener('click', (e) => {
  const t = e.target.closest('button,[data-open],a') || e.target;
  if (e.target.classList?.contains('ov')) { closeAll(); parentPin = null; return; }
  if (!e.target.closest('#pwrmenu') && !e.target.closest('[data-act="power-menu"]')) $('pwrmenu').classList.remove('show');
  const d = t.dataset || {};
  if (d.close !== undefined) { closeAll(); parentPin = null; return; }
  if (d.callnum) { send({ cmd: 'call', num: d.callnum }); toast('Calling…'); return; }
  // Check in (the live map): "I need help now" takes a second tap, so it isn't sent by accident.
  if (d.checkin) {
    if (d.checkin === 'help' && t.dataset.armed !== '1') {
      t.dataset.armed = '1'; t.textContent = 'Tap again to send for help';
      setTimeout(() => { t.dataset.armed = ''; t.textContent = 'I need help now'; }, 5000);
      return;
    }
    if (d.checkin === 'help') { t.dataset.armed = ''; t.textContent = 'I need help now'; }
    send({ cmd: 'checkin', kind: d.checkin });
    return;
  }
  if (d.sound) { send({ cmd: 'sound-mode', mode: d.sound }); return; }
  if (d.timeout) { send({ cmd: 'screen-timeout', sec: Number(d.timeout) }); return; }
  if (d.zoom) { send({ cmd: 'text-size', zoom: Number(d.zoom) }); return; }
  if (d.open) {
    const it = items().find((i) => i.key === d.open);
    if (!it) return;
    if (it.cmd) return send({ cmd: it.cmd });
    if (it.locked) { toast(`${it.name} is used up for today. Ask a grown-up for more?`); return; }
    send(it.web ? { cmd: 'site', host: it.host } : { cmd: 'launch', key: it.key });
    toast(`Opening ${it.name}…`);
    return;
  }
  if (d.cat) { cat = d.cat; render(); return; }
  if (d.chore) {
    const c = (S.launcher?.info?.chores || []).find((x) => String(x.id) === d.chore);
    if (c && c.status === 'todo') { send({ cmd: 'act', act: { action: 'chore', id: c.id } }); c.status = 'waiting'; render(); toast(`Sent! A grown-up will check it${c.minutes ? `, then you get +${c.minutes} min` : ''}.`); }
    return;
  }
  if (d.ask) {
    const [what, mins] = d.ask.split(':');
    if (what === 'time') { send({ cmd: 'act', act: { action: 'ask', what: 'time', minutes: +mins } }); closeAll(); toast(`Asked for ${mins} more minutes. You'll see the answer here.`); }
    else askText(what);
    return;
  }
  if (d.theme && t.closest('#d-themes')) { setLook(d.theme); return; }
  if (d.power) { power(d.power); return; }
  if (d.win) { send({ cmd: 'switch', id: d.win }); return; }
  if (d.call) { send({ cmd: 'call', id: d.call }); toast('Calling…'); return; }
  if (d.text) { openText(d.text); return; }
  if (d.parent) {
    const [what, mins] = d.parent.split(':');
    if (what === 'look') { renderLookDialog(); open('d-look'); return; }
    if (what === 'desktop') { send({ cmd: 'desktop', code: parentPin, minutes: +mins }); closeAll(); parentPin = null; return; }
    send({ cmd: 'parent', code: parentPin, act: { action: 'parent', what, minutes: mins ? +mins : undefined } });
    if (what !== 'update') { closeAll(); parentPin = null; }
    return;
  }
  switch (d.act) {
    case 'ask': open('d-ask'); break;
    case 'ask-app': askText('app'); break;
    case 'ask-send': {
      const v = $('d-asktext-in').value.trim();
      if (!v) return;
      send({ cmd: 'act', act: { action: 'ask', what: askWhat, text: v } });
      closeAll();
      toast(`Asked about “${v}”. You'll see the answer here.`);
      break;
    }
    case 'look': renderLookDialog(); open('d-look'); break;
    case 'chat-open': {
      open('d-chat');
      render();
      const l = $('chat-list'); l.scrollTop = l.scrollHeight;
      if (!PHONE) setTimeout(() => $('chat-in').focus(), 50);
      break;
    }
    case 'chat': {
      const v = $('chat-in').value.trim();
      if (!v) return;
      send({ cmd: 'act', act: { action: 'chat', text: v } });
      $('chat-in').value = '';
      break;
    }
    case 'chores':
      // From the lock screen the list opens as a dialog; on the home screen it is the "Earn more time" card.
      if ($('lock').classList.contains('show') || $('chorescard').offsetParent === null) open('d-chores');
      else { closeAll(); $('chorescard').scrollIntoView({ behavior: 'smooth' }); }
      break;
    case 'lock-pin': openPin($('lock').classList.contains('night') ? 'bedtime' : 'menu'); break;
    case 'code': $('d-code-in').value = ''; $('d-code-msg').textContent = ''; open('d-code'); setTimeout(() => $('d-code-in').focus(), 50); break;
    case 'code-send': { const v = $('d-code-in').value.replace(/\D/g, ''); if (v) send({ cmd: 'code', code: v }); break; }
    case 'home': closeAll(); parentPin = null; $('body').scrollTo?.({ top: 0, behavior: 'smooth' }); send({ cmd: 'home' }); break;
    case 'power-menu': if (MODE === 'bar') send({ cmd: 'dialog', name: 'power-menu' }); else showDialog('power-menu'); break;
    case 'pin': if (MODE === 'bar') send({ cmd: 'dialog', name: 'pin' }); else openPin(); break;
    case 'volume': if (MODE === 'bar') send({ cmd: 'dialog', name: 'volume' }); else showDialog('volume'); break;
    case 'wifi': if (MODE === 'bar') send({ cmd: 'dialog', name: 'wifi' }); else showDialog('wifi'); break;
    case 'mute': send({ cmd: 'volume', mute: !(S.sys?.volume?.muted) }); break;
    case 'power-cancel': closeAll(); break;
    case 'phone-family': openFamily('call'); break;
    // The app's own Texts screen; an app without one gets the old "Text family" list.
    case 'texts': if (S.phone?.texts) send({ cmd: 'texts' }); else openFamily('text'); break;
    case 'sound': renderSound(); open('d-sound'); break;
    case 'emergency': send({ cmd: 'emergency' }); break;
    case 'call-answer': send({ cmd: 'call-answer' }); break;
    case 'call-end': send({ cmd: 'call-end' }); break;
    case 'call-mute': send({ cmd: 'call-mute', on: !S.phone?.call?.muted }); break;
    case 'call-speaker': send({ cmd: 'call-speaker', on: !S.phone?.call?.speaker }); break;
    case 'text-send': {
      const v = $('d-text-in').value.trim();
      if (!v || !textTo) return;
      send({ cmd: 'text', id: textTo.id, text: v });
      closeAll();
      toast(`Sent to ${textTo.name}.`);
      break;
    }
    case 'power-go': { stopPower(); closeAll(); send({ cmd: 'power', what: powerKind }); break; }
  }
});
$('d-volume-in').oninput = (e) => send({ cmd: 'volume', level: +e.target.value });
$('chat-in').onkeydown = (e) => { if (e.key === 'Enter') document.querySelector('[data-act="chat"]').click(); };
$('d-asktext-in').onkeydown = (e) => { if (e.key === 'Enter') document.querySelector('[data-act="ask-send"]').click(); };
$('d-code-in').onkeydown = (e) => { if (e.key === 'Enter') document.querySelector('[data-act="code-send"]').click(); };
$('d-text-in').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.querySelector('[data-act="text-send"]').click(); } };
$('q').addEventListener('input', () => render());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeAll(); parentPin = null; return; }
  if ($('d-pin').classList.contains('show')) {
    e.preventDefault();
    if (/^\d$/.test(e.key) && pin.length < 8) { pin += e.key; dots(); }
    else if (e.key === 'Backspace') { pin = pin.slice(0, -1); dots(); }
    else if (e.key === 'Enter' && pin.length >= 4) send({ cmd: 'pin', code: pin });
    return;
  }
  // Typing anywhere searches (computers; the phone has no search box).
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !document.querySelector('.ov.show') && !$('lock').classList.contains('show')) {
    if ($('q').offsetParent !== null) $('q').focus();
  }
});

// ------------------------------------------------------------------ messages from the app
function onMessage(m) {
  if (!m) return;
  if (m.type === 'state') { S = m; render(); return; }
  if (m.type === 'toast') { toast(m.text); return; }
  if (m.type === 'dialog') { showDialog(m.name); return; }
  if (m.type === 'pin') {
    if (m.ok && pinFor === 'bedtime') {
      // A grown-up opens the device for a while at bedtime (the PIN goes along and is checked again).
      send({ cmd: 'parent', code: pin, act: { action: 'parent', what: 'bedtime', minutes: 30 } });
      pin = ''; closeAll();
      return;
    }
    if (m.ok) { parentPin = pin; pin = ''; const s = S.launcher || {}; $('d-parent-p').textContent = `App ${s.appVersion || ''}${s.updateWaiting ? ` · update ${s.updateWaiting} waiting` : ''}. ${S.status?.kid ? S.status.kid + "'s time keeps counting while you're here." : ''}`; open('d-parent'); }
    else { $('d-pin-msg').textContent = m.message || 'That PIN isn’t right.'; pin = ''; dots(); }
    return;
  }
  if (m.type === 'code') { $('d-code-msg').textContent = m.message || ''; $('d-code-msg').classList.toggle('bad', !m.ok); if (m.ok) setTimeout(closeAll, 1200); return; }
  if (m.type === 'result') { if (m.message) toast(m.message); return; }
}
if (wv) wv.addEventListener('message', (e) => onMessage(e.data));
window.addEventListener('focus', () => send({ cmd: 'hello' }));

function render() {
  if (!S) return;
  applyLook();
  if (MODE === 'bar') { renderBar(); return; }
  renderShared();
  renderTiles();
  renderLock();
  if (MODE === 'preview' && !PHONE) renderBar();
  if (PHONE) renderPhone();
}

// ------------------------------------------------------------------ the phone: calls, texts, sound and screen
// S.phone = { contacts: [{id, name, phone, always}], emergency: '911', messages: [{id, contactId, name, text, at, mine}], call?,
//   friends: [{id, name, phone}], recent: [{name, type: 'in'|'out'|'missed', at, sec}], sound: {...}, texts: true, textsUnread }
let textTo = null;
let seenMsgs = null; // the newest text the kid has seen (for the dot on "Text family")
const lastMsgId = () => { const m = (S?.phone?.messages || []).filter((x) => !x.mine); return m.length ? m[m.length - 1].id : ''; };
function renderPhone() {
  const p = S.phone || {}, st = S.status || {};
  const locked = st.state === 'locked';
  // Locked (time's up, bedtime, a grown-up): only the "always" contacts.
  const people = (p.contacts || []).filter((c) => !locked || c.always);
  // The app's own Texts screen (S.phone.texts): calls only here. Without it, the old Text buttons and list stay.
  const own = !!p.texts;
  const row = (c) => `<div class="fam-row"><span class="fam-av">${esc(initials(c.name))}</span><b>${esc(c.name)}</b>
    <button class="btn pri fam-call" data-call="${esc(c.id)}" aria-label="Call ${esc(c.name)}">Call</button>${own ? '' : `<button class="btn fam-text" data-text="${esc(c.id)}" aria-label="Text ${esc(c.name)}">Text</button>`}</div>`;
  const list = people.length ? people.map(row).join('') : '<div class="none">No family contacts yet. A grown-up adds them in the parent console.</div>';
  setHtml($('fam-list'), list);
  setHtml($('lock-fam-list'), list);
  // Friends a grown-up said yes to: not when the phone is locked.
  const fr = p.friends || [];
  $('fr-h').classList.toggle('hidden', !fr.length);
  setHtml($('fr-list'), fr.map((f) => `<div class="fam-row ${locked ? 'off' : ''}"><span class="fam-av">${esc(initials(f.name))}</span><b>${esc(f.name)}</b>${locked ? '<small>Later</small>' : `<button class="btn pri fam-call" data-callnum="${esc(f.phone)}" aria-label="Call ${esc(f.name)}">Call</button>`}</div>`).join(''));
  const rc = p.recent || [];
  $('rc-h').classList.toggle('hidden', !rc.length);
  const kind = { in: 'Call from', out: 'You called', missed: 'Missed call from' };
  setHtml($('rc-list'), rc.map((r) => `<div class="rc-row ${esc(r.type)}"><b>${esc(kind[r.type] || 'Call with')} ${esc(r.name)}</b><small>${esc(ago(new Date(r.at).toISOString()))}${r.sec ? ` · ${Math.max(1, Math.round(r.sec / 60))} min` : ''}</small></div>`).join(''));
  // The Texts button: how many new texts (the app's own screen), or the dot for the old list.
  const n = own ? Math.min(p.textsUnread || 0, 99) : 0;
  setText($('nav-badge'), n ? String(n) : '');
  $('nav-badge').classList.toggle('hidden', !n);
  $('nav-texts').setAttribute('aria-label', n ? `Texts, ${n} new` : 'Texts');
  setText($('lock-texts'), n ? `Texts (${n} new)` : 'Texts');
  $('lock-texts').classList.toggle('hidden', !own);
  // Location sharing (the live map): the kid always sees it's on, and can check in.
  const loc = p.location;
  document.querySelectorAll('.ci').forEach((x) => x.classList.toggle('hidden', !loc || !loc.sharing));
  document.querySelectorAll('.ci-text').forEach((x) => setText(x, loc?.live ? 'A grown-up is looking at where your phone is right now.' : 'Your grown-ups can see where your phone is.'));
  renderSound();
  renderCall();
  $('lock-fam').classList.toggle('hidden', !locked);
  document.querySelectorAll('[data-act="emergency"]').forEach((b) => setText(b, `Emergency call (${p.emergency || '911'})`));
  const all = p.messages || [];
  const msg = (m) => `<div class="fam-msg ${m.mine ? 'mine' : ''}"><small>${esc(m.mine ? 'You to ' + m.name : m.name)} · ${esc(ago(m.at))}</small><p>${esc(m.text)}</p></div>`;
  setHtml($('fam-msgs'), all.slice(-30).map(msg).join(''));
  // Texting has its own screen now: the old family-texts list only shows on an app without it.
  $('fam-msgs').classList.toggle('hidden', own || !all.length || famMode !== 'text');
  // Texts show on the lock screen too (family can always reach the kid).
  setHtml($('lock-fam-msgs'), all.slice(-2).map(msg).join(''));
  $('lock-fam-msgs').classList.toggle('hidden', own || !all.length);
  if (seenMsgs === null) seenMsgs = lastMsgId();
  if ($('d-family').classList.contains('show') && famMode === 'text') seenMsgs = lastMsgId();
  $('nav-dot').classList.toggle('hidden', own || lastMsgId() === seenMsgs);
}
// Sound and screen (S.phone.sound = { mode, media, ring, notif, brightness, timeout, zoom, canSet, rotate, canRotate }).
function renderSound() {
  const snd = S?.phone?.sound;
  const b = $('nav-sound');
  if (!snd || !b) return;
  setText(b, snd.mode === 'mute' ? 'Muted' : snd.mode === 'vibrate' ? 'Vibrate' : 'Sound');
  b.classList.toggle('quiet', snd.mode !== 'normal');
  b.setAttribute('aria-label', `Sound and screen (${snd.mode === 'mute' ? 'muted' : snd.mode === 'vibrate' ? 'vibrate' : 'sound on'})`);
  document.querySelectorAll('[data-sound]').forEach((x) => { x.classList.toggle('on', x.dataset.sound === snd.mode); x.setAttribute('aria-pressed', x.dataset.sound === snd.mode ? 'true' : 'false'); });
  document.querySelectorAll('[data-vol]').forEach((x) => { if (document.activeElement !== x) x.value = snd[x.dataset.vol] ?? 50; });
  if (document.activeElement !== $('snd-bright')) $('snd-bright').value = snd.brightness ?? 60;
  const t = [30, 60, 120, 300].reduce((best, v) => (Math.abs(v - (snd.timeout || 60)) < Math.abs(best - (snd.timeout || 60)) ? v : best), 60);
  document.querySelectorAll('[data-timeout]').forEach((x) => x.classList.toggle('on', Number(x.dataset.timeout) === t));
  document.querySelectorAll('[data-zoom]').forEach((x) => x.classList.toggle('on', Number(x.dataset.zoom) === (snd.zoom || 100)));
  $('snd-rotate').classList.toggle('on', !!snd.rotate);
  $('snd-rotate').setAttribute('aria-checked', snd.rotate ? 'true' : 'false');
  $('snd-rotate-note').classList.toggle('hidden', !!snd.canRotate);
}
document.querySelectorAll('[data-vol]').forEach((x) => x.addEventListener('change', () => send({ cmd: 'volume-set', which: x.dataset.vol, level: Number(x.value) })));
$('snd-rotate').addEventListener('click', () => send({ cmd: 'rotate', on: !(S?.phone?.sound?.rotate) }));
$('snd-bright').addEventListener('change', () => send({ cmd: 'brightness', level: Number($('snd-bright').value) }));

// A phone call (S.phone.call = { state: 'ringing'|'active', name, number, since, muted, speaker }).
function renderCall() {
  const c = S.phone?.call;
  $('callbar').classList.toggle('show', !!c);
  if (!c) return;
  const ring = c.state === 'ringing';
  setText($('cb-av'), initials(c.name || '?'));
  setText($('cb-name'), c.name || 'Someone');
  if (ring) setText($('cb-sub'), 'is calling…');
  else {
    const s = Math.max(0, Math.floor((Date.now() - new Date(c.since).getTime()) / 1000));
    setText($('cb-sub'), `On a call · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  }
  $('cb-ring').classList.toggle('hidden', !ring);
  $('cb-live').classList.toggle('hidden', ring);
  $('cb-mute').classList.toggle('on', !!c.muted);
  setText($('cb-mute'), c.muted ? 'Unmute' : 'Mute');
  $('cb-spk').classList.toggle('on', !!c.speaker);
  setText($('cb-spk'), c.speaker ? 'Speaker on' : 'Speaker');
}

function openText(id) {
  const c = (S.phone?.contacts || []).find((x) => x.id === id);
  if (!c) return;
  // The phone's texting screen (the app's own Texts), when it has one.
  if (PHONE && S.phone?.texts) return send({ cmd: 'texts', id });
  textTo = c;
  $('d-text-h').textContent = `Text ${c.name}`;
  $('d-text-in').value = '';
  open('d-text');
  setTimeout(() => $('d-text-in').focus(), 50);
}
if (PHONE) {
  const d = document.querySelector('[data-parent^="desktop"]');
  if (d) { d.textContent = 'Phone settings for 15 minutes'; d.dataset.parent = 'desktop:15'; }
  const sd = document.querySelector('#pwrmenu [data-power="shutdown"]');
  if (sd) sd.innerHTML = '<b>Restart</b><small>Turns the phone off and on again</small>';
  const sl = document.querySelector('#pwrmenu [data-power="sleep"]');
  if (sl) sl.innerHTML = '<b>Screen off</b><small>Your apps stay open</small>';
}

// ------------------------------------------------------------------ preview (a normal browser, no app)
function demoHandle(msg) {
  if (msg.cmd === 'pin') onMessage({ type: 'pin', ok: msg.code === '1234', message: 'That PIN isn’t right (preview: 1234).' });
  else if (msg.cmd === 'dialog') showDialog(msg.name);
  else if (msg.cmd === 'act' && msg.act.action === 'look') { S.launcher.settings.theme = msg.act.theme; render(); }
  else if (msg.cmd === 'act' && msg.act.action === 'chat') { S.launcher.info.chat.push({ id: String(Date.now()), who: 'You', mine: true, text: msg.act.text, at: new Date().toISOString() }); render(); }
  else if (msg.cmd === 'call' || msg.cmd === 'emergency') toast('(preview) The phone would call now.');
  else if (msg.cmd === 'texts') toast('(preview) Texts would open now.');
  else if (msg.cmd === 'camera' || msg.cmd === 'movies') toast(`(preview) ${msg.cmd === 'camera' ? 'The camera' : 'Movie Maker'} would open now.`);
  else if (msg.cmd === 'sound-mode') { S.phone.sound.mode = msg.mode; render(); }
  else if (msg.cmd === 'volume-set') { S.phone.sound[msg.which] = msg.level; render(); }
  else if (msg.cmd === 'brightness') { S.phone.sound.brightness = msg.level; render(); }
  else if (msg.cmd === 'screen-timeout') { S.phone.sound.timeout = msg.sec; render(); }
  else if (msg.cmd === 'text-size') { S.phone.sound.zoom = msg.zoom; render(); }
  else if (msg.cmd === 'rotate') { if (S.phone.sound.canRotate) S.phone.sound.rotate = msg.on; else toast('A grown-up turns this on once: Grown-up › Let the screen turn with the phone.'); render(); }
  else if (msg.cmd === 'parent' && msg.act?.what === 'rotate') { S.phone.sound.canRotate = true; S.phone.sound.rotate = true; toast('The screen turns with the phone now.'); render(); }
  else if (msg.cmd === 'power') toast(`(preview) The ${DEV} would ${msg.what === 'sleep' ? 'sleep' : PHONE ? 'restart' : 'shut down'} now.`);
  else if (msg.cmd === 'code') onMessage({ type: 'code', ok: false, message: 'That code isn’t right.' });
}
if (MODE === 'preview') {
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60000).toISOString();
  S = {
    status: { state: 'ok', kid: 'Ava', generalSecondsLeft: 55 * 60, totalSeconds: 90 * 60, apps: [{ key: 'minecraft', name: 'Minecraft', secondsLeft: 12 * 60, kind: 'limit', limitMinutes: 30 }, { key: 'roblox', name: 'Roblox', secondsLeft: 0, kind: 'limit', limitMinutes: 60 }], blockedAppKeys: ['roblox'], offline: false, dayEndsAt: new Date(now + 9 * 3600_000).toISOString() },
    launcher: {
      settings: { layout: 'bright', theme: params.get('theme') || 'galaxy', lookLocked: false }, appVersion: '1.0.0',
      apps: [
        { key: 'minecraft', name: 'Minecraft', category: 'game', allowed: true, limitMinutes: 30 },
        { key: 'roblox', name: 'Roblox', category: 'game', allowed: true, limitMinutes: 60 },
        { key: 'scratch', name: 'Scratch', category: 'school', allowed: true, free: true },
        { key: 'tux-paint', name: 'Tux Paint', category: 'other', allowed: true, free: true },
        { key: 'spotify-kids', name: 'Spotify Kids', category: 'other', allowed: true },
        { key: 'zoom', name: 'Zoom', category: 'school', allowed: true, free: true },
      ],
      sites: [{ host: 'khanacademy.org', tile: 'Khan Academy' }, { host: 'pbskids.org', tile: 'PBS Kids' }],
      info: {
        kid: { id: 'k1', name: 'Ava' }, bedtimeText: PHONE ? 'Bed 8:00' : 'Bedtime at 8:00 pm', choreMinutes: 15,
        chores: [{ id: 'c1', title: 'Make your bed', status: 'done', minutes: 15 }, { id: 'c2', title: 'Feed the dog', status: 'waiting', minutes: 15 }, { id: 'c3', title: 'Empty the dishwasher', status: 'todo', minutes: 15 }],
        chat: [{ id: 'm1', who: 'Mom', text: 'Dinner at 6!', at: iso(30) }, { id: 'm2', who: 'Max', text: 'Can we play after homework?', at: iso(20) }],
      },
    },
    tiles: {},
    siteIcons: {},
    windows: [{ id: '1', title: 'Minecraft', active: true }, { id: '2', title: 'Khan Academy' }],
    sys: { wifi: { connected: true, ssid: 'Home', signal: 82 }, volume: { level: 60, muted: false } },
  };
  if (PHONE) S.phone = { emergency: '911', contacts: [{ id: 'c1', name: 'Mom', phone: '555-0102', always: true }, { id: 'c2', name: 'Dad', phone: '555-0107', always: true }, { id: 'c3', name: 'Grandma', phone: '555-0144', always: true }, { id: 'c4', name: 'Aunt Sam', phone: '555-0190', always: false }], messages: [{ id: 'x1', name: 'Mom', text: 'Pick you up at 3!', at: iso(12) }],
    texts: !params.has('oldtexts'), textsUnread: params.has('unread') ? 2 : 0, friends: [{ id: 'f1', name: 'Jake', phone: '555-0164' }],
    recent: [{ name: 'Mom', type: 'in', at: now - 3 * 3600e3, sec: 190 }, { name: 'Dad', type: 'missed', at: now - 6 * 3600e3, sec: 0 }, { name: 'Grandma', type: 'out', at: now - 26 * 3600e3, sec: 720 }],
    sound: { mode: 'vibrate', media: 60, ring: 80, notif: 45, brightness: 70, timeout: 60, zoom: 100, canSet: true, rotate: true, canRotate: false },
    location: { sharing: !params.has('noshare'), live: params.has('live') } };
  if (PHONE && params.get('ringing') !== null) S.phone.call = { state: 'ringing', name: 'Mom', since: iso(0) };
  if (PHONE && params.get('oncall') !== null) S.phone.call = { state: 'active', name: 'Grandma', since: iso(2), muted: false, speaker: true };
  if (params.get('timeup') !== null) Object.assign(S.status, { state: 'locked', lockReason: 'time', generalSecondsLeft: 0 });
  if (params.get('parentlock') !== null) Object.assign(S.status, { state: 'locked', lockReason: 'parent' });
  if (params.get('bedtime') !== null) Object.assign(S.status, { state: 'locked', lockReason: 'bedtime', bedtimeUntil: new Date(now + 8 * 3600_000).toISOString() });
  render();
  setInterval(render, 30000);
  // Preview a dialog: ?phone&dialog=phone (the Phone menu) or ?phone&dialog=sound (Sound and screen).
  if (PHONE && params.get('dialog') === 'phone') openFamily('call');
  if (PHONE && params.get('dialog') === 'sound') { renderSound(); open('d-sound'); }
} else {
  send({ cmd: 'hello' });
}
