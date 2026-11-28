// Words for the "Levels and web" page. Pure functions, tested in levels.test.ts.
import type { LevelSettings, TextingWho, WebCategory, WebMode } from '../api/types';
import { formatClock, formatMinutes, plural } from './format';

export const MODE_NAME: Record<WebMode, string> = {
  sites: 'Only websites I pick',
  filtered: 'Filtered web',
  open: 'Open web',
};

export const WHO_NAME: Record<TextingWho, string> = {
  family: 'Family only',
  friends: 'Family and friends you approve',
  anyone: 'Anyone',
};

/** What a website rule means for this kid, in one sentence. */
export function modeHelp(mode: WebMode, name: string): string {
  if (mode === 'sites') return `${name} can only open the websites on their list.`;
  if (mode === 'filtered') return `${name} can open any website except the kinds you block below and websites you block by name. Websites on their list always work.`;
  return `${name} can open any website except the ones you block by name.`;
}

/** 'HH:MM' as "8:30 pm", or "off" when there is no bedtime. */
export function bedtimeText(hhmm: string): string {
  return hhmm ? formatClock(hhmm) : 'off';
}

/** The lines of a level's card: time, bedtime, websites, texting. */
export function levelLines(s: LevelSettings, categories: WebCategory[]): string[] {
  const kinds = s.categories.filter((c) => categories.some((x) => x.id === c)).length;
  return [
    `${formatMinutes(s.schoolMinutes)} on school days, ${formatMinutes(s.offMinutes)} on weekends`,
    `Bedtime ${bedtimeText(s.schoolBedtime)} on school nights, ${bedtimeText(s.otherBedtime)} on Friday and Saturday`,
    s.webMode === 'sites'
      ? 'Only the websites you pick'
      : s.webMode === 'filtered'
        ? `Filtered web: ${plural(kinds, 'kind', 'kinds')} of sites blocked`
        : 'Open web: only websites you block',
    s.texting === 'family' ? 'Texts with family only' : s.texting === 'friends' ? 'Texts with family and friends you approve' : 'Texts with anyone (you can still read them)',
  ];
}

/** One line for the overview: "Filtered web, SafeSearch on, YouTube Restricted Mode on". */
export function webSummary(mode: WebMode, safeSearch: boolean, youTube: boolean): string {
  return `${MODE_NAME[mode]}. SafeSearch ${safeSearch ? 'on' : 'off'}, YouTube Restricted Mode ${youTube ? 'on' : 'off'}.`;
}

/** A website as a parent typed it ("https://www.Roblox.com/games") as a bare host, or '' when it is none. */
export function cleanSite(raw: string): string {
  let v = raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = (v.split(/[/?#]/)[0] ?? '').replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : '';
}

/** The kinds of sites after one is switched on or off. */
export function toggleCategory(current: string[], id: string): string[] {
  return current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
}
