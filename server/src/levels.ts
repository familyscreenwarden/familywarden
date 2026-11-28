/**
 * Kids' levels (Little kid, Big kid, Teen) and safe browsing: the parts with no database, so they are tested on
 * their own (test/levels.test.ts).
 *
 * Safe browsing is one set of rules for every device a kid has (phones and PCs read the same `web` in their sync):
 *   - mode "sites":    only the websites on the kid's list ("Only allowed websites", the way it always worked)
 *   - mode "filtered": any website except blocked kinds of sites and sites a parent blocked
 *   - mode "open":     any website except sites a parent blocked
 * Websites on the kid's list are always allowed. SafeSearch and YouTube Restricted Mode apply in every mode.
 */

export type WebMode = 'sites' | 'filtered' | 'open';
export type TextingWho = 'family' | 'friends' | 'anyone';
export type LevelId = 'little' | 'big' | 'teen';

export interface WebCategory {
  id: string;
  name: string;
  hosts: string[];
  /** Words that mark a site as this kind when they're a whole part of its name ("porn" in porn-site.com). */
  words?: string[];
}

/**
 * Well-known sites of each kind. Not every site in the world: parents block more from "Blocked today" or by name,
 * and the adult-sites words catch most of the rest.
 */
export const WEB_CATEGORIES: WebCategory[] = [
  {
    id: 'adult',
    name: 'Adult sites',
    hosts: [
      'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'tube8.com', 'spankbang.com',
      'onlyfans.com', 'fansly.com', 'chaturbate.com', 'stripchat.com', 'bongacams.com', 'livejasmin.com', 'cam4.com',
      'myfreecams.com', 'brazzers.com', 'eporner.com', 'tnaflix.com', 'motherless.com', 'hentaihaven.xxx', 'nhentai.net',
      'rule34.xxx', 'e621.net', 'literotica.com', 'adultfriendfinder.com', 'fapello.com', 'thothub.to', 'erome.com',
      'porn.com', 'beeg.com', 'txxx.com', 'hqporner.com', 'manyvids.com', 'clips4sale.com',
    ],
    words: ['porn', 'porno', 'xxx', 'sex', 'nude', 'nudes', 'hentai', 'nsfw', 'camgirl', 'camgirls', 'escort', 'escorts', 'milf', 'fetish', 'erotic'],
  },
  {
    id: 'gambling',
    name: 'Gambling',
    hosts: [
      'draftkings.com', 'fanduel.com', 'betmgm.com', 'caesars.com', 'bet365.com', 'pokerstars.com', 'stake.com', 'stake.us',
      'chumbacasino.com', 'luckyland.com', 'pulsz.com', 'bovada.lv', 'betonline.ag', 'mybookie.ag', 'williamhill.com',
      'paddypower.com', 'betway.com', 'unibet.com', '888casino.com', 'roobet.com', 'rollbit.com', 'csgoroll.com',
      'gamdom.com', 'prizepicks.com', 'underdogfantasy.com', 'kalshi.com', 'polymarket.com', 'wowvegas.com',
    ],
    words: ['casino', 'casinos', 'betting', 'sportsbook', 'slots', 'poker'],
  },
  {
    id: 'violence',
    name: 'Violence and weapons',
    hosts: ['liveleak.com', 'bestgore.com', 'theync.com', 'kaotic.com', 'goregrish.com', 'crazyshit.com', 'documentingreality.com', 'watchpeopledie.tv', 'gunbroker.com', 'armslist.com'],
    words: ['gore'],
  },
  {
    id: 'proxies',
    name: 'Proxies and VPNs (ways around the filter)',
    hosts: [
      'proxysite.com', 'hide.me', 'hidester.com', 'croxyproxy.com', 'kproxy.com', 'proxyium.com', 'blockaway.net',
      'hidemyass.com', 'nordvpn.com', 'expressvpn.com', 'surfshark.com', 'protonvpn.com', 'windscribe.com', 'tunnelbear.com',
      'privateinternetaccess.com', 'cyberghostvpn.com', 'hotspotshield.com', 'psiphon.ca', 'torproject.org', 'ultrasurf.us',
      'warp.plus', 'vpnbook.com', 'zenmate.com', 'urban-vpn.com', 'browsec.com', 'proxfree.com', 'unblockit.download',
    ],
    words: ['proxy', 'proxies', 'unblock', 'unblocked', 'unblocker', 'vpn'],
  },
  {
    id: 'social',
    name: 'Social media',
    hosts: [
      'tiktok.com', 'tiktokv.com', 'instagram.com', 'facebook.com', 'fb.com', 'snapchat.com', 'x.com', 'twitter.com',
      'threads.net', 'reddit.com', 'tumblr.com', 'pinterest.com', 'bsky.app', 'mastodon.social', 'bereal.com', 'lemon8-app.com',
      'triller.co', 'likee.video', 'vk.com', 'truthsocial.com', 'gab.com', 'linkedin.com',
    ],
  },
  {
    id: 'chat',
    name: 'Chat and dating',
    hosts: [
      'discord.com', 'discord.gg', 'omegle.com', 'ome.tv', 'chatroulette.com', 'emeraldchat.com', 'monkey.app', 'yubo.live',
      'kik.com', 'telegram.org', 't.me', 'web.telegram.org', 'whatsapp.com', 'web.whatsapp.com', 'wink.app', 'hoop.photo',
      'tinder.com', 'bumble.com', 'hinge.co', 'grindr.com', 'match.com', 'okcupid.com', 'pof.com', 'chatib.us', 'chatiw.com',
      'tellonym.me', 'ngl.link', 'sendit.app', 'wizz.chat',
    ],
    words: ['dating'],
  },
  {
    id: 'games',
    name: 'Online games sites',
    hosts: [
      'poki.com', 'crazygames.com', 'coolmathgames.com', 'friv.com', 'miniclip.com', 'y8.com', 'kizi.com', 'agame.com',
      'armorgames.com', 'kongregate.com', 'newgrounds.com', 'itch.io', 'roblox.com', 'krunker.io', 'slither.io', 'agar.io',
      'shellshock.io', 'now.gg', 'gameflare.com', 'unblocked-games.com', 'classroom6x.com',
    ],
  },
  {
    id: 'shopping',
    name: 'Shopping',
    hosts: ['amazon.com', 'ebay.com', 'walmart.com', 'target.com', 'temu.com', 'shein.com', 'aliexpress.com', 'etsy.com', 'wish.com', 'bestbuy.com', 'costco.com', 'wayfair.com', 'shopify.com'],
  },
];

export const CATEGORY_IDS = WEB_CATEGORIES.map((c) => c.id);

export interface LevelSettings {
  schoolMinutes: number;
  offMinutes: number;
  schoolBedtime: string;
  otherBedtime: string;
  webMode: WebMode;
  categories: string[];
  safeSearch: boolean;
  youTube: boolean;
  texting: TextingWho;
}

export interface Level {
  id: LevelId;
  name: string;
  ages: string;
  fromAge: number;
  settings: LevelSettings;
}

const LITTLE: Level = {
  id: 'little',
  name: 'Little kid',
  ages: 'Ages 5–8',
  fromAge: 0,
  settings: { schoolMinutes: 60, offMinutes: 90, schoolBedtime: '19:30', otherBedtime: '20:00', webMode: 'sites', categories: [...CATEGORY_IDS], safeSearch: true, youTube: true, texting: 'family' },
};

export const LEVELS: Level[] = [
  LITTLE,
  {
    id: 'big',
    name: 'Big kid',
    ages: 'Ages 9–12',
    fromAge: 9,
    settings: { schoolMinutes: 120, offMinutes: 180, schoolBedtime: '20:30', otherBedtime: '21:00', webMode: 'filtered', categories: ['adult', 'gambling', 'violence', 'proxies', 'social', 'chat'], safeSearch: true, youTube: true, texting: 'friends' },
  },
  {
    id: 'teen',
    name: 'Teen',
    ages: 'Ages 13–17',
    fromAge: 13,
    settings: { schoolMinutes: 240, offMinutes: 300, schoolBedtime: '22:30', otherBedtime: '23:00', webMode: 'filtered', categories: ['adult', 'gambling', 'proxies'], safeSearch: true, youTube: true, texting: 'anyone' },
  },
];

export function levelOf(id: string | null | undefined): Level | null {
  return LEVELS.find((l) => l.id === id) ?? null;
}

/** The level for a kid's age on this day (from their birthday, "YYYY-MM-DD"). */
export function levelForBirthday(birthday: string, today: string): Level {
  const age = ageOn(birthday, today);
  return [...LEVELS].reverse().find((l) => age >= l.fromAge) ?? LITTLE;
}

function ymd(date: string): [number, number, number] {
  const p = date.split('-').map(Number);
  return [p[0] ?? 0, p[1] ?? 1, p[2] ?? 1];
}

export function ageOn(birthday: string, today: string): number {
  const [by, bm, bd] = ymd(birthday);
  const [ty, tm, td] = ymd(today);
  let a = ty - by;
  if (tm < bm || (tm === bm && td < bd)) a--;
  return a;
}

/** When a kid reaches the next level ("YYYY-MM-DD"), or null at the last one. */
export function nextLevelDate(birthday: string, current: LevelId): { level: Level; on: string } | null {
  const i = LEVELS.findIndex((l) => l.id === current);
  const next = LEVELS[i + 1];
  if (!next) return null;
  const [y, m, d] = ymd(birthday);
  return { level: next, on: `${String(y + next.fromAge).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

export interface SettingChange {
  key: keyof LevelSettings;
  label: string;
  level: string;
  now: string;
}

const hm = (m: number) => (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m / 60} h`).replace(/^0 h /, '');
const clock = (t: string) => {
  const p = t.split(':').map(Number);
  const h = p[0] ?? 0;
  const m = p[1] ?? 0;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
const MODE_NAMES: Record<WebMode, string> = { sites: 'Only sites you pick', filtered: 'Filtered web', open: 'Open web' };
const WHO_NAMES: Record<TextingWho, string> = { family: 'Family only', friends: 'Family and friends you approve', anyone: 'Anyone (nothing is held back)' };

/** How a kid's settings differ from their level's, for "Changed from Big kid". */
export function changesFrom(level: LevelSettings, now: LevelSettings): SettingChange[] {
  const out: SettingChange[] = [];
  const add = (key: keyof LevelSettings, label: string, a: string, b: string) => {
    if (a !== b) out.push({ key, label, level: a, now: b });
  };
  add('schoolMinutes', 'Time on school days', hm(level.schoolMinutes), hm(now.schoolMinutes));
  add('offMinutes', 'Time on weekends', hm(level.offMinutes), hm(now.offMinutes));
  add('schoolBedtime', 'Bedtime on school nights', clock(level.schoolBedtime), now.schoolBedtime ? clock(now.schoolBedtime) : 'Off');
  add('otherBedtime', 'Bedtime on Friday and Saturday', clock(level.otherBedtime), now.otherBedtime ? clock(now.otherBedtime) : 'Off');
  add('webMode', 'Websites', MODE_NAMES[level.webMode], MODE_NAMES[now.webMode]);
  if (now.webMode === 'filtered' || level.webMode === 'filtered') {
    const a = [...level.categories].sort().join(',');
    const b = [...now.categories].sort().join(',');
    if (a !== b) {
      const name = (ids: string[]) => ids.map((id) => WEB_CATEGORIES.find((c) => c.id === id)?.name ?? id);
      const more = now.categories.filter((c) => !level.categories.includes(c));
      const less = level.categories.filter((c) => !now.categories.includes(c));
      out.push({ key: 'categories', label: 'Blocked kinds of sites', level: `${level.categories.length} kinds`, now: [...name(more).map((n) => `+ ${n}`), ...name(less).map((n) => `− ${n}`)].join(', ') });
    }
  }
  add('safeSearch', 'SafeSearch', level.safeSearch ? 'On' : 'Off', now.safeSearch ? 'On' : 'Off');
  add('youTube', 'YouTube Restricted Mode', level.youTube ? 'On' : 'Off', now.youTube ? 'On' : 'Off');
  add('texting', 'Who they can text', WHO_NAMES[level.texting], WHO_NAMES[now.texting]);
  return out;
}

export function normalizeHost(h: string): string {
  let x = h.trim().toLowerCase().replace(/\.$/, '');
  if (x.startsWith('www.')) x = x.slice(4);
  return x;
}

/** "m.tiktok.com" is on a list that has "tiktok.com". */
export function onList(host: string, list: Iterable<string>): boolean {
  const h = normalizeHost(host);
  for (const raw of list) {
    const l = normalizeHost(raw);
    if (l && (h === l || h.endsWith('.' + l))) return true;
  }
  return false;
}

/** A word list match: a whole part of the name ("free-porn-site.net", "porn.example"), not "sextant.org" or "essex.ac.uk". */
export function hasWord(host: string, words: Iterable<string>): boolean {
  const parts = normalizeHost(host).split(/[.-]/);
  const set = new Set(words);
  return parts.some((p) => set.has(p));
}

export interface WebRules {
  mode: WebMode;
  /** Hosts blocked (subdomains too): the blocked kinds' sites plus ones a parent blocked. */
  block: string[];
  /** Words that block a site when they're a whole part of its name. */
  words: string[];
}

/** What the devices get in their snapshot. */
export function webRules(mode: WebMode, categories: string[], blocked: string[], allowed: string[]): WebRules {
  const cats = mode === 'filtered' ? WEB_CATEGORIES.filter((c) => categories.includes(c.id)) : [];
  const allowedSet = allowed.map(normalizeHost);
  const block = new Set<string>();
  for (const c of cats) for (const h of c.hosts) block.add(normalizeHost(h));
  for (const h of blocked) block.add(normalizeHost(h));
  // A site on the kid's list wins over a blocked kind (khanacademy.org stays even if "Online games" is blocked).
  for (const a of allowedSet) block.delete(a);
  const words = [...new Set(cats.flatMap((c) => c.words ?? []))];
  return { mode, block: [...block].sort(), words };
}

/** The same check the kids' app makes (kept here for the tests). */
export function siteBlocked(host: string, r: WebRules, allowed: string[]): boolean {
  if (onList(host, allowed)) return false;
  if (r.mode === 'sites') return true;
  if (onList(host, r.block)) return true;
  return r.words.length > 0 && hasWord(host, r.words);
}

export function categoryOf(host: string): WebCategory | null {
  return WEB_CATEGORIES.find((c) => onList(host, c.hosts) || (c.words && hasWord(host, c.words))) ?? null;
}
