import type { KidMediaItem, MediaKind } from '../api/types';

/** "0:42", "12:05", "1:02:03". */
export function clipLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** "640 KB", "4.2 MB", "1.5 GB". */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1).replace(/\.0$/, '')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const KIND_WORD: Record<MediaKind, string> = { photo: 'photo', video: 'video', movie: 'movie' };

export type MediaFilter = 'all' | MediaKind;
export const MEDIA_FILTERS: { value: MediaFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'photo', label: 'Photos' },
  { value: 'video', label: 'Videos' },
  { value: 'movie', label: 'Movies' },
];

export function filterMedia(items: KidMediaItem[], filter: MediaFilter): KidMediaItem[] {
  return filter === 'all' ? items : items.filter((m) => m.kind === filter);
}

/** What a tile or the viewer is called when the kid gave no title. */
export function mediaName(item: Pick<KidMediaItem, 'kind' | 'title'>, kidName: string): string {
  const owner = /s$/i.test(kidName) ? `${kidName}'` : `${kidName}'s`;
  return item.title || `${owner} ${KIND_WORD[item.kind]}`;
}

/** The day and time a photo was taken, in the parent's own time zone. */
export function takenAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** How many days a link still works, as words. */
export function linkEnds(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const days = Math.ceil((new Date(iso).getTime() - now.getTime()) / 86400000);
  if (!Number.isFinite(days) || days <= 0) return 'ends today';
  return days === 1 ? 'ends tomorrow' : `ends in ${days} days`;
}
