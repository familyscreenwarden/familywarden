import { describe, expect, it } from 'vitest';
import type { KidMediaItem } from '../api/types';
import { clipLength, fileSize, filterMedia, linkEnds, mediaName } from './media';
import { requestCopy } from './requests';

const item = (kind: KidMediaItem['kind'], title = ''): KidMediaItem => ({
  id: kind + title, kind, title, at: '2026-03-11T21:00:00Z', durationSec: 0, size: 1, type: 'image/jpeg', url: '/x',
  deviceName: null, deletedOnPhone: false, linkShared: false, linkExpiresAt: null,
});

describe('photos and videos', () => {
  it('shows how long a clip is', () => {
    expect(clipLength(0)).toBe('0:00');
    expect(clipLength(42)).toBe('0:42');
    expect(clipLength(725)).toBe('12:05');
    expect(clipLength(3723)).toBe('1:02:03');
    expect(clipLength(-5)).toBe('0:00');
  });

  it('shows file sizes in words a parent knows', () => {
    expect(fileSize(300)).toBe('1 KB');
    expect(fileSize(640 * 1024)).toBe('640 KB');
    expect(fileSize(4.2 * 1024 * 1024)).toBe('4.2 MB');
    expect(fileSize(5 * 1024 ** 3)).toBe('5 GB');
  });

  it('filters by kind', () => {
    const all = [item('photo'), item('video'), item('movie'), item('photo', 'b')];
    expect(filterMedia(all, 'all')).toHaveLength(4);
    expect(filterMedia(all, 'photo')).toHaveLength(2);
    expect(filterMedia(all, 'movie').map((m) => m.kind)).toEqual(['movie']);
  });

  it('names an item by its title, or by whose it is', () => {
    expect(mediaName(item('movie', 'Lego heist'), 'Ava')).toBe('Lego heist');
    expect(mediaName(item('photo'), 'Ava')).toBe("Ava's photo");
    expect(mediaName(item('video'), 'Max')).toBe("Max's video");
    expect(mediaName(item('video'), 'Jess')).toBe("Jess' video");
  });

  it('says when a link ends', () => {
    const now = new Date('2026-03-11T12:00:00Z');
    expect(linkEnds('2026-04-10T12:00:00Z', now)).toBe('ends in 30 days');
    expect(linkEnds('2026-03-12T10:00:00Z', now)).toBe('ends tomorrow');
    expect(linkEnds('2026-03-11T11:00:00Z', now)).toBe('ends today');
    expect(linkEnds(null, now)).toBe('');
  });
});

describe('a friend request', () => {
  it('shows the number and what the kid wrote', () => {
    const copy = requestCopy({ kind: 'contact', kidName: 'Ava', minutes: null, detail: 'Lily', phone: '555-014-2290', note: 'She is in my class' });
    expect(copy.text).toBe('Ava wants to text a friend: Lily (555-014-2290)');
    expect(copy.note).toBe('Ava says: "She is in my class"');
    expect(requestCopy({ kind: 'contact', kidName: 'Ava', minutes: null, detail: 'Lily', note: null }).note).toBeUndefined();
  });
});
