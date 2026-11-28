import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distanceM, fixTime, isTileTemplate, placeChanges, tileType, tileUrl, validTile } from '../src/location';

const school = { id: 's', name: 'School', lat: 39.7392, lng: -104.9903, radius: 150 };
const home = { id: 'h', name: 'Home', lat: 39.75, lng: -104.98, radius: 100 };
const at = new Date();
// About 111 m per 0.001° of latitude.
const north = (p: { lat: number; lng: number }, m: number): { lat: number; lng: number } => ({ lat: p.lat + m / 111_195, lng: p.lng });

test('distance', () => {
  assert.ok(Math.abs(distanceM(school.lat, school.lng, north(school, 500).lat, school.lng) - 500) < 1);
});

test('arrive inside the circle, not with a poor fix', () => {
  assert.deepEqual(placeChanges({ ...north(school, 100), accuracy: 20, at }, [school, home], new Set()).events.map((e) => e.kind + e.place.id), ['arrives']);
  assert.deepEqual(placeChanges({ ...north(school, 100), accuracy: 900, at }, [school], new Set()).events, []);
  assert.deepEqual(placeChanges({ ...north(school, 400), accuracy: 20, at }, [school], new Set()).events, []);
});

test('leaving needs to be clearly outside', () => {
  const inside = new Set(['s']);
  // 30 m past the edge with a 20 m fix: still there (no flapping).
  const edge = placeChanges({ ...north(school, 180), accuracy: 20, at }, [school], inside);
  assert.deepEqual(edge.events, []);
  assert.deepEqual(edge.inside, ['s']);
  const gone = placeChanges({ ...north(school, 400), accuracy: 20, at }, [school], inside);
  assert.deepEqual(gone.events.map((e) => e.kind), ['leave']);
  assert.deepEqual(gone.inside, []);
  // A wobbly 300 m fix 100 m past the edge is not enough to say they left.
  assert.deepEqual(placeChanges({ ...north(school, 250), accuracy: 300, at }, [school], inside).events, []);
});

test('tiles: which exist, and their address from the template', () => {
  assert.ok(validTile(0, 0, 0));
  assert.ok(validTile(2, 3, 3));
  assert.ok(!validTile(2, 9, 1));
  assert.ok(!validTile(20, 0, 0));
  assert.ok(!validTile(3, -1, 0));
  assert.ok(!validTile(3.5, 1, 1));
  assert.ok(!validTile(Number.NaN, 0, 0));
  assert.equal(tileUrl('https://tiles.example/{z}/{x}/{y}.png?key=abc', 12, 853, 1554), 'https://tiles.example/12/853/1554.png?key=abc');
  assert.equal(tileUrl('https://{s}.tiles.example/{z}/{x}/{y}.png', 3, 1, 1), 'https://c.tiles.example/3/1/1.png');
  assert.ok(isTileTemplate('https://tile.example/{z}/{x}/{y}.png'));
  assert.ok(!isTileTemplate('https://tile.example/{z}/{x}.png'));
  assert.ok(!isTileTemplate('file:///etc/{z}/{x}/{y}'));
  assert.ok(!isTileTemplate('not an address {z}{x}{y}'));
});

test('tiles: only pictures are passed on', () => {
  assert.equal(tileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  assert.equal(tileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(tileType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(tileType(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(tileType(Buffer.alloc(0)), null);
});

test('a fix keeps the phone\'s time only when it is within an hour of now', () => {
  const now = new Date('2026-03-11T21:00:00Z');
  assert.equal(fixTime('2026-03-11T20:30:00Z', now).toISOString(), '2026-03-11T20:30:00.000Z');
  assert.equal(fixTime('2020-01-01T00:00:00Z', now).toISOString(), now.toISOString());
  assert.equal(fixTime('2026-03-12T21:00:00Z', now).toISOString(), now.toISOString());
  assert.equal(fixTime('yesterday', now).toISOString(), now.toISOString());
  assert.equal(fixTime(undefined, now).toISOString(), now.toISOString());
});
