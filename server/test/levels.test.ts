import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEVELS, ageOn, changesFrom, hasWord, levelForBirthday, levelOf, nextLevelDate, onList, siteBlocked, webRules } from '../src/levels';

test('sites mode: only the kid’s list', () => {
  const r = webRules('sites', ['social'], [], ['khanacademy.org']);
  assert.equal(siteBlocked('www.khanacademy.org', r, ['khanacademy.org']), false);
  assert.equal(siteBlocked('cdn.khanacademy.org', r, ['khanacademy.org']), false);
  assert.equal(siteBlocked('wikipedia.org', r, ['khanacademy.org']), true);
  assert.deepEqual(r.block, []);
});

test('filtered mode: blocked kinds and what a parent blocked, the kid’s list wins', () => {
  const allowed = ['roblox.com'];
  const r = webRules('filtered', ['social', 'games', 'adult'], ['example.net'], allowed);
  assert.equal(siteBlocked('m.tiktok.com', r, allowed), true);
  assert.equal(siteBlocked('example.net', r, allowed), true);
  assert.equal(siteBlocked('wikipedia.org', r, allowed), false);
  assert.equal(siteBlocked('roblox.com', r, allowed), false, 'on the list, so allowed although games are blocked');
  assert.ok(!r.block.includes('roblox.com'));
  assert.equal(siteBlocked('free-porn-tube.net', r, allowed), true, 'the adult words');
  assert.equal(siteBlocked('essex.ac.uk', r, allowed), false);
  assert.equal(siteBlocked('sextant.org', r, allowed), false);
});

test('open mode: only what a parent blocked', () => {
  const r = webRules('open', ['social'], ['tiktok.com'], []);
  assert.equal(siteBlocked('tiktok.com', r, []), true);
  assert.equal(siteBlocked('instagram.com', r, []), false);
  assert.deepEqual(r.words, []);
});

test('list and word matching', () => {
  assert.ok(onList('a.b.tiktok.com', ['tiktok.com']));
  assert.ok(!onList('nottiktok.com', ['tiktok.com']));
  assert.ok(hasWord('best-casino.io', ['casino']));
  assert.ok(!hasWord('casinoroyale-movie.com', ['casino']));
});

test('levels from a birthday', () => {
  assert.equal(ageOn('2016-03-14', '2026-03-13'), 9);
  assert.equal(ageOn('2016-03-14', '2026-03-14'), 10);
  assert.equal(levelForBirthday('2019-06-01', '2026-11-27').id, 'little');
  assert.equal(levelForBirthday('2016-03-14', '2026-11-27').id, 'big');
  assert.equal(levelForBirthday('2012-01-01', '2026-11-27').id, 'teen');
  assert.deepEqual(nextLevelDate('2016-03-14', 'big'), { level: levelOf('teen'), on: '2029-03-14' });
  assert.equal(nextLevelDate('2016-03-14', 'teen'), null);
});

test('changes from a level', () => {
  const big = levelOf('big')!.settings;
  assert.deepEqual(changesFrom(big, big), []);
  const c = changesFrom(big, { ...big, schoolMinutes: 150, categories: big.categories.filter((x) => x !== 'social') });
  assert.deepEqual(c.map((x) => x.key), ['schoolMinutes', 'categories']);
  assert.equal(c[0]?.now, '2 h 30 m');
  assert.match(c[1]?.now ?? '', /Social media/);
  assert.equal(LEVELS.length, 3);
});
