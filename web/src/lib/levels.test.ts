import { describe, expect, it } from 'vitest';
import type { LevelSettings, WebCategory } from '../api/types';
import { bedtimeText, cleanSite, levelLines, modeHelp, toggleCategory, webSummary } from './levels';

const cats: WebCategory[] = [{ id: 'adult', name: 'Adult sites', sites: 35 }, { id: 'social', name: 'Social media', sites: 22 }];
const big: LevelSettings = {
  schoolMinutes: 120, offMinutes: 180, schoolBedtime: '20:30', otherBedtime: '21:00', webMode: 'filtered',
  categories: ['adult', 'social'], safeSearch: true, youTube: true, texting: 'friends',
};

describe('levels', () => {
  it('describes a level in four lines', () => {
    expect(levelLines(big, cats)).toEqual([
      '2 h on school days, 3 h on weekends',
      'Bedtime 8:30 pm on school nights, 9:00 pm on Friday and Saturday',
      'Filtered web: 2 kinds of sites blocked',
      'Texts with family and friends you approve',
    ]);
    expect(levelLines({ ...big, webMode: 'sites', texting: 'family' }, cats)[2]).toBe('Only the websites you pick');
    expect(levelLines({ ...big, webMode: 'open', texting: 'anyone' }, cats).slice(2)).toEqual(['Open web: only websites you block', 'Texts with anyone (you can still read them)']);
    expect(levelLines({ ...big, categories: ['adult'] }, cats)[2]).toBe('Filtered web: 1 kind of sites blocked');
  });

  it('says "off" for a bedtime that is switched off', () => {
    expect(bedtimeText('')).toBe('off');
    expect(bedtimeText('19:30')).toBe('7:30 pm');
  });

  it('explains each website rule with the kid\'s name', () => {
    expect(modeHelp('sites', 'Ava')).toBe('Ava can only open the websites on their list.');
    expect(modeHelp('filtered', 'Ava')).toContain('except the kinds you block');
    expect(modeHelp('open', 'Ava')).toBe('Ava can open any website except the ones you block by name.');
  });

  it('sums up the web rules in one line', () => {
    expect(webSummary('filtered', true, false)).toBe('Filtered web. SafeSearch on, YouTube Restricted Mode off.');
  });

  it('cleans a typed website and refuses what is none', () => {
    expect(cleanSite(' https://www.Roblox.com/games?x=1 ')).toBe('roblox.com');
    expect(cleanSite('khanacademy.org.')).toBe('khanacademy.org');
    expect(cleanSite('not a site')).toBe('');
    expect(cleanSite('localhost')).toBe('');
  });

  it('switches a kind of site on and off', () => {
    expect(toggleCategory(['adult'], 'social')).toEqual(['adult', 'social']);
    expect(toggleCategory(['adult', 'social'], 'adult')).toEqual(['social']);
  });
});
