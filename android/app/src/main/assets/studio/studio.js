// The kids' Camera, My photos and Movie Maker (Family Screen Warden, StudioActivity). The phone sends the state
// (window.__studio) and this page sends commands (ScreenWardenStudio.post) and files in pieces (begin, chunk, finish).
// Opened in a browser it shows made-up photos and a drawn camera (?view=camera|photos|viewer|movie|making|done|closed).
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const BRIDGE = window.ScreenWardenStudio;
const DEMO = !BRIDGE;
const post = (o) => (BRIDGE ? BRIDGE.post(JSON.stringify(o)) : demo(o));
const Q = new URLSearchParams(location.search);

let S = { items: [], locked: false, me: '' };
let view = 'camera';
let stack = [];
const MAX_VIDEO = 60;
const MAX_MOVIE = 180;
const PHOTO_SECONDS = 3;

// ---------------------------------------------------------------------------------------------- little helpers
let toastT;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 3200); }
const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = (f) => requestAnimationFrame(f);
function dayLabel(ms) {
  const d = new Date(ms);
  const days = Math.floor((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
const whenLong = (ms) => `${dayLabel(ms)} ${new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
const itemById = (id) => S.items.find((i) => i.id === id);
function awake(on) { post({ cmd: 'awake', on: !!on }); }
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function pickMime(audioOnly) {
  if (!window.MediaRecorder) return '';
  const list = audioOnly ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

// ---------------------------------------------------------------------------------------------- moving around
function show(v) {
  view = v;
  for (const s of document.querySelectorAll('.view')) if (s.id !== 'v-closed') s.classList.toggle('on', s.id === `v-${v}`);
  if (v === 'camera') startCamera(); else stopCamera();
  if (v !== 'movie') stopPreview();
  if (v === 'photos') renderPhotos();
  if (v === 'movie') renderMovie();
  closedText();
}
function go(v, replace) { if (!replace && view !== v) stack.push(view); show(v); }
function back() {
  const sh = document.querySelector('.sheet.show');
  if (sh) { closeSheet(); return true; }
  if (view === 'camera' && rec.on) { stopRecording(); return true; }
  if (view === 'making') { stopMaking(); return true; }
  if (view === 'photos' && picks.size) { picks.clear(); renderPhotos(); return true; }
  if (view === 'movie' && stickerMode) { setStickerMode(false); return true; }
  const prev = stack.pop();
  if (!prev) return false;
  show(prev === 'making' ? 'movie' : prev);
  return true;
}
window.__back = back;
function closeSheet() {
  for (const s of document.querySelectorAll('.sheet.show')) s.classList.remove('show');
  stopSample();
  if (voice.on) stopVoice();
}

// ---------------------------------------------------------------------------------------------- closed at bedtime
function closedText() {
  const movie = ['movie', 'making', 'done'].includes(view);
  const app = movie ? 'Movie Maker' : 'Camera';
  const r = S.lockReason;
  $('cl-t').textContent = r === 'bedtime' ? `${app} is closed at bedtime` : r === 'time' ? `${app} is closed when time's up` : `${app} is closed right now`;
  const until = r === 'bedtime' && S.until ? ` It opens again at ${new Date(S.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : r === 'time' ? ' It opens again tomorrow.' : ' It opens again when a grown-up unlocks the phone.';
  $('cl-p').textContent = `Your photos and movies are safe.${until}`;
}
function applyLock() {
  const el = $('v-closed');
  const was = el.classList.contains('on');
  el.classList.toggle('on', !!S.locked);
  el.style.zIndex = '40';
  closedText();
  if (S.locked && !was) {
    if (rec.on) stopRecording();
    stopCamera();
    stopPreview();
    if (making) stopMaking();
    closeSheet();
  }
  if (!S.locked && was && view === 'camera') startCamera();
}

// ---------------------------------------------------------------------------------------------- stickers and filters (camera and movies)
const STICKERS = ['star', 'heart', 'wow', 'yay', 'crown', 'shades'];
const STAR = new Path2D('m12 2 3 7 7 .6-5.3 4.7L18.4 22 12 18l-6.4 4 1.7-7.7L2 9.6 9 9z');
const HEART = new Path2D('M12 21s-7.5-4.6-9.5-9.3C1.2 8.4 3.3 5 6.6 5c2 0 3.4 1.1 4.4 2.6.9-1.5 2.4-2.6 4.4-2.6 3.3 0 5.4 3.4 4.1 6.7C19.5 16.4 12 21 12 21z');
const CROWN = new Path2D('M3 18 2 7l5.5 4L12 4l4.5 7L22 7l-1 11z');
function drawSticker(ctx, k, x, y, s, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(((rot || 0) * Math.PI) / 180);
  ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = s * 0.25; ctx.shadowOffsetY = s * 0.08;
  const word = (t, bg, fg) => {
    const w = s * 1.55, h = s * 0.64;
    ctx.fillStyle = bg; rr(ctx, -w / 2, -h / 2, w, h, h / 2); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = fg; ctx.font = `900 ${Math.round(s * 0.42)}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, 0, s * 0.02);
  };
  switch (k) {
    case 'star':
      ctx.fillStyle = '#fde047'; ctx.beginPath(); ctx.arc(0, 0, s / 2, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.scale(s / 40, s / 40); ctx.translate(-12, -12.5); ctx.fillStyle = '#f59e0b'; ctx.fill(STAR);
      break;
    case 'heart':
      ctx.scale(s / 22, s / 22); ctx.translate(-12, -13); ctx.fillStyle = '#ec4899'; ctx.fill(HEART);
      ctx.shadowColor = 'transparent'; ctx.lineWidth = 1.4; ctx.strokeStyle = '#fff'; ctx.stroke(HEART);
      break;
    case 'wow': word('WOW!', '#fff', '#db2777'); break;
    case 'yay': word('YAY!', '#fde047', '#7c3aed'); break;
    case 'crown':
      ctx.scale(s / 24, s / 24); ctx.translate(-12, -11); ctx.fillStyle = '#fbbf24'; ctx.fill(CROWN);
      ctx.shadowColor = 'transparent'; ctx.lineWidth = 1.2; ctx.strokeStyle = '#b45309'; ctx.stroke(CROWN);
      ctx.fillStyle = '#ec4899'; for (const [cx, cy] of [[7, 14], [12, 12.5], [17, 14]]) { ctx.beginPath(); ctx.arc(cx, cy, 1.4, 0, Math.PI * 2); ctx.fill(); }
      break;
    case 'shades': {
      const w = s * 0.46, h = s * 0.32;
      ctx.fillStyle = '#111827';
      rr(ctx, -s * 0.52, -h / 2, w, h, h * 0.4); ctx.fill();
      rr(ctx, s * 0.06, -h / 2, w, h, h * 0.4); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillRect(-s * 0.08, -h * 0.35, s * 0.16, h * 0.18);
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.fillRect(-s * 0.44, -h * 0.28, w * 0.22, h * 0.16); ctx.fillRect(s * 0.14, -h * 0.28, w * 0.22, h * 0.16);
      break;
    }
  }
  ctx.restore();
}
const FX = [['normal', 'Normal'], ['stickers', 'Stickers'], ['rainbow', 'Rainbow'], ['comic', 'Comic'], ['old', 'Old photo']];
const MOVIE_FX = FX.filter(([k]) => k !== 'stickers');
function filterOf(fx) {
  if (fx === 'rainbow') return 'saturate(1.35)';
  if (fx === 'comic') return 'url(#fx-comic) contrast(1.25) saturate(1.6)';
  if (fx === 'old') return 'sepia(.85) contrast(1.05) brightness(1.02)';
  return 'none';
}
function rainbowOver(ctx, W, H) {
  ctx.save();
  const g = ctx.createLinearGradient(0, 0, W, H);
  ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#3b82f6', '#a855f7'].forEach((c, i) => g.addColorStop(i / 5, c));
  ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.55; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.restore();
}
function oldOver(ctx, W, H) {
  ctx.save();
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(60,30,0,.45)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.restore();
}
/** Comic by hand, for a photo when the browser can't use the svg filter in a canvas. */
function posterize(ctx, W, H) {
  const d = ctx.getImageData(0, 0, W, H); const p = d.data;
  for (let i = 0; i < p.length; i += 4) for (let j = 0; j < 3; j++) p[i + j] = Math.min(255, Math.round(p[i + j] / 64) * 64);
  ctx.putImageData(d, 0, 0);
}
let canvasSvgFilter = null;
function svgFilterWorks() {
  if (canvasSvgFilter !== null) return canvasSvgFilter;
  const c = document.createElement('canvas'); c.width = c.height = 4;
  const x = c.getContext('2d'); x.filter = 'url(#fx-comic)';
  canvasSvgFilter = x.filter !== 'none' && x.filter !== '';
  return canvasSvgFilter;
}

// ---------------------------------------------------------------------------------------------- made-up pictures (browser preview)
const SWATCH = [['#fcd34d', '#fb7185'], ['#7dd3fc', '#4ade80'], ['#c4b5fd', '#f472b6'], ['#fdba74', '#ef4444'], ['#86efac', '#0ea5e9'], ['#f9a8d4', '#a78bfa'], ['#fde68a', '#84cc16'], ['#93c5fd', '#6366f1'], ['#fca5a5', '#fbbf24'], ['#a7f3d0', '#22d3ee'], ['#ddd6fe', '#e879f9'], ['#fed7aa', '#fb923c']];
function paintScene(ctx, W, H, col, t, seed) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const r = Math.min(W, H);
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.beginPath(); ctx.arc(W * (0.25 + 0.5 * ((seed * 0.37 + t * 0.05) % 1)), H * 0.3, r * 0.14, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.12)';
  ctx.beginPath(); ctx.ellipse(W * 0.3, H * 1.05, W * 0.55, H * 0.32, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(W * 0.85, H * 1.08, W * 0.45, H * 0.3, 0, 0, Math.PI * 2); ctx.fill();
}
function paintCamera(ctx, W, H, t) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#7dd3fc'); g.addColorStop(0.45, '#bae6fd'); g.addColorStop(0.46, '#86efac'); g.addColorStop(1, '#4ade80');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fde047'; ctx.beginPath(); ctx.arc(W * 0.78, H * 0.12, W * 0.09, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  const cx = ((t * 12) % (W + 200)) - 100;
  for (const [dx, dy, rr2] of [[0, 0, 26], [28, -10, 32], [60, 2, 24]]) { ctx.beginPath(); ctx.arc(cx + dx, H * 0.2 + dy, rr2, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#16a34a'; ctx.beginPath(); ctx.ellipse(W * 0.2, H * 0.62, W * 0.12, H * 0.06, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#92400e'; ctx.fillRect(W * 0.62, H * 0.38, W * 0.05, H * 0.2);
  ctx.fillStyle = '#15803d'; ctx.beginPath(); ctx.arc(W * 0.645, H * 0.36, W * 0.13, 0, Math.PI * 2); ctx.fill();
}
function sceneURL(col, seed, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  paintScene(c.getContext('2d'), W, H, col, 0, seed);
  return c.toDataURL('image/jpeg', 0.85);
}

// ---------------------------------------------------------------------------------------------- saving (to the phone, in pieces)
function b64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); }); }
async function saveBlob(blob, meta, onPart) {
  if (DEMO) {
    const it = { id: 'n' + Date.now(), kind: meta.kind, title: meta.title || '', at: Date.now(), dur: meta.dur || 0, mime: meta.mime, url: URL.createObjectURL(blob), thumb: meta.poster || '' };
    if (!it.thumb && meta.kind === 'photo') it.thumb = it.url;
    S.items.unshift(it);
    return it;
  }
  const id = BRIDGE.begin();
  if (!id) throw new Error('busy');
  const CH = 512 * 1024;
  try {
    for (let o = 0; o < blob.size; o += CH) {
      if (!BRIDGE.chunk(id, await b64(blob.slice(o, o + CH)))) throw new Error('chunk');
      onPart && onPart(Math.min(1, (o + CH) / blob.size));
    }
  } catch (e) { BRIDGE.cancel(id); throw e; }
  const r = BRIDGE.finish(id, JSON.stringify(meta));
  if (!r) throw new Error('save');
  const it = JSON.parse(r);
  if (!itemById(it.id)) S.items.unshift(it);
  return it;
}
function posterOf(src, w, h, mirror) {
  const c = document.createElement('canvas');
  const k = Math.min(1, 400 / Math.max(w, h));
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const x = c.getContext('2d');
  if (mirror) { x.translate(c.width, 0); x.scale(-1, 1); }
  x.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

// ---------------------------------------------------------------------------------------------- camera
const cam = { stream: null, facing: 'environment', mode: 'photo', fx: 'normal', timer: false, torch: false, stickers: [], sticker: 'star', starting: null, demoT: 0, audio: false };
const rec = { on: false, recorder: null, chunks: [], at: 0, tick: 0, draw: 0, poster: '', mime: '' };
const camVideo = $('cam-video');
const camDemo = $('cam-demo');
const finder = $('finder');

$('cam-fx').innerHTML = FX.map(([k, n]) => `<button data-fx="${k}" class="${k === 'normal' ? 'on' : ''}">${n}</button>`).join('');
function stickerButton(k, on) { return `<button data-stk="${k}" class="${on ? 'on' : ''}" aria-label="${k} sticker"><canvas width="80" height="80" data-draw="${k}"></canvas></button>`; }
function paintTrayIcons(root) {
  for (const c of root.querySelectorAll('canvas[data-draw]')) { const x = c.getContext('2d'); x.clearRect(0, 0, 80, 80); drawSticker(x, c.dataset.draw, 40, 40, 54, 0); }
}
function renderTray() {
  $('cam-tray').innerHTML = STICKERS.map((k) => stickerButton(k, k === cam.sticker)).join('') + '<button class="clear" data-act="cam-clear">Clear</button>';
  paintTrayIcons($('cam-tray'));
}
renderTray();

function setFx(fx) {
  cam.fx = fx;
  for (const b of $('cam-fx').children) b.classList.toggle('on', b.dataset.fx === fx);
  finder.classList.toggle('fx-rainbow', fx === 'rainbow');
  finder.classList.toggle('fx-comic', fx === 'comic');
  finder.classList.toggle('fx-old', fx === 'old');
  $('cam-rainbow').classList.toggle('hidden', fx !== 'rainbow');
  $('cam-tray').classList.toggle('hidden', fx !== 'stickers');
  drawCamStickers();
}

function drawCamStickers() {
  const c = $('cam-stickers');
  const r = finder.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  if (cam.fx !== 'stickers') return;
  const s = Math.min(c.width, c.height) * 0.16;
  for (const k of cam.stickers) drawSticker(x, k.kind, k.x * c.width, k.y * c.height, s, k.rot);
}
window.addEventListener('resize', () => { drawCamStickers(); });

async function startCamera() {
  if (S.locked || view !== 'camera') return;
  if (DEMO) { camDemo.classList.remove('hidden'); camVideo.classList.add('hidden'); demoCamLoop(); $('b-flash').classList.remove('hidden'); setFx(cam.fx); return; }
  const wantAudio = cam.mode === 'video';
  if (cam.stream && cam.audio === wantAudio) return;
  if (cam.starting) return cam.starting;
  cam.starting = (async () => {
    stopCamera();
    $('cam-err').classList.add('hidden');
    const video = { facingMode: cam.facing, width: { ideal: 1280 }, height: { ideal: 720 } };
    let s = null;
    try { s = await navigator.mediaDevices.getUserMedia({ video, audio: wantAudio }); cam.audio = wantAudio; } catch (e) {
      if (wantAudio) try { s = await navigator.mediaDevices.getUserMedia({ video }); cam.audio = false; toast('The microphone is off, so videos will be quiet.'); } catch (e2) { s = null; }
    }
    if (!s) { $('cam-err').classList.remove('hidden'); return; }
    if (view !== 'camera' || S.locked) { s.getTracks().forEach((t) => t.stop()); return; }
    cam.stream = s;
    camVideo.srcObject = s;
    camVideo.play().catch(() => {});
    finder.classList.toggle('mirror', cam.facing === 'user');
    const track = s.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    cam.torch = false;
    $('b-flash').classList.toggle('hidden', !caps.torch);
    $('b-flash').classList.remove('on');
    setFx(cam.fx);
  })();
  try { await cam.starting; } finally { cam.starting = null; }
}
function stopCamera() {
  if (cam.stream) { cam.stream.getTracks().forEach((t) => t.stop()); cam.stream = null; }
  camVideo.srcObject = null;
}
let demoCamOn = false;
function demoCamLoop() {
  if (demoCamOn) return;
  demoCamOn = true;
  const step = () => {
    if (view !== 'camera') { demoCamOn = false; return; }
    const r = finder.getBoundingClientRect();
    if (camDemo.width !== Math.round(r.width) || camDemo.height !== Math.round(r.height)) { camDemo.width = Math.round(r.width); camDemo.height = Math.round(r.height); }
    cam.demoT += 1 / 30;
    paintCamera(camDemo.getContext('2d'), camDemo.width, camDemo.height, cam.demoT);
    setTimeout(step, 33);
  };
  step();
}
/** What the kid sees in the finder (cropped like on screen), with the fun mode: for a photo or a video's picture. */
function camSource() {
  if (DEMO) return { el: camDemo, w: camDemo.width, h: camDemo.height, mirror: false };
  return { el: camVideo, w: camVideo.videoWidth, h: camVideo.videoHeight, mirror: cam.facing === 'user' };
}
function camCrop(maxSide) {
  const src = camSource();
  const r = finder.getBoundingClientRect();
  if (!src.w || !src.h || !r.width) return null;
  const k = Math.max(r.width / src.w, r.height / src.h);
  const sw = r.width / k, sh = r.height / k;
  const out = Math.min(1, maxSide / Math.max(sw, sh));
  return { ...src, sx: (src.w - sw) / 2, sy: (src.h - sh) / 2, sw, sh, W: Math.round(sw * out), H: Math.round(sh * out) };
}
function drawCam(ctx, cr, fx, stickers, exact) {
  const { W, H } = cr;
  ctx.save();
  ctx.filter = filterOf(fx);
  if (cr.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(cr.el, cr.sx, cr.sy, cr.sw, cr.sh, 0, 0, W, H);
  ctx.restore();
  if (fx === 'comic' && exact && !svgFilterWorks()) posterize(ctx, W, H);
  if (fx === 'rainbow') rainbowOver(ctx, W, H);
  if (fx === 'old') oldOver(ctx, W, H);
  if (fx === 'stickers') { const s = Math.min(W, H) * 0.16; for (const k of stickers) drawSticker(ctx, k.kind, k.x * W, k.y * H, s, k.rot); }
}

async function countdown() {
  const el = $('cam-count');
  el.classList.remove('hidden');
  for (const n of [3, 2, 1]) { el.textContent = n; await sleep(1000); if (view !== 'camera') break; }
  el.classList.add('hidden');
}
let shooting = false;
async function shoot() {
  if (shooting || S.locked) return;
  if (rec.on) return stopRecording();
  if (!DEMO && !cam.stream) return startCamera();
  shooting = true;
  try {
    if (cam.timer) await countdown();
    if (view !== 'camera') return;
    if (cam.mode === 'photo') await takePhoto(); else startRecording();
  } finally { shooting = false; }
}
async function takePhoto() {
  const cr = camCrop(1600);
  if (!cr) return toast('The camera is still starting.');
  const fl = $('cam-flashfx');
  fl.classList.add('go'); setTimeout(() => fl.classList.remove('go'), 60);
  const c = document.createElement('canvas'); c.width = cr.W; c.height = cr.H;
  drawCam(c.getContext('2d'), cr, cam.fx, cam.stickers, true);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) return toast("That photo didn't work. Try again.");
  try { await saveBlob(blob, { kind: 'photo', mime: 'image/jpeg', title: '', dur: 0 }); renderLast(); toast('Saved in My photos'); } catch (e) { toast("That photo didn't save. Try again."); }
}
function startRecording() {
  const mime = pickMime(false);
  if (!mime) return toast("This phone can't make videos here.");
  const cr = camCrop(1280);
  if (!cr) return toast('The camera is still starting.');
  let stream;
  if (cam.fx === 'normal' && !DEMO) stream = cam.stream;
  else {
    // A fun mode: the video is the finder drawn in a canvas (with the camera's sound).
    const c = document.createElement('canvas'); c.width = cr.W; c.height = cr.H;
    const x = c.getContext('2d');
    const loop = () => { if (!rec.on) return; drawCam(x, camCrop(1280) || cr, cam.fx, cam.stickers, false); rec.draw = raf(loop); };
    rec.on = true; loop();
    stream = c.captureStream(30);
    if (cam.stream) for (const t of cam.stream.getAudioTracks()) stream.addTrack(t);
  }
  try {
    rec.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
  } catch (e) { rec.on = false; return toast("This phone can't make videos here."); }
  rec.mime = mime;
  rec.chunks = [];
  rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = finishRecording;
  rec.poster = posterOf(cr.el, cr.w, cr.h, cr.mirror);
  rec.recorder.start(1000);
  rec.on = true;
  rec.at = performance.now();
  awake(true);
  $('cam-rec').classList.remove('hidden');
  $('shutter').classList.add('recording');
  $('shutter').setAttribute('aria-label', 'Stop the video');
  document.querySelector('.seg').classList.add('busy');
  $('b-flip').disabled = true;
  rec.tick = setInterval(() => {
    const s = (performance.now() - rec.at) / 1000;
    $('cam-rec-t').textContent = fmt(Math.floor(s));
    if (s >= MAX_VIDEO) stopRecording();
  }, 250);
}
function stopRecording() {
  if (!rec.on) return;
  rec.on = false;
  clearInterval(rec.tick);
  cancelAnimationFrame(rec.draw);
  rec.dur = Math.min(MAX_VIDEO, (performance.now() - rec.at) / 1000);
  try { rec.recorder.state !== 'inactive' && rec.recorder.stop(); } catch (e) { finishRecording(); }
  $('cam-rec').classList.add('hidden');
  $('shutter').classList.remove('recording');
  $('shutter').setAttribute('aria-label', 'Start a video');
  document.querySelector('.seg').classList.remove('busy');
  $('b-flip').disabled = false;
  awake(false);
}
async function finishRecording() {
  const blob = new Blob(rec.chunks, { type: rec.mime.split(';')[0] });
  rec.chunks = [];
  if (!blob.size) return toast("That video didn't work. Try again.");
  toast('Saving your video…');
  try { await saveBlob(blob, { kind: 'video', mime: rec.mime.split(';')[0], title: '', dur: Math.round(rec.dur * 10) / 10, poster: rec.poster }); renderLast(); toast('Saved in My photos'); } catch (e) { toast("That video didn't save. Try again."); }
}
function setCamMode(m) {
  if (rec.on) return;
  cam.mode = m;
  $('m-photo').classList.toggle('on', m === 'photo');
  $('m-video').classList.toggle('on', m === 'video');
  $('shutter').classList.toggle('video', m === 'video');
  $('shutter').setAttribute('aria-label', m === 'video' ? 'Start a video' : 'Take a photo');
  startCamera();
}
async function toggleTorch() {
  if (DEMO) { cam.torch = !cam.torch; $('b-flash').classList.toggle('on', cam.torch); return; }
  const t = cam.stream && cam.stream.getVideoTracks()[0];
  if (!t) return;
  try { await t.applyConstraints({ advanced: [{ torch: !cam.torch }] }); cam.torch = !cam.torch; $('b-flash').classList.toggle('on', cam.torch); } catch (e) { $('b-flash').classList.add('hidden'); }
}
function flip() {
  if (rec.on) return;
  cam.facing = cam.facing === 'user' ? 'environment' : 'user';
  stopCamera();
  startCamera();
}
function renderLast() {
  const it = S.items[0];
  $('cam-last').style.backgroundImage = it && it.thumb ? `url("${it.thumb}")` : '';
}
finder.addEventListener('click', (e) => {
  if (cam.fx !== 'stickers' || e.target.closest('button')) return;
  const r = finder.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  const s = (Math.min(r.width, r.height) * 0.16) / 2;
  const hit = cam.stickers.findIndex((k) => Math.hypot((k.x - x) * r.width, (k.y - y) * r.height) < s);
  if (hit >= 0) cam.stickers.splice(hit, 1);
  else if (cam.stickers.length < 12) cam.stickers.push({ kind: cam.sticker, x, y, rot: Math.round(Math.random() * 24 - 12) });
  drawCamStickers();
});

// ---------------------------------------------------------------------------------------------- my photos
let tab = 'all';
const picks = new Set();
let pressT = 0, pressed = false;
function renderPhotos() {
  const list = S.items.filter((i) => tab === 'all' || i.kind === tab);
  let h = '';
  let day = '';
  let first = true;
  for (const it of list) {
    const d = dayLabel(it.at);
    if (d !== day) {
      if (day) h += '</div>';
      day = d;
      h += `<div class="sec"><span>${esc(d)}</span>${first && !picks.size ? '<small>Hold one to pick a few</small>' : ''}</div><div class="grid">`;
      first = false;
    }
    const on = picks.has(it.id);
    const tag = it.kind === 'photo' ? '' : `<span class="tag ${it.kind === 'movie' ? 'movie' : ''}"><svg viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>${esc(fmt(it.dur))}</span>`;
    const label = it.kind === 'photo' ? 'Photo' : it.kind === 'movie' ? `Movie ${it.title}` : 'Video';
    h += `<button class="cell ${on ? 'on' : ''}" data-item="${esc(it.id)}" aria-label="${esc(label)}" style="background-image:url('${esc(it.thumb)}')">${on ? '<span class="ck"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg></span>' : ''}${tag}</button>`;
  }
  if (day) h += '</div>';
  if (!list.length) h = `<div class="empty">${tab === 'movie' ? 'No movies yet. Tap “Make a movie” to make one.' : 'Nothing here yet. Take a photo with the camera!'}</div>`;
  $('ph-grid').innerHTML = h;
  for (const b of $('ph-tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  $('pickbar').classList.toggle('hidden', !picks.size);
  $('pb-n').textContent = `${picks.size} picked`;
  $('ph-grid').style.paddingBottom = picks.size ? '190px' : '24px';
}
function togglePick(id) { picks.has(id) ? picks.delete(id) : picks.add(id); renderPhotos(); }
$('ph-grid').addEventListener('pointerdown', (e) => {
  const c = e.target.closest('[data-item]');
  if (!c) return;
  pressed = false;
  clearTimeout(pressT);
  pressT = setTimeout(() => { pressed = true; togglePick(c.dataset.item); if (navigator.vibrate) navigator.vibrate(20); }, 450);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('ph-grid').addEventListener(ev, () => clearTimeout(pressT));
$('ph-grid').addEventListener('scroll', () => clearTimeout(pressT), { passive: true });
$('ph-grid').addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------------------------------------- one photo or video
let viewing = null;
function openViewer(id) {
  const it = itemById(id);
  if (!it) return;
  viewing = id;
  const st = $('vw-stage');
  if (it.kind === 'photo') st.innerHTML = `<img src="${esc(it.url)}" alt="Photo">`;
  else if (DEMO && !it.url.startsWith('blob:')) st.innerHTML = `<div class="fake" style="background:url('${esc(it.thumb)}') center/cover"><span class="play big" style="position:static"><svg viewBox="0 0 24 24" class="fill"><path d="M7 4l13 8-13 8z"/></svg></span></div>`;
  else { st.innerHTML = `<video controls playsinline autoplay src="${esc(it.url)}"></video>`; fixDuration(st.querySelector('video')); }
  $('vw-title').textContent = it.kind === 'photo' ? 'Photo' : it.kind === 'movie' ? it.title || 'My movie' : 'Video';
  $('vw-sub').textContent = whenLong(it.at) + (it.kind === 'photo' ? '' : ` · ${fmt(it.dur)}`);
  go('viewer');
}
function closeViewer() { const v = $('vw-stage').querySelector('video'); if (v) v.pause(); }
/** Videos made in a browser don't say how long they are: this finds out, so the slider works. */
function fixDuration(v) {
  return new Promise((res) => {
    const done = () => { v.removeEventListener('timeupdate', onT); res(); };
    const onT = () => { if (isFinite(v.duration)) { v.currentTime = 0; done(); } };
    const check = () => {
      if (isFinite(v.duration)) return res();
      v.addEventListener('timeupdate', onT);
      v.currentTime = 1e101;
      setTimeout(done, 2000);
    };
    if (v.readyState >= 1) check(); else { v.addEventListener('loadedmetadata', check, { once: true }); v.addEventListener('error', () => res(), { once: true }); setTimeout(res, 4000); }
  });
}

// ---------------------------------------------------------------------------------------------- sending, deleting
let deleting = [];
function askDelete(ids) {
  deleting = ids;
  $('cf-t').textContent = ids.length > 1 ? `Delete these ${ids.length}?` : 'Delete this?';
  $('sh-confirm').classList.add('show');
}
function doDelete() {
  post({ cmd: 'delete', ids: deleting });
  const gone = new Set(deleting);
  S.items = S.items.filter((i) => !gone.has(i.id));
  for (const id of deleting) picks.delete(id);
  closeSheet();
  toast(deleting.length > 1 ? 'Deleted' : 'Deleted');
  if (view === 'viewer') { closeViewer(); back(); } else renderPhotos();
  renderLast();
}
let sending = false;
function sendInTexts(ids) {
  if (sending || !ids.length) return;
  sending = true;
  for (const b of document.querySelectorAll('[data-act=texts],[data-act=done-texts]')) b.disabled = true;
  setTimeout(sentDone, 20000);
  post({ cmd: 'texts', ids });
}
function sentDone() { sending = false; for (const b of document.querySelectorAll('[data-act=texts],[data-act=done-texts]')) b.disabled = false; }

// ---------------------------------------------------------------------------------------------- music (made here, no files)
let AC = null;
const ac = () => AC || (AC = new (window.AudioContext || window.webkitAudioContext)());
let NOISE = null;
function noiseBuf(a) {
  if (NOISE && NOISE.sampleRate === a.sampleRate) return NOISE;
  const b = a.createBuffer(1, a.sampleRate, a.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return (NOISE = b);
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const PROG = [[60, 64, 67], [67, 71, 74], [69, 72, 76], [65, 69, 72]];
const PENTA = [72, 74, 76, 79, 81, 84];
const TRACKS = [
  { id: 'ukulele', name: 'Happy Ukulele', bpm: 112 },
  { id: 'beat', name: 'Bouncy Beat', bpm: 118 },
  { id: 'calm', name: 'Calm Stars', bpm: 70 },
  { id: 'disco', name: 'Space Disco', bpm: 122 },
  { id: 'none', name: 'No music' },
];
function tone(a, out, t, f, dur, type, vol, attack = 0.005, cutoff = 0) {
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, attack + 0.02));
  let n = o;
  if (cutoff) { const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff; o.connect(lp); n = lp; }
  n.connect(g); g.connect(out);
  o.start(t); o.stop(t + dur + 0.05);
}
function hit(a, out, t, vol, hp, len) {
  const s = a.createBufferSource(); s.buffer = noiseBuf(a);
  const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
  const g = a.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  s.connect(f); f.connect(g); g.connect(out);
  s.start(t, Math.random() * 0.5); s.stop(t + len + 0.02);
}
function kick(a, out, t, vol) {
  const o = a.createOscillator(); const g = a.createGain();
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.35);
}
function stepNotes(id, a, out, n, t, st) {
  const s = n % 16, bar = Math.floor(n / 16) % 4, ch = PROG[bar];
  if (id === 'ukulele') {
    if ([0, 4, 6, 10, 12, 14].includes(s)) ch.concat(ch[0] + 12).forEach((m, j) => tone(a, out, t + j * 0.012, mtof(m), 0.45, 'triangle', s % 4 === 0 ? 0.09 : 0.06));
    if ([0, 8].includes(s)) tone(a, out, t, mtof(ch[0] - 24), 0.4, 'triangle', 0.14);
    if ([2, 7, 10, 15].includes(s) && (n * 7 + bar) % 3 !== 0) tone(a, out, t, mtof(PENTA[(n * 5 + bar * 3) % PENTA.length]), 0.3, 'sine', 0.08);
  } else if (id === 'beat') {
    if ([0, 8, 10].includes(s)) kick(a, out, t, 0.5);
    if ([4, 12].includes(s)) { hit(a, out, t, 0.25, 1200, 0.16); tone(a, out, t, 190, 0.08, 'triangle', 0.12); }
    if (s % 2 === 0) hit(a, out, t, 0.05, 7000, 0.04);
    if ([0, 3, 6, 8, 11, 14].includes(s)) tone(a, out, t, mtof(ch[0] - 24), st * 1.5, 'square', 0.05, 0.005, 700);
    if ([2, 10].includes(s)) ch.forEach((m) => tone(a, out, t, mtof(m), 0.12, 'square', 0.025, 0.005, 2500));
  } else if (id === 'calm') {
    if (s === 0) ch.forEach((m) => tone(a, out, t, mtof(m - 12), st * 16 + 0.6, 'sine', 0.05, 0.8));
    if ([0, 6, 12].includes(s) && (n >> 4) % 2 === (s === 6 ? 1 : 0) || s === 10) tone(a, out, t, mtof(PENTA[(n * 3 + bar) % PENTA.length] + 12), 1.6, 'sine', 0.05);
  } else if (id === 'disco') {
    if (s % 4 === 0) kick(a, out, t, 0.45);
    if (s % 4 === 2) hit(a, out, t, 0.07, 6000, 0.12);
    if ([4, 12].includes(s)) hit(a, out, t, 0.18, 1500, 0.12);
    if (s % 2 === 0) tone(a, out, t, mtof(ch[0] - (s % 4 === 0 ? 24 : 12)), st * 1.6, 'sawtooth', 0.06, 0.005, 900);
    tone(a, out, t, mtof(ch[s % 3] + 12), st * 0.9, 'square', 0.025, 0.003, 3000);
  }
}
/** Plays a built-in tune into [out] from [offset] seconds. Returns { stop() }. */
function startMusic(a, out, id, offset, vol) {
  const T = TRACKS.find((x) => x.id === id);
  if (!T || id === 'none') return { stop() {} };
  const bus = a.createGain(); bus.gain.value = vol * 0.8; bus.connect(out);
  const st = 60 / T.bpm / 4;
  let n = Math.floor(offset / st);
  let next = a.currentTime + 0.06 + (n * st - offset);
  if (next < a.currentTime + 0.02) { n++; next += st; }
  const timer = setInterval(() => {
    while (next < a.currentTime + 0.25) { stepNotes(id, a, bus, n, next, st); n++; next += st; }
  }, 40);
  return {
    stop() {
      clearInterval(timer);
      try { bus.gain.setTargetAtTime(0, a.currentTime, 0.08); } catch (e) { /* gone */ }
      setTimeout(() => bus.disconnect(), 600);
    },
  };
}
let sample = null;
function playSample(id) {
  stopSample();
  if (id === 'none') return;
  const a = ac(); a.resume();
  sample = startMusic(a, a.destination, id, 0, P.vol);
  const s = sample; setTimeout(() => { if (sample === s) stopSample(); }, 5000);
}
function stopSample() { if (sample) { sample.stop(); sample = null; } }

// ---------------------------------------------------------------------------------------------- movie maker: the project (kept here only)
let P = newProject();
function newProject() { return { title: 'My movie', clips: [], music: 'ukulele', vol: 0.6, made: null }; }
let sel = -1;
let pos = 0;
let stickerMode = false;
let stickerKind = 'star';
const clipLen = (c) => (c.end - c.start) / c.speed;
const total = () => P.clips.reduce((a, c) => a + clipLen(c), 0);
function segs() { let t = 0; return P.clips.map((c, i) => { const s = { c, i, t, len: clipLen(c) }; t += s.len; return s; }); }
function newClip(it) {
  const photo = it.kind === 'photo';
  const dur = photo ? PHOTO_SECONDS : Math.max(0.5, it.dur || 5);
  return { item: it, kind: photo ? 'photo' : 'video', dur, start: 0, end: dur, speed: 1, fx: 'normal', words: null, stickers: [], voice: null };
}
/** Movies are at most 3 minutes: a clip that doesn't fit gets cut. */
function fit(c) {
  const room = MAX_MOVIE - (total() - clipLen(c));
  if (clipLen(c) > room) c.end = Math.max(c.start + 0.5, c.start + room * c.speed);
}
function addClips(items) {
  let cut = false;
  for (const it of items) {
    if (MAX_MOVIE - total() < 1) { cut = true; break; }
    const c = newClip(it);
    P.clips.push(c);
    const before = c.end; fit(c); if (c.end < before) cut = true;
  }
  if (cut) toast('Movies can be 3 minutes long. Some of it didn\'t fit.');
  if (sel < 0 && P.clips.length) sel = 0;
  pos = sel >= 0 ? segs()[sel].t : 0;
}
function edited() { P.made = null; }

function renderMovie() {
  const tot = total();
  $('mv-title').textContent = P.title;
  $('mv-sub').textContent = P.clips.length ? `${P.clips.length} clip${P.clips.length > 1 ? 's' : ''} · ${fmt(tot)}` : 'No clips yet';
  $('mv-len').textContent = fmt(tot);
  $('mv-empty').classList.toggle('hidden', P.clips.length > 0);
  $('mv-play').classList.toggle('hidden', !P.clips.length);
  document.querySelector('#v-movie .done').disabled = !P.clips.length;
  const tr = TRACKS.find((t) => t.id === P.music);
  $('mv-music').textContent = tr ? tr.name : 'No music';
  $('mv-vol').textContent = P.music === 'none' ? '' : `Volume ${Math.round(P.vol * 100)}%`;
  $('mv-clips').innerHTML = P.clips.map((c, i) => {
    const marks = (c.words ? '<i></i>' : '') + (c.stickers.length ? '<i></i>' : '') + (c.voice ? '<i></i>' : '');
    return `<button class="clip ${i === sel ? 'on' : ''}" data-clip="${i}" aria-label="Clip ${i + 1}" style="background-image:url('${esc(c.item.thumb)}')"><span>${c.kind === 'photo' ? 'Photo' : fmt(clipLen(c))}</span>${marks ? `<b class="marks">${marks}</b>` : ''}</button>`;
  }).join('') + '<button class="clip add" data-act="tool-add" aria-label="Add clips"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>';
  const c = P.clips[sel];
  for (const b of document.querySelectorAll('#v-movie [data-need]')) b.disabled = !c;
  for (const b of document.querySelectorAll('#v-movie .tool')) b.classList.toggle('on', b.dataset.act === 'tool-stickers' && stickerMode);
  $('mv-trim').classList.toggle('hidden', !c || stickerMode);
  $('mv-tapnote').classList.toggle('hidden', !stickerMode);
  $('mv-preview').classList.toggle('stick', stickerMode);
  if (stickerMode) {
    $('mv-hint').innerHTML = '';
    $('mv-hint').className = 'tray-in';
    $('mv-hint').innerHTML = `<div class="chips stk">${STICKERS.map((k) => stickerButton(k, k === stickerKind)).join('')}<button class="clear" data-act="mv-clear">Clear</button><button class="clear" data-act="tool-stickers">Done</button></div>`;
    paintTrayIcons($('mv-hint'));
  } else {
    $('mv-hint').className = 'hint';
    $('mv-hint').textContent = !c ? (P.clips.length ? 'Pick a clip to change it.' : 'Tap “Add clips” to pick photos and videos.')
      : c.kind === 'photo' ? `Clip ${sel + 1}: a photo shows for ${Math.round(clipLen(c))} seconds. Arrows move it.`
        : `Clip ${sel + 1}: drag the white edges to cut it (${fmt(c.start)} – ${fmt(c.end)})`;
  }
  $('mv-dual').classList.toggle('hidden', !c || c.kind === 'photo');
  if (c && c.kind !== 'photo') {
    $('tr-a').value = Math.round((c.start / c.dur) * 1000);
    $('tr-b').value = Math.round((c.end / c.dur) * 1000);
    trimBar();
  }
  setPos(pos);
  if (!playing) still();
}
function trimBar() {
  const a = +$('tr-a').value, b = +$('tr-b').value;
  $('mv-sel').style.left = `${a / 10}%`;
  $('mv-sel').style.width = `${(b - a) / 10}%`;
}
function setPos(t) {
  pos = Math.max(0, Math.min(t, total()));
  $('mv-at').textContent = fmt(pos);
  $('mv-fill').style.width = `${total() ? (pos / total()) * 100 : 0}%`;
}
function selectClip(i) { sel = i; const s = segs()[i]; if (s) pos = s.t; stopPreview(); renderMovie(); }
function moveClip(d) {
  const j = sel + d;
  if (sel < 0 || j < 0 || j >= P.clips.length) return;
  [P.clips[sel], P.clips[j]] = [P.clips[j], P.clips[sel]];
  sel = j; edited(); pos = segs()[sel].t; renderMovie();
}
function onTrim(which) {
  const c = P.clips[sel];
  if (!c || c.kind === 'photo') return;
  let a = (+$('tr-a').value / 1000) * c.dur, b = (+$('tr-b').value / 1000) * c.dur;
  const gap = Math.min(0.5, c.dur);
  if (which === 'a' && a > b - gap) a = Math.max(0, b - gap);
  if (which === 'b' && b < a + gap) b = Math.min(c.dur, a + gap);
  c.start = a; c.end = b;
  fit(c);
  edited();
  $('tr-a').value = Math.round((c.start / c.dur) * 1000);
  $('tr-b').value = Math.round((c.end / c.dur) * 1000);
  trimBar();
  const s = segs()[sel];
  pos = which === 'a' ? s.t : s.t + Math.max(0, s.len - 0.05);
  $('mv-sub').textContent = `${P.clips.length} clip${P.clips.length > 1 ? 's' : ''} · ${fmt(total())}`;
  $('mv-len').textContent = fmt(total());
  $('mv-hint').textContent = `Clip ${sel + 1}: drag the white edges to cut it (${fmt(c.start)} – ${fmt(c.end)})`;
  setPos(pos);
  stillSoon();
}
$('tr-a').addEventListener('input', () => onTrim('a'));
$('tr-b').addEventListener('input', () => onTrim('b'));
function setStickerMode(on) { stickerMode = on; stopPreview(); renderMovie(); }

// ---------------------------------------------------------------------------------------------- movie maker: drawing a frame
const W = 960, H = 540;
const pool = document.createElement('div');
pool.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;overflow:hidden';
document.body.appendChild(pool);
const imgs = new Map();
function loadImg(it) {
  if (imgs.has(it.id)) return imgs.get(it.id);
  const p = new Promise((res) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = it.kind === 'photo' ? it.url : it.thumb;
  });
  imgs.set(it.id, p);
  return p;
}
function newVideo(it, muted) {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.playsInline = true;
  v.preload = 'auto';
  v.muted = !!muted;
  v.src = it.url;
  pool.appendChild(v);
  return v;
}
function ready(v) {
  return new Promise((res) => {
    if (v.readyState >= 2) return res(true);
    const ok = () => res(true), bad = () => res(false);
    v.addEventListener('loadeddata', ok, { once: true });
    v.addEventListener('error', bad, { once: true });
    setTimeout(bad, 8000);
  });
}
function seek(v, t) {
  return new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 0.04 && v.readyState >= 2) return res();
    v.addEventListener('seeked', () => res(), { once: true });
    v.currentTime = t;
    setTimeout(res, 2000);
  });
}
function dropVideo(v) { if (!v) return; try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* gone */ } v.remove(); }
const isDemoVideo = (it) => DEMO && it.kind !== 'photo' && !String(it.url).startsWith('blob:');
const demoCanvas = document.createElement('canvas');
demoCanvas.width = 640; demoCanvas.height = 480;
function demoFrame(it, t) {
  const k = S.items.indexOf(it);
  paintScene(demoCanvas.getContext('2d'), 640, 480, it.demo || SWATCH[0], t, k < 0 ? 1 : k);
  return demoCanvas;
}
function wrapWords(ctx, text, maxW) {
  const out = []; let line = '';
  for (const w of String(text).split(/\s+/)) {
    const tryL = line ? `${line} ${w}` : w;
    if (ctx.measureText(tryL).width > maxW && line) { out.push(line); line = w; } else line = tryL;
  }
  if (line) out.push(line);
  return out.slice(0, 3);
}
const WORD_STYLES = [['big', 'Big'], ['bubble', 'Bubble'], ['neon', 'Glow'], ['comic', 'Comic']];
function drawWords(ctx, w) {
  if (!w || !w.text) return;
  const big = w.style === 'big' || w.style === 'comic';
  const size = Math.round(H * (big ? 0.1 : 0.085));
  ctx.save();
  ctx.font = `900 ${size}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const text = big ? w.text.toUpperCase() : w.text;
  const lines = wrapWords(ctx, text, W * 0.86);
  const lh = size * 1.15;
  const y0 = H - H * 0.1 - (lines.length - 1) * lh;
  lines.forEach((l, i) => {
    const y = y0 + i * lh;
    if (w.style === 'bubble') {
      const tw = ctx.measureText(l).width;
      ctx.fillStyle = 'rgba(255,255,255,.94)'; rr(ctx, W / 2 - tw / 2 - size * 0.45, y - lh / 2, tw + size * 0.9, lh, lh / 2); ctx.fill();
      ctx.fillStyle = '#7c2d12'; ctx.fillText(l, W / 2, y + 2);
    } else if (w.style === 'neon') {
      ctx.shadowColor = '#ec4899'; ctx.shadowBlur = size * 0.6; ctx.fillStyle = '#fdf4ff';
      ctx.fillText(l, W / 2, y); ctx.fillText(l, W / 2, y);
    } else if (w.style === 'comic') {
      ctx.save(); ctx.translate(W / 2, y); ctx.rotate(-0.04);
      ctx.lineWidth = size * 0.16; ctx.strokeStyle = '#111827'; ctx.lineJoin = 'round'; ctx.strokeText(l, 0, 0);
      ctx.fillStyle = '#fde047'; ctx.fillText(l, 0, 0); ctx.restore();
    } else {
      ctx.fillStyle = '#7c2d12'; ctx.fillText(l, W / 2, y + size * 0.08);
      ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = size * 0.4; ctx.fillStyle = '#fff'; ctx.fillText(l, W / 2, y);
    }
  });
  ctx.restore();
}
function drawFrame(ctx, img, iw, ih, c) {
  ctx.save();
  ctx.filter = 'none';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (img && iw && ih) {
    const f = filterOf(c.fx);
    const cover = Math.max(W / iw, H / ih), contain = Math.min(W / iw, H / ih);
    const box = (k) => [(W - iw * k) / 2, (H - ih * k) / 2, iw * k, ih * k];
    if (cover / contain > 1.15) {
      ctx.filter = f === 'none' ? 'brightness(.4)' : `${f} brightness(.4)`;
      ctx.drawImage(img, ...box(cover));
      ctx.filter = f;
      ctx.drawImage(img, ...box(contain));
    } else { ctx.filter = f; ctx.drawImage(img, ...box(cover)); }
    ctx.filter = 'none';
    if (c.fx === 'rainbow') rainbowOver(ctx, W, H);
    if (c.fx === 'old') oldOver(ctx, W, H);
  }
  const s = H * 0.2;
  for (const k of c.stickers) drawSticker(ctx, k.kind, k.x * W, k.y * H, s, k.rot);
  drawWords(ctx, c.words);
  ctx.restore();
}

// The still picture shown while not playing (the picked clip at the spot on the bar).
const mvCanvas = $('mv-canvas');
mvCanvas.width = W; mvCanvas.height = H;
mvCanvas.style.objectFit = 'contain';
let stillVid = null, stillFor = null, stillSeq = 0, stillT = 0;
function stillSoon() { clearTimeout(stillT); stillT = setTimeout(still, 60); }
async function still() {
  const ctx = mvCanvas.getContext('2d');
  const list = segs();
  if (!list.length) { ctx.clearRect(0, 0, W, H); return; }
  const s = list.find((x) => pos < x.t + x.len) || list[list.length - 1];
  const c = s.c;
  const seq = ++stillSeq;
  const local = Math.max(0, Math.min(pos - s.t, s.len - 0.05));
  if (c.kind === 'photo') {
    const im = await loadImg(c.item);
    if (seq === stillSeq) drawFrame(ctx, im, im && im.naturalWidth, im && im.naturalHeight, c);
  } else if (isDemoVideo(c.item)) {
    drawFrame(ctx, demoFrame(c.item, c.start + local * c.speed), 640, 480, c);
  } else {
    if (stillFor !== c.item.id) { dropVideo(stillVid); stillVid = newVideo(c.item, true); stillFor = c.item.id; await ready(stillVid); await fixDuration(stillVid); }
    if (seq !== stillSeq) return;
    await seek(stillVid, c.start + local * c.speed);
    if (seq !== stillSeq) return;
    if (stillVid.videoWidth) drawFrame(ctx, stillVid, stillVid.videoWidth, stillVid.videoHeight, c);
    else { const im = await loadImg(c.item); drawFrame(ctx, im, im && im.naturalWidth, im && im.naturalHeight, c); }
  }
}

// ---------------------------------------------------------------------------------------------- movie maker: playing (the preview, and making the movie)
/** Plays the movie into [canvas] from [from] seconds: to the speakers, or recorded (returns the file). */
function startShow(canvas, from, record, onTime) {
  const a = ac();
  a.resume();
  const ctx = canvas.getContext('2d');
  const out = a.createGain();
  let dest = null;
  if (record) { dest = a.createMediaStreamDestination(); out.connect(dest); } else out.connect(a.destination);
  const list = segs();
  const tot = total();
  let stopped = false;
  const live = new Set();
  const music = startMusic(a, out, P.music, from, P.vol);
  let recorder = null, chunks = [], mime = '';
  let poster = '';

  async function prepare(s, off) {
    const c = s.c;
    if (c.kind === 'photo') { const im = await loadImg(c.item); return { kind: 'photo', im }; }
    if (isDemoVideo(c.item)) return { kind: 'demo' };
    const v = newVideo(c.item, false);
    live.add(v);
    await ready(v);
    await fixDuration(v);
    await seek(v, c.start + off * c.speed);
    let node = null, g = null;
    try { node = a.createMediaElementSource(v); g = a.createGain(); g.gain.value = c.voice ? 0.35 : 1; node.connect(g); g.connect(out); } catch (e) { v.muted = true; }
    return { kind: 'video', v, node, g };
  }
  function release(src) {
    if (src && src.v) { live.delete(src.v); dropVideo(src.v); try { src.g && src.g.disconnect(); } catch (e) { /* gone */ } }
  }
  function playSeg(s, src, off) {
    return new Promise((res) => {
      const c = s.c;
      const t0 = performance.now() - off * 1000;
      let voiceEl = null;
      if (c.voice) {
        voiceEl = new Audio(c.voice.url);
        try { a.createMediaElementSource(voiceEl).connect(out); } catch (e) { /* plays by itself */ }
        voiceEl.currentTime = off;
        voiceEl.play().catch(() => {});
      }
      if (src.kind === 'video') { src.v.playbackRate = c.speed; src.v.play().catch(() => {}); }
      const finish = () => { if (src.v) src.v.pause(); if (voiceEl) voiceEl.pause(); res(); };
      const frame = () => {
        if (stopped) return finish();
        const wall = (performance.now() - t0) / 1000;
        let local = wall;
        if (src.kind === 'video') {
          local = (src.v.currentTime - c.start) / c.speed;
          if (src.v.currentTime >= c.end - 0.03 || src.v.ended || wall > s.len + 3) return finish();
          if (src.v.videoWidth) drawFrame(ctx, src.v, src.v.videoWidth, src.v.videoHeight, c);
        } else {
          if (local >= s.len) return finish();
          if (src.kind === 'photo') drawFrame(ctx, src.im, src.im && src.im.naturalWidth, src.im && src.im.naturalHeight, c);
          else drawFrame(ctx, demoFrame(c.item, c.start + local * c.speed), 640, 480, c);
        }
        const t = s.t + Math.max(0, Math.min(local, s.len));
        if (record && !poster && t >= Math.min(1, tot / 2)) poster = canvas.toDataURL('image/jpeg', 0.75);
        onTime(t);
        raf(frame);
      };
      frame();
    });
  }
  const done = (async () => {
    if (record) {
      mime = pickMime(false);
      const ms = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
      recorder = new MediaRecorder(ms, { mimeType: mime, videoBitsPerSecond: 3_000_000 });
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start(1000);
    }
    let k = Math.max(0, list.findIndex((s) => from < s.t + s.len));
    const first = k;
    let next = prepare(list[k], from - list[k].t);
    for (; k < list.length && !stopped; k++) {
      const s = list[k];
      const src = await next;
      next = k + 1 < list.length ? prepare(list[k + 1], 0) : null;
      if (stopped) { release(src); break; }
      await playSeg(s, src, k === first ? from - s.t : 0);
      release(src);
    }
    if (next) next.then(release);
    music.stop();
    for (const v of live) dropVideo(v);
    if (!recorder) return null;
    await sleep(300);
    await new Promise((r) => { recorder.onstop = r; recorder.stop(); });
    try { out.disconnect(); } catch (e) { /* gone */ }
    if (stopped) return null;
    return { blob: new Blob(chunks, { type: mime.split(';')[0] }), mime: mime.split(';')[0], poster: poster || canvas.toDataURL('image/jpeg', 0.75) };
  })();
  return { stop() { stopped = true; }, done };
}

let playing = null;
function playPreview() {
  if (playing) return stopPreview();
  if (!P.clips.length) return;
  if (pos >= total() - 0.1) pos = 0;
  $('mv-preview').classList.add('playing');
  const show = startShow(mvCanvas, pos, false, (t) => setPos(t));
  playing = show;
  show.done.then(() => {
    if (playing !== show) return;
    playing = null;
    $('mv-preview').classList.remove('playing');
    if (pos >= total() - 0.15) setPos(0);
    still();
  });
}
function stopPreview() {
  if (!playing) return;
  playing.stop();
  playing = null;
  $('mv-preview').classList.remove('playing');
}
$('mv-bar').addEventListener('click', (e) => {
  const r = $('mv-bar').getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * total();
  const wasPlaying = !!playing;
  stopPreview();
  setPos(t);
  const k = segs().findIndex((s) => t < s.t + s.len);
  if (k >= 0) { sel = k; renderMovie(); }
  if (wasPlaying) setTimeout(playPreview, 50);
});
$('mv-preview').addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  if (stickerMode) {
    const c = P.clips[sel];
    if (!c) return;
    const r = mvCanvas.getBoundingClientRect();
    // The canvas is shown "contain": find the movie's box in it.
    const k = Math.min(r.width / W, r.height / H);
    const bw = W * k, bh = H * k, bx = r.left + (r.width - bw) / 2, by = r.top + (r.height - bh) / 2;
    const x = (e.clientX - bx) / bw, y = (e.clientY - by) / bh;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const hitR = (H * 0.2 * k) / 2;
    const hit = c.stickers.findIndex((s) => Math.hypot((s.x - x) * bw, (s.y - y) * bh) < hitR);
    if (hit >= 0) c.stickers.splice(hit, 1);
    else if (c.stickers.length < 10) c.stickers.push({ kind: stickerKind, x, y, rot: Math.round(Math.random() * 24 - 12) });
    edited();
    renderMovie();
    return;
  }
  if (playing) stopPreview(); else playPreview();
});

// ---------------------------------------------------------------------------------------------- movie maker: the tools
function sheet(html) {
  const p = $('tool-panel');
  p.className = 'panel';
  p.innerHTML = `<i class="grab"></i>${html}`;
  $('sh-tool').classList.add('show');
  return p;
}
function toolAdd() {
  const list = S.items;
  const chosen = new Set();
  const draw = () => {
    const p = sheet(`<h2>Add clips</h2><p>Pick photos and videos for your movie.</p>
      <div class="pgrid">${list.map((it) => `<button class="cell ${chosen.has(it.id) ? 'on' : ''}" data-add="${esc(it.id)}" aria-label="${it.kind === 'photo' ? 'Photo' : 'Video'}" style="background-image:url('${esc(it.thumb)}')">${chosen.has(it.id) ? '<span class="ck"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg></span>' : ''}${it.kind === 'photo' ? '' : `<span class="tag"><svg viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>${fmt(it.dur)}</span>`}</button>`).join('') || '<div class="empty" style="grid-column:1/-1">No photos yet. Take some with the camera!</div>'}</div>
      <div class="btns"><button class="ghost" data-close>Cancel</button><button class="primary" data-act="add-yes" ${chosen.size ? '' : 'disabled'}>${chosen.size ? `Add ${chosen.size}` : 'Add'}</button></div>`);
    p.classList.add('tall');
  };
  toolAdd.toggle = (id) => { chosen.has(id) ? chosen.delete(id) : chosen.add(id); const top = $('tool-panel').querySelector('.pgrid').scrollTop; draw(); $('tool-panel').querySelector('.pgrid').scrollTop = top; };
  toolAdd.yes = () => {
    const its = list.filter((i) => chosen.has(i.id)).reverse();
    closeSheet();
    const n0 = P.clips.length;
    addClips(its);
    edited();
    if (P.clips.length > n0) sel = n0;
    pos = segs()[sel] ? segs()[sel].t : 0;
    renderMovie();
  };
  draw();
}
function toolMusic() {
  const draw = () => sheet(`<h2>Music</h2><p>Tap one to hear it.</p>
    <div class="list">${TRACKS.map((t) => `<button class="opt ${P.music === t.id ? 'on' : ''}" data-music="${t.id}"><svg viewBox="0 0 24 24">${t.id === 'none' ? '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>' : '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'}</svg>${t.name}${t.id === 'none' ? '' : `<small>${t.id === 'calm' ? 'slow' : t.id === 'ukulele' ? 'happy' : 'dance'}</small>`}</button>`).join('')}</div>
    <label class="vol ${P.music === 'none' ? 'hidden' : ''}">Volume<input type="range" id="vol" min="0" max="100" value="${Math.round(P.vol * 100)}" aria-label="Music volume"><span id="vol-t">${Math.round(P.vol * 100)}%</span></label>
    <div class="btns"><button class="primary" data-close>Done</button></div>`);
  draw();
  toolMusic.pick = (id) => { P.music = id; edited(); draw(); bindVol(); playSample(id); renderMovie(); };
  const bindVol = () => { const v = $('vol'); if (v) v.oninput = () => { P.vol = +v.value / 100; $('vol-t').textContent = `${v.value}%`; renderMovie(); }; };
  bindVol();
}
function toolWords() {
  const c = P.clips[sel];
  let style = c.words ? c.words.style : 'big';
  const draw = () => {
    const keep = $('w-text') ? $('w-text').value : c.words ? c.words.text : '';
    sheet(`<h2>Words</h2><p>Big words on clip ${sel + 1}.</p>
      <input type="text" id="w-text" maxlength="60" placeholder="Type your words" value="${esc(keep)}" autocomplete="off">
      <div class="opts">${WORD_STYLES.map(([k, n]) => `<button class="opt ${style === k ? 'on' : ''}" data-wstyle="${k}">${n}</button>`).join('')}</div>
      <div class="btns">${c.words ? '<button class="ghost" data-act="words-off">Remove words</button>' : '<button class="ghost" data-close>Cancel</button>'}<button class="primary" data-act="words-yes">Put on clip</button></div>`);
  };
  draw();
  setTimeout(() => $('w-text') && $('w-text').focus(), 50);
  toolWords.style = (k) => { style = k; draw(); };
  toolWords.yes = () => { const t = $('w-text').value.trim(); c.words = t ? { text: t, style } : null; edited(); closeSheet(); renderMovie(); };
  toolWords.off = () => { c.words = null; edited(); closeSheet(); renderMovie(); };
}
function toolSpeed() {
  const c = P.clips[sel];
  sheet(`<h2>Speed</h2><p>How fast clip ${sel + 1} plays.</p>
    <div class="opts">${[[0.5, 'Slow 0.5×'], [1, 'Normal 1×'], [2, 'Fast 2×']].map(([v, n]) => `<button class="opt ${c.speed === v ? 'on' : ''}" data-speed="${v}">${n}</button>`).join('')}</div>
    <div class="btns"><button class="primary" data-close>Done</button></div>`);
}
function toolFilters() {
  const c = P.clips[sel];
  sheet(`<h2>Filters</h2><p>A look for clip ${sel + 1}.</p>
    <div class="opts">${MOVIE_FX.map(([k, n]) => `<button class="opt ${c.fx === k ? 'on' : ''}" data-mfx="${k}">${n}</button>`).join('')}</div>
    <div class="btns"><button class="ghost" data-act="fx-all">Use on every clip</button><button class="primary" data-close>Done</button></div>`);
}
const voice = { on: false, rec: null, stream: null, chunks: [], at: 0, tick: 0 };
function toolVoice() {
  const c = P.clips[sel];
  const max = Math.min(30, Math.ceil(clipLen(c)));
  sheet(`<h2>Voice</h2><p>Say something for clip ${sel + 1} (up to ${max} seconds). It plays when the clip starts.</p>
    <button class="recbtn" id="v-rec" data-act="voice-rec" aria-label="Record"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
    <p class="center-t" id="v-t">${c.voice ? `Your voice: ${fmt(c.voice.dur)}` : 'Tap the red button and talk.'}</p>
    <div class="btns">${c.voice ? '<button class="ghost" data-act="voice-play">Listen</button><button class="ghost" data-act="voice-off">Remove</button>' : ''}<button class="primary" data-close>Done</button></div>`);
  toolVoice.max = max;
}
async function startVoice() {
  const c = P.clips[sel];
  if (!c) return;
  if (voice.on) return stopVoice();
  const mime = pickMime(true);
  let s = null;
  try { s = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { s = null; }
  if (!s || !mime) return ($('v-t').textContent = 'The microphone is off. A grown-up can turn it on.');
  voice.stream = s; voice.chunks = []; voice.clip = c;
  voice.rec = new MediaRecorder(s, { mimeType: mime });
  voice.rec.ondataavailable = (e) => { if (e.data && e.data.size) voice.chunks.push(e.data); };
  voice.rec.onstop = () => {
    const dur = (performance.now() - voice.at) / 1000;
    const blob = new Blob(voice.chunks, { type: mime.split(';')[0] });
    voice.stream.getTracks().forEach((t) => t.stop());
    if (blob.size && dur > 0.4) { if (voice.clip.voice) URL.revokeObjectURL(voice.clip.voice.url); voice.clip.voice = { url: URL.createObjectURL(blob), dur }; edited(); }
    if ($('sh-tool').classList.contains('show')) toolVoice();
    renderMovie();
  };
  voice.rec.start();
  voice.on = true;
  voice.at = performance.now();
  $('v-rec').classList.add('on');
  voice.tick = setInterval(() => {
    const t = (performance.now() - voice.at) / 1000;
    const el = $('v-t'); if (el) el.textContent = `Recording… ${fmt(t)} (tap to stop)`;
    if (t >= (toolVoice.max || 30)) stopVoice();
  }, 200);
}
function stopVoice() {
  if (!voice.on) return;
  voice.on = false;
  clearInterval(voice.tick);
  try { voice.rec.stop(); } catch (e) { /* stopped */ }
}

// ---------------------------------------------------------------------------------------------- making the movie
let making = null;
async function makeMovie() {
  if (!P.clips.length) return toast('Add some clips first.');
  if (!window.MediaRecorder || !pickMime(false)) return toast("This phone can't make movies here.");
  stopPreview();
  go('making');
  awake(true);
  const cv = $('mk-canvas');
  cv.width = W; cv.height = H;
  const tot = total();
  const pct = (p) => { $('mk-t').textContent = `Making your movie… ${Math.floor(p * 100)}%`; $('mk-fill').style.width = `${p * 100}%`; };
  pct(0);
  const show = startShow(cv, 0, true, (t) => pct((t / tot) * 0.92));
  making = show;
  let res = null;
  try { res = await show.done; } catch (e) { res = null; }
  if (making !== show) return;
  if (!res || !res.blob.size) { making = null; awake(false); if (view === 'making') { toast("That didn't work. Try again."); back(); } return; }
  try {
    const it = await saveBlob(res.blob, { kind: 'movie', mime: res.mime, title: P.title, dur: Math.round(tot * 10) / 10, poster: res.poster }, (p) => pct(0.92 + p * 0.08));
    if (!it.thumb) it.thumb = res.poster;
    P.made = it;
    making = null;
    awake(false);
    pct(1);
    showDone(it);
  } catch (e) {
    making = null; awake(false);
    toast("Your movie didn't save. Try again.");
    back();
  }
}
function stopMaking() {
  if (making) { making.stop(); making = null; awake(false); }
  if (view === 'making') { const prev = stack.pop(); show(prev && prev !== 'making' ? prev : 'movie'); }
}
function showDone(it) {
  $('dn-sub').textContent = `${it.title || 'My movie'} · ${fmt(it.dur)} · saved in My movies`;
  $('dn-dur').textContent = fmt(it.dur);
  const p = $('dn-poster');
  const old = p.querySelector('video'); if (old) old.remove();
  p.querySelector('.play').classList.remove('hidden');
  p.style.backgroundImage = it.thumb ? `url("${it.thumb}")` : '';
  go('done', view === 'making');
}
function watchDone() {
  const it = P.made;
  if (!it) return;
  const p = $('dn-poster');
  if (DEMO && !String(it.url).startsWith('blob:')) return toast('(The movie plays on the phone)');
  p.querySelector('.play').classList.add('hidden');
  const v = document.createElement('video');
  v.controls = true; v.playsInline = true; v.autoplay = true; v.src = it.url;
  p.appendChild(v);
  fixDuration(v);
}
function renameSheet() {
  sheet(`<h2>Name your movie</h2>
    <input type="text" id="r-title" maxlength="60" value="${esc(P.title)}" autocomplete="off">
    <div class="btns"><button class="ghost" data-close>Cancel</button><button class="primary" data-act="rename-yes">OK</button></div>`);
  setTimeout(() => { const i = $('r-title'); if (i) { i.focus(); i.select(); } }, 50);
}

// ---------------------------------------------------------------------------------------------- taps
document.addEventListener('click', (e) => {
  const t = e.target.closest('button,[data-close]');
  if (!t || t.disabled) return;
  if (t.hasAttribute('data-close')) return closeSheet();
  if (t.dataset.fx) return setFx(t.dataset.fx);
  if (t.dataset.stk) {
    if (view === 'camera') { cam.sticker = t.dataset.stk; renderTray(); } else { stickerKind = t.dataset.stk; renderMovie(); }
    return;
  }
  if (t.dataset.tab) { tab = t.dataset.tab; return renderPhotos(); }
  if (t.dataset.item) {
    if (pressed) { pressed = false; return; }
    return picks.size ? togglePick(t.dataset.item) : openViewer(t.dataset.item);
  }
  if (t.dataset.clip) return selectClip(+t.dataset.clip);
  if (t.dataset.add) return toolAdd.toggle(t.dataset.add);
  if (t.dataset.music) return toolMusic.pick(t.dataset.music);
  if (t.dataset.wstyle) return toolWords.style(t.dataset.wstyle);
  if (t.dataset.speed) { const c = P.clips[sel]; c.speed = +t.dataset.speed; fit(c); edited(); toolSpeed(); return renderMovie(); }
  if (t.dataset.mfx) { P.clips[sel].fx = t.dataset.mfx; edited(); toolFilters(); return renderMovie(); }
  switch (t.dataset.act) {
    case 'home': return post({ cmd: 'home' });
    case 'back': if (view === 'viewer') closeViewer(); if (!back()) post({ cmd: 'home' }); return;
    case 'cam-retry': stopCamera(); return startCamera();
    case 'flash': return toggleTorch();
    case 'timer': cam.timer = !cam.timer; t.classList.toggle('on', cam.timer); return toast(cam.timer ? 'Timer on: 3 seconds' : 'Timer off');
    case 'flip': return flip();
    case 'photo-mode': return setCamMode('photo');
    case 'video-mode': return setCamMode('video');
    case 'shoot': return shoot();
    case 'cam-clear': cam.stickers = []; return drawCamStickers();
    case 'photos': if (rec.on) return; picks.clear(); return go('photos');
    case 'movie': if (rec.on) return; return go('movie');
    case 'unpick-all': picks.clear(); return renderPhotos();
    case 'texts': return sendInTexts(view === 'viewer' ? [viewing] : [...picks]);
    case 'make': {
      const ids = view === 'viewer' ? [viewing] : [...picks];
      const its = S.items.filter((i) => ids.includes(i.id)).reverse();
      if (view === 'viewer') closeViewer();
      picks.clear();
      if (P.made) { P = newProject(); sel = -1; }
      addClips(its);
      edited();
      return go('movie');
    }
    case 'delete': return askDelete(view === 'viewer' ? [viewing] : [...picks]);
    case 'delete-yes': return doDelete();
    case 'rename': return renameSheet();
    case 'rename-yes': { const v = $('r-title').value.trim(); P.title = v.slice(0, 60) || 'My movie'; edited(); closeSheet(); return renderMovie(); }
    case 'done': return makeMovie();
    case 'play': return playPreview();
    case 'left': return moveClip(-1);
    case 'right': return moveClip(1);
    case 'tool-add': stopPreview(); return toolAdd();
    case 'add-yes': return toolAdd.yes();
    case 'tool-music': stopPreview(); return toolMusic();
    case 'tool-words': stopPreview(); return toolWords();
    case 'words-yes': return toolWords.yes();
    case 'words-off': return toolWords.off();
    case 'tool-stickers': return setStickerMode(!stickerMode);
    case 'mv-clear': if (P.clips[sel]) { P.clips[sel].stickers = []; edited(); } return renderMovie();
    case 'tool-speed': stopPreview(); return toolSpeed();
    case 'tool-filters': stopPreview(); return toolFilters();
    case 'fx-all': { const f = P.clips[sel].fx; P.clips.forEach((c) => { c.fx = f; }); edited(); closeSheet(); toast('Every clip has that look now'); return renderMovie(); }
    case 'tool-voice': stopPreview(); return toolVoice();
    case 'voice-rec': return startVoice();
    case 'voice-play': { const c = P.clips[sel]; if (c && c.voice) new Audio(c.voice.url).play().catch(() => {}); return; }
    case 'voice-off': { const c = P.clips[sel]; if (c && c.voice) { URL.revokeObjectURL(c.voice.url); c.voice = null; edited(); } toolVoice(); return renderMovie(); }
    case 'remove': {
      if (sel < 0) return;
      stopPreview();
      P.clips.splice(sel, 1);
      edited();
      sel = Math.min(sel, P.clips.length - 1);
      pos = sel >= 0 ? segs()[sel].t : 0;
      toast('Clip taken out of the movie');
      return renderMovie();
    }
    case 'stop-making': return stopMaking();
    case 'watch': return watchDone();
    case 'done-texts': return P.made && sendInTexts([P.made.id]);
    case 'done-screen': if (!P.made) return; t.disabled = true; t.dataset.wait = '1'; setTimeout(() => { t.disabled = false; }, 15000); return post({ cmd: 'familyScreen', id: P.made.id });
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'r-title') document.querySelector('[data-act=rename-yes]')?.click();
  if (e.target.id === 'w-text') document.querySelector('[data-act=words-yes]')?.click();
});

// The phone went to sleep or another app opened: let go of the camera (a video being made is kept).
function pause() {
  if (rec.on) stopRecording();
  stopCamera();
  stopPreview();
  stopSample();
  if (voice.on) stopVoice();
  if (making) { making.stop(); making = null; awake(false); if (view === 'making') { stopMaking(); toast("Making stopped. Tap Done to try again."); } }
  if (view === 'viewer') closeViewer();
}
window.__pause = pause;
window.__resume = () => { if (view === 'camera') startCamera(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else window.__resume(); });

// ---------------------------------------------------------------------------------------------- from the phone
window.__studio = (m) => {
  switch (m.type) {
    case 'state': {
      const known = S.items;
      S = m;
      // Keep pictures the page already made for a movie that the phone doesn't have a thumb for yet.
      for (const it of S.items) { const k = known.find((x) => x.id === it.id); if (k && k.demo) it.demo = k.demo; }
      applyLock();
      renderLast();
      if (view === 'photos') { for (const id of [...picks]) if (!itemById(id)) picks.delete(id); renderPhotos(); }
      if (view === 'viewer' && viewing && !itemById(viewing)) { closeViewer(); back(); }
      break;
    }
    case 'go': stack = []; show(m.mode === 'photos' || m.mode === 'movie' ? m.mode : 'camera'); break;
    case 'toast': toast(m.text); break;
    case 'sent': sentDone(); break;
    case 'familyScreen': toast(m.message); for (const b of document.querySelectorAll('[data-act=done-screen]')) b.disabled = false; break;
  }
};

setFx('normal');
post({ cmd: 'hello' });

// ---------------------------------------------------------------------------------------------- a made-up phone (browser preview)
function demoItems() {
  const now = Date.now();
  const kinds = [['photo'], ['video', 12], ['photo'], ['photo'], ['video', 34], ['photo'], ['photo'], ['video', 65], ['photo'], ['photo'], ['photo'], ['video', 8]];
  const out = kinds.map(([kind, dur], i) => ({
    id: `d${i}`, kind, title: '', at: now - (i + 1) * 9 * 60000, dur: dur || 0, mime: kind === 'photo' ? 'image/jpeg' : 'video/webm',
    url: kind === 'photo' ? sceneURL(SWATCH[i], i, 900, 1200) : `demo:${i}`, thumb: sceneURL(SWATCH[i], i, 240, 240), demo: SWATCH[i],
  }));
  out.push({ id: 'dm', kind: 'movie', title: 'Pool party', at: now - 26 * 3600000, dur: 41, mime: 'video/webm', url: 'demo:m', thumb: sceneURL(SWATCH[4], 4, 240, 240), demo: SWATCH[4] });
  out.push({ id: 'dy', kind: 'photo', title: '', at: now - 27 * 3600000, dur: 0, mime: 'image/jpeg', url: sceneURL(SWATCH[9], 9, 900, 1200), thumb: sceneURL(SWATCH[9], 9, 240, 240), demo: SWATCH[9] });
  return out;
}
function demo(o) {
  const v = Q.get('view') || 'camera';
  setTimeout(() => {
    if (o.cmd === 'hello') {
      const bed = Q.has('bed') || v === 'closed';
      window.__studio({ type: 'state', me: 'Mia', locked: bed, lockReason: bed ? 'bedtime' : undefined, until: bed ? new Date(new Date().setHours(31, 0, 0, 0)).toISOString() : undefined, items: demoItems() });
      const mode = v === 'photos' || v === 'viewer' ? 'photos' : ['movie', 'making', 'done'].includes(v) ? 'movie' : 'camera';
      window.__studio({ type: 'go', mode });
      if (v === 'camera') {
        cam.stickers = [{ kind: 'wow', x: 0.74, y: 0.27, rot: 8 }, { kind: 'star', x: 0.23, y: 0.66, rot: 0 }];
        setFx('stickers');
      }
      if (v === 'photos') { picks.add('d0'); renderPhotos(); }
      if (v === 'viewer') openViewer('d0');
      if (['movie', 'making', 'done'].includes(v)) {
        const its = S.items;
        P.title = 'Zoo day';
        addClips([its[1], its[4], its[2], its[7]]);
        P.clips[1].end = 16; P.clips[3].end = 16; P.clips[1].start = 0;
        P.clips[1].words = { text: 'Look at the lions!', style: 'big' };
        P.clips[0].stickers = [{ kind: 'star', x: 0.8, y: 0.25, rot: 0 }];
        P.clips[2].voice = null;
        sel = 1; pos = segs()[1].t + 1.5;
        renderMovie();
        const sh = Q.get('sheet');
        if (sh === 'stickers') setStickerMode(true);
        else if (sh) document.querySelector(`[data-act=tool-${sh}]`)?.click();
      }
      if (v === 'making') {
        go('making');
        const cv = $('mk-canvas'); cv.width = W; cv.height = H;
        drawFrame(cv.getContext('2d'), demoFrame(P.clips[1].item, 2), 640, 480, P.clips[1]);
        $('mk-t').textContent = 'Making your movie… 40%'; $('mk-fill').style.width = '40%';
      }
      if (v === 'done') {
        const it = { id: 'dz', kind: 'movie', title: 'Zoo day', at: Date.now(), dur: 48, url: 'demo:z', thumb: sceneURL(SWATCH[0], 0, 640, 360) };
        P.made = it;
        go('making');
        showDone(it);
      }
    }
    if (o.cmd === 'home') toast('(Back to the launcher)');
    if (o.cmd === 'delete') toast('(Deleted on the phone; the server is told)');
    if (o.cmd === 'texts') { toast('(Texts opens so you can pick who)'); setTimeout(() => window.__studio({ type: 'sent' }), 800); }
    if (o.cmd === 'familyScreen') setTimeout(() => window.__studio({ type: 'familyScreen', message: 'Sent! It plays on the family screen soon.' }), 600);
  }, 10);
}
