// Mock mode (VITE_MOCK=1): an in-memory stand-in for the server so the console can
// be checked without it. Every response follows the shapes in SPEC.md.
// URL switches: ?empty=1 (brand-new account), ?locked=1 (trial over), ?signedout=1 (401).
import type { FetchLike } from './client';
import type {
  Account, AppLimit, Contact, DashKid, Dashboard, Device, Kid, KidApp, KidRequest, LockReason, Report,
} from './types';

interface MKid extends Kid { used: number; grants: number; status: string }
interface MApp extends KidApp { kidId: string }
interface MContact extends Contact { kidId: string }

function isoDay(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
let seq = 100;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const MAX = '00000000-0000-4000-8000-000000000001';
const AVA = '00000000-0000-4000-8000-000000000002';

const kidDefaults = {
  limitSchoolMinutes: 120, limitWeekendMinutes: 180,
  bedSchoolStart: '20:30', bedSchoolEnd: '06:00', bedOtherStart: '21:30', bedOtherEnd: '07:00',
  bedtimeEnabled: true, onlyAllowedSites: true, safeSearch: true, youtubeRestricted: true, blockPrivate: true,
  locked: false,
};

function seed(empty: boolean) {
  const account: Account = {
    id: '00000000-0000-4000-8000-0000000000aa', email: 'parent@example.com', timezone: 'America/Denver',
    plan: 'trial', trialEndsAt: new Date(Date.now() + 23 * 864e5).toISOString(), trialDaysLeft: 23,
    pausedAll: false, hasPin: false,
  };
  if (empty) {
    return { account, kids: [] as MKid[], apps: [] as MApp[], contacts: [] as MContact[], devices: [] as Device[], requests: [] as KidRequest[] };
  }
  const kids: MKid[] = [
    { ...kidDefaults, id: MAX, name: 'Max', color: '#4f61b8', used: 78, grants: 0, status: 'Playing Minecraft' },
    { ...kidDefaults, id: AVA, name: 'Ava', color: '#34d399', limitSchoolMinutes: 90, limitWeekendMinutes: 90, used: 90, grants: 0, status: '' },
  ];
  const app = (kidId: string, a: Omit<MApp, 'id' | 'kidId'>): MApp => ({ ...a, id: newId(), kidId });
  const apps: MApp[] = [
    app(MAX, { kind: 'app', platform: 'windows', identifier: 'minecraft.exe', name: 'Minecraft', allowed: true, free: false, limitMinutes: 60, usedMinutes: 48 }),
    app(MAX, { kind: 'app', platform: 'windows', identifier: 'scratch.exe', name: 'Scratch', allowed: true, free: true, limitMinutes: null, usedMinutes: 20 }),
    app(MAX, { kind: 'site', platform: 'any', identifier: 'khanacademy.org', name: 'khanacademy.org', allowed: true, free: true, limitMinutes: null, usedMinutes: 10 }),
    app(MAX, { kind: 'site', platform: 'any', identifier: 'youtube.com', name: 'YouTube', allowed: true, free: false, limitMinutes: 30, usedMinutes: 0 }),
    app(MAX, { kind: 'app', platform: 'windows', identifier: 'steam.exe', name: 'Steam', allowed: false, free: false, limitMinutes: null, usedMinutes: 0 }),
    app(AVA, { kind: 'app', platform: 'android', identifier: 'com.google.android.apps.youtube.kids', name: 'YouTube Kids', allowed: true, free: false, limitMinutes: 30, usedMinutes: 10 }),
    app(AVA, { kind: 'app', platform: 'android', identifier: 'org.khanacademy.android', name: 'Khan Academy Kids', allowed: true, free: true, limitMinutes: null, usedMinutes: 25 }),
    app(AVA, { kind: 'app', platform: 'android', identifier: 'com.android.chrome', name: 'Chrome', allowed: true, free: false, limitMinutes: null, usedMinutes: 80 }),
  ];
  const contact = (kidId: string, name: string, phone: string, canText: boolean): MContact =>
    ({ id: newId(), kidId, name, phone, canCall: true, canText });
  const contacts: MContact[] = [
    contact(MAX, 'Mom', '555 0101', true), contact(MAX, 'Dad', '555 0102', true), contact(MAX, 'Grandma', '555 0103', false),
    contact(AVA, 'Mom', '555 0101', true), contact(AVA, 'Dad', '555 0102', true),
  ];
  const devices: Device[] = [
    { id: newId(), name: "Max's PC", platform: 'windows', model: 'Desktop', osVersion: 'Windows 11', appVersion: '1.0.0', kidId: MAX, kidName: 'Max', status: 'in_use', lastSeenAt: ago(0) },
    { id: newId(), name: "Ava's phone", platform: 'android', model: 'Pixel 7a', osVersion: 'Android 15', appVersion: '1.0.0', kidId: AVA, kidName: 'Ava', status: 'locked', lastSeenAt: ago(1) },
    { id: newId(), name: 'Family laptop', platform: 'windows', model: 'Laptop', osVersion: 'Windows 11', appVersion: '1.0.0', kidId: MAX, kidName: 'Max', status: 'off', lastSeenAt: ago(60 * 26) },
  ];
  const requests: KidRequest[] = [
    { id: newId(), kidId: MAX, kidName: 'Max', deviceId: devices[0]!.id, deviceName: "Max's PC", kind: 'time', minutes: 15, detail: null, identifier: null, status: 'pending', createdAt: ago(2), decidedAt: null },
    { id: newId(), kidId: AVA, kidName: 'Ava', deviceId: devices[1]!.id, deviceName: "Ava's phone", kind: 'app', minutes: null, detail: 'Duolingo', identifier: 'com.duolingo', status: 'pending', createdAt: ago(40), decidedAt: null },
    { id: newId(), kidId: MAX, kidName: 'Max', deviceId: devices[0]!.id, deviceName: "Max's PC", kind: 'site', minutes: null, detail: 'coolmathgames.com', identifier: 'coolmathgames.com', status: 'denied', createdAt: ago(60 * 27), decidedAt: ago(60 * 26) },
    { id: newId(), kidId: AVA, kidName: 'Ava', deviceId: devices[1]!.id, deviceName: "Ava's phone", kind: 'time', minutes: 30, detail: null, identifier: null, status: 'approved', createdAt: ago(60 * 50), decidedAt: ago(60 * 50 - 4) },
  ];
  return { account, kids, apps, contacts, devices, requests };
}

const WEEK: Record<string, number[]> = { [MAX]: [72, 104, 48, 150, 96, 142, 78], [AVA]: [95, 60, 170, 105, 140, 92, 90] };
const BLOCKED = [1, 2, 0, 1, 2, 0, 2];

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

type Body = Record<string, unknown>;
const str = (b: Body, k: string): string | undefined => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
const num = (b: Body, k: string): number | undefined => (typeof b[k] === 'number' ? (b[k] as number) : undefined);
const bool = (b: Body, k: string): boolean | undefined => (typeof b[k] === 'boolean' ? (b[k] as boolean) : undefined);

export function createMockFetch(search: string): FetchLike {
  const params = new URLSearchParams(search);
  const s = seed(params.has('empty'));
  let signedIn = !params.has('signedout');
  if (params.has('locked')) { s.account.plan = 'locked'; s.account.trialDaysLeft = 0; }

  const isWeekend = () => [0, 6].includes(new Date().getDay());
  const limitOf = (k: MKid) => (isWeekend() ? k.limitWeekendMinutes : k.limitSchoolMinutes) + k.grants;
  const today = (k: MKid) => {
    const limitMinutes = limitOf(k);
    const leftMinutes = Math.max(0, limitMinutes - k.used);
    const lockReason: LockReason = s.account.pausedAll ? 'paused' : k.locked ? 'parent' : leftMinutes === 0 ? 'time' : null;
    return { limitMinutes, usedMinutes: k.used, leftMinutes, locked: lockReason !== null, lockReason };
  };
  const statusText = (k: MKid, r: LockReason) =>
    r === 'paused' ? 'All screens are paused' : r === 'parent' ? 'Locked by a parent. Family calls still work'
      : r === 'time' ? 'Time is up. Family calls still work' : k.status || 'Not on a screen right now';
  const kidOr404 = (id: string | undefined) => {
    const k = s.kids.find((x) => x.id === id);
    if (!k) throw new HttpError(404, 'That kid could not be found.');
    return k;
  };
  const publicKid = (k: MKid): Kid => {
    const { used: _u, grants: _g, status: _s, ...rest } = k;
    return rest;
  };

  function dashboard(): Dashboard {
    const kids: DashKid[] = s.kids.map((k) => {
      const t = today(k);
      return { id: k.id, name: k.name, color: k.color, ...t, statusText: statusText(k, t.lockReason), bedtimeTonight: k.bedtimeEnabled ? k.bedSchoolStart : null };
    });
    const week = [6, 5, 4, 3, 2, 1, 0].map((off, i) => ({
      day: isoDay(off),
      minutes: Object.fromEntries(s.kids.map((k) => [k.id, off === 0 ? k.used : WEEK[k.id]?.[i] ?? 0])),
    }));
    const appLimits: AppLimit[] = s.apps.filter((a) => a.allowed && a.limitMinutes != null).map((a) => ({
      kidId: a.kidId, kidName: kidOr404(a.kidId).name, appName: a.name, usedMinutes: a.usedMinutes, limitMinutes: a.limitMinutes ?? 0,
    }));
    const limit = kids.reduce((n, k) => n + k.limitMinutes, 0);
    const used = kids.reduce((n, k) => n + Math.min(k.usedMinutes, k.limitMinutes), 0);
    return {
      kids,
      devices: s.devices.map((d) => {
        const r = today(kidOr404(d.kidId)).lockReason;
        return { ...d, status: d.status === 'off' ? 'off' : r ? 'locked' : 'in_use' };
      }),
      requests: s.requests.filter((r) => r.status === 'pending'),
      week,
      blocked: [6, 5, 4, 3, 2, 1, 0].map((off, i) => ({ day: isoDay(off), count: s.kids.length ? BLOCKED[i] ?? 0 : 0 })),
      appLimits,
      familyPercent: limit ? Math.round((used / limit) * 100) : 0,
      pausedAll: s.account.pausedAll,
    };
  }

  function report(kidId: string, days: number): Report {
    const k = kidOr404(kidId);
    const names = s.apps.filter((a) => a.kidId === kidId && a.allowed).map((a) => a.name);
    const list = Array.from({ length: days }, (_, i) => {
      const off = days - 1 - i;
      const base = WEEK[kidId] ?? [60, 80, 40, 100, 70, 120, 50];
      const minutes = off === 0 ? k.used : off < 7 ? base[6 - off] ?? 0 : 40 + ((off * 37 + k.name.length * 11) % 110);
      const shares = [0.5, 0.25, 0.15, 0.1];
      const byApp = names.slice(0, 4).map((name, j) => ({ name, minutes: Math.round(minutes * (shares[j] ?? 0)) })).filter((a) => a.minutes > 0);
      return { day: isoDay(off), minutes, byApp };
    });
    return {
      days: list,
      blocked: [
        { host: 'coolmathgames.com', count: days === 7 ? 3 : 7, lastAt: ago(55) },
        { host: 'twitch.tv', count: days === 7 ? 1 : 4, lastAt: ago(60 * 30) },
      ],
    };
  }

  function route(method: string, path: string, query: URLSearchParams, b: Body): unknown {
    const seg = path.split('/').filter(Boolean).slice(1); // drop "api"
    const key = `${method} /${seg.join('/')}`;

    if (key === 'POST /auth/request-link') {
      if (!str(b, 'email')?.includes('@')) throw new HttpError(400, 'Please enter a valid email address.');
      return { ok: true, devLink: '/?mock-signed-in=1' };
    }
    if (key === 'POST /auth/logout') { signedIn = false; return { ok: true }; }
    if (!signedIn) throw new HttpError(401, 'Please sign in.');
    if (key === 'GET /me') return { account: s.account };
    if (key === 'GET /billing') {
      return { plan: s.account.plan, trialEndsAt: s.account.trialEndsAt, trialDaysLeft: s.account.trialDaysLeft, prices: { month: 4, year: 36 }, stripeReady: false };
    }
    if (s.account.plan === 'locked') {
      throw new HttpError(402, 'Your free trial has ended. Choose a plan to keep using the console.', { locked: true });
    }
    if (key === 'POST /billing/checkout' || key === 'POST /billing/portal') {
      throw new HttpError(503, 'Billing is not set up on this server yet.');
    }
    if (key === 'PATCH /account') {
      const tz = str(b, 'timezone'); const pin = str(b, 'pin');
      if (pin !== undefined && !/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'The PIN must be 4 to 8 digits.');
      if (tz) s.account.timezone = tz;
      if (pin) s.account.hasPin = true;
      return { account: s.account };
    }
    if (key === 'GET /dashboard') return dashboard();
    if (key === 'POST /pause-all') { s.account.pausedAll = bool(b, 'paused') ?? false; return { ok: true, pausedAll: s.account.pausedAll }; }

    if (key === 'GET /kids') return { kids: s.kids.map(publicKid) };
    if (key === 'POST /kids') {
      const name = str(b, 'name')?.trim();
      if (!name) throw new HttpError(400, 'Please give the kid a name.');
      const kid: MKid = { ...kidDefaults, id: newId(), name, color: str(b, 'color') ?? '#4f61b8', used: 0, grants: 0, status: '' };
      s.kids.push(kid);
      return { kid: publicKid(kid) };
    }
    if (seg[0] === 'kids' && seg[1]) {
      const k = kidOr404(seg[1]);
      if (seg.length === 2 && method === 'GET') {
        return {
          kid: publicKid(k),
          apps: s.apps.filter((a) => a.kidId === k.id).map(({ kidId: _k, ...a }) => a),
          contacts: s.contacts.filter((c) => c.kidId === k.id).map(({ kidId: _k, ...c }) => c),
          today: today(k),
        };
      }
      if (seg.length === 2 && method === 'PATCH') {
        Object.assign(k, b, { id: k.id });
        for (const d of s.devices) if (d.kidId === k.id) d.kidName = k.name;
        return { kid: publicKid(k) };
      }
      if (seg.length === 2 && method === 'DELETE') {
        s.kids = s.kids.filter((x) => x.id !== k.id);
        s.apps = s.apps.filter((x) => x.kidId !== k.id);
        s.contacts = s.contacts.filter((x) => x.kidId !== k.id);
        s.devices = s.devices.filter((x) => x.kidId !== k.id);
        s.requests = s.requests.filter((x) => x.kidId !== k.id);
        return { ok: true };
      }
      if (seg[2] === 'grant' && method === 'POST') {
        const m = num(b, 'minutes');
        if (!m || m < 1 || m > 240) throw new HttpError(400, 'Extra time must be between 1 and 240 minutes.');
        k.grants += m;
        return { ok: true };
      }
      if (seg[2] === 'lock' && method === 'POST') { k.locked = bool(b, 'locked') ?? false; return { ok: true }; }
      if (seg[2] === 'apps' && method === 'POST') {
        const identifier = str(b, 'identifier')?.trim(); const name = str(b, 'name')?.trim();
        const kind = str(b, 'kind') === 'site' ? 'site' : 'app';
        if (!identifier || !name) throw new HttpError(400, 'Please fill in a name and where to find it.');
        if (s.apps.some((a) => a.kidId === k.id && a.kind === kind && a.identifier === identifier)) {
          throw new HttpError(409, `${name} is already on the list.`);
        }
        const platform = str(b, 'platform');
        const a: MApp = {
          id: newId(), kidId: k.id, kind, identifier, name,
          platform: platform === 'windows' || platform === 'android' ? platform : 'any',
          allowed: bool(b, 'allowed') ?? true, free: bool(b, 'free') ?? false, limitMinutes: num(b, 'limitMinutes') ?? null, usedMinutes: 0,
        };
        s.apps.push(a);
        return { app: a };
      }
      if (seg[2] === 'contacts' && method === 'POST') {
        const name = str(b, 'name')?.trim(); const phone = str(b, 'phone')?.trim();
        if (!name || !phone) throw new HttpError(400, 'Please fill in a name and a phone number.');
        const c: MContact = { id: newId(), kidId: k.id, name, phone, canCall: bool(b, 'canCall') ?? true, canText: bool(b, 'canText') ?? true };
        s.contacts.push(c);
        return { contact: c };
      }
    }
    if (seg[0] === 'apps' && seg[1]) {
      const a = s.apps.find((x) => x.id === seg[1]);
      if (!a) throw new HttpError(404, 'That app could not be found.');
      if (method === 'PATCH') { Object.assign(a, b, { id: a.id, kidId: a.kidId }); return { app: a }; }
      if (method === 'DELETE') { s.apps = s.apps.filter((x) => x !== a); return { ok: true }; }
    }
    if (seg[0] === 'contacts' && seg[1]) {
      const c = s.contacts.find((x) => x.id === seg[1]);
      if (!c) throw new HttpError(404, 'That contact could not be found.');
      if (method === 'PATCH') { Object.assign(c, b, { id: c.id, kidId: c.kidId }); return { contact: c }; }
      if (method === 'DELETE') { s.contacts = s.contacts.filter((x) => x !== c); return { ok: true }; }
    }

    if (key === 'GET /devices') return { devices: dashboard().devices };
    if (key === 'POST /devices/pairing-code') {
      kidOr404(str(b, 'kidId'));
      const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const code = Array.from({ length: 8 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
      return { code, expiresAt: new Date(Date.now() + 30 * 60000).toISOString() };
    }
    if (seg[0] === 'devices' && seg[1]) {
      const d = s.devices.find((x) => x.id === seg[1]);
      if (!d) throw new HttpError(404, 'That device could not be found.');
      if (method === 'PATCH') {
        const name = str(b, 'name'); const kidId = str(b, 'kidId');
        if (name !== undefined) { if (!name.trim()) throw new HttpError(400, 'Please give the device a name.'); d.name = name.trim(); }
        if (kidId) { const k = kidOr404(kidId); d.kidId = k.id; d.kidName = k.name; }
        return { device: d };
      }
      if (method === 'DELETE') { s.devices = s.devices.filter((x) => x !== d); return { ok: true }; }
    }

    if (key === 'GET /requests') {
      const all = [...s.requests].sort((a, c) => c.createdAt.localeCompare(a.createdAt));
      return { requests: query.get('status') === 'all' ? all : all.filter((r) => r.status === 'pending') };
    }
    if (seg[0] === 'requests' && seg[1] && seg[2] === 'decide' && method === 'POST') {
      const r = s.requests.find((x) => x.id === seg[1]);
      if (!r) throw new HttpError(404, 'That request could not be found.');
      if (r.status !== 'pending') throw new HttpError(409, 'That request was already answered.');
      const approve = bool(b, 'approve') ?? false;
      r.status = approve ? 'approved' : 'denied';
      r.decidedAt = new Date().toISOString();
      if (approve && r.kind === 'time') kidOr404(r.kidId).grants += r.minutes ?? 0;
      if (approve && r.kind !== 'time') {
        s.apps.push({
          id: newId(), kidId: r.kidId, kind: r.kind, platform: r.kind === 'site' ? 'any' : 'android',
          identifier: r.identifier ?? r.detail ?? 'unknown', name: r.detail ?? 'App', allowed: true, free: false, limitMinutes: null, usedMinutes: 0,
        });
      }
      return { ok: true };
    }
    if (key === 'GET /reports') return report(query.get('kidId') ?? '', query.get('days') === '30' ? 30 : 7);

    throw new HttpError(404, 'Not found.');
  }

  return async (input, init) => {
    await new Promise((r) => setTimeout(r, 120));
    const url = new URL(input, 'http://mock.local');
    let body: Body = {};
    if (typeof init?.body === 'string' && init.body) {
      try { body = JSON.parse(init.body) as Body; } catch { body = {}; }
    }
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    try {
      return json(200, route((init?.method ?? 'GET').toUpperCase(), url.pathname, url.searchParams, body));
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message, ...e.extra });
      throw e;
    }
  };
}
