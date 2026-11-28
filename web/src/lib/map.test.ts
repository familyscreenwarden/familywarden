import { describe, expect, it } from 'vitest';
import type { MapCheckIn } from '../api/types';
import { accuracyText, attributionHtml, batteryText, boundsOf, escapeHtml, openCheckIns, recentOk, tileRetryUrl, whenText, whereText } from './map';

const now = new Date('2026-11-28T18:00:00Z');
const last = { lat: 39.75, lng: -104.98, accuracy: 18, at: '2026-11-28T17:55:00Z', battery: 71, charging: false, place: null };
const checkin = (over: Partial<MapCheckIn>): MapCheckIn => ({ id: 'c', kidId: 'k', kind: 'ok', lat: null, lng: null, at: '2026-11-28T17:30:00Z', answer: null, answeredAt: null, ...over });

describe('map', () => {
  it('says where a kid is, or why there is nothing to show', () => {
    expect(whereText({ sharing: true, last: { ...last, place: { id: 'p', name: 'Home' } } })).toBe('At Home');
    expect(whereText({ sharing: true, last })).toBe('On the map');
    expect(whereText({ sharing: true, last: null })).toBe('No position yet');
    expect(whereText({ sharing: false, last: null })).toBe('Sharing is off');
    expect(whereText({ sharing: false, last })).toBe('On the map (sharing is off now)');
    expect(whenText({ last }, now)).toBe('5 minutes ago');
    expect(whenText({ last: null }, now)).toBe('');
  });

  it('rounds accuracy so it never looks more exact than it is', () => {
    expect(accuracyText(4)).toBe('within about 10 m');
    expect(accuracyText(18)).toBe('within about 20 m');
    expect(accuracyText(2400)).toBe('within about 2.4 km');
    expect(accuracyText(null)).toBe('accuracy unknown');
  });

  it('shows the battery when the phone told it', () => {
    expect(batteryText(71, false)).toBe('Battery 71%');
    expect(batteryText(12, true)).toBe('Battery 12%, charging');
    expect(batteryText(null, null)).toBe('');
  });

  it('finds the check-ins that still wait for a parent, and a recent "I am OK"', () => {
    const list = [checkin({ id: '1', kind: 'help' }), checkin({ id: '2', kind: 'pickup', answeredAt: '2026-11-28T17:40:00Z' }), checkin({ id: '3' })];
    expect(openCheckIns(list).map((c) => c.id)).toEqual(['1']);
    expect(recentOk(list, 'k', now)?.id).toBe('3');
    expect(recentOk(list, 'other', now)).toBeNull();
    expect(recentOk([checkin({ at: '2026-11-28T10:00:00Z' })], 'k', now)).toBeNull();
  });

  it('asks a failed tile again under a new address each time', () => {
    expect(tileRetryUrl('/api/map-tiles/12/853/1554.png', 1)).toBe('/api/map-tiles/12/853/1554.png?r=1');
    expect(tileRetryUrl('/api/map-tiles/12/853/1554.png?r=1', 2)).toBe('/api/map-tiles/12/853/1554.png?r=2');
  });

  it('works out the box that holds every kid', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([[39.75, -104.98], [39.73, -104.99], [39.74, -104.97]])).toEqual([[39.73, -104.99], [39.75, -104.97]]);
  });

  it('builds the credit line without letting markup through', () => {
    expect(attributionHtml('© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright'))
      .toBe('<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">© OpenStreetMap contributors</a>');
    expect(attributionHtml('<b>Maps</b>', 'javascript:alert(1)')).toBe('&#60;b&#62;Maps&#60;/b&#62;');
    expect(attributionHtml('', 'https://x.example')).toBe('');
    expect(escapeHtml('a"b')).toBe('a&#34;b');
  });
});
