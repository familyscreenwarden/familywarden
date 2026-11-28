import { Link } from 'react-router-dom';
import type { Kid } from '../api/types';
import { safeColor, textOn } from '../lib/color';

export type KidSection = 'rules' | 'phone' | 'texts' | 'photos';

const SECTIONS: { key: KidSection; label: string; path: string }[] = [
  { key: 'rules', label: 'Time, apps and websites', path: '' },
  { key: 'phone', label: 'Phone and chores', path: '/phone' },
  { key: 'texts', label: 'Texts', path: '/texts' },
  { key: 'photos', label: 'Photos and videos', path: '/photos' },
];

/** The pages of one kid: the rules, the phone and chores, the texts, the photos and videos. */
export function KidSections({ kidId, current }: { kidId: string; current: KidSection }) {
  return (
    <nav className="subtabs" aria-label="Sections">
      {SECTIONS.map((s) => (
        <Link key={s.key} to={`/kids/${kidId}${s.path}`} className={`subtab${current === s.key ? ' on' : ''}`} aria-current={current === s.key ? 'page' : undefined}>{s.label}</Link>
      ))}
    </nav>
  );
}

/** One tab per kid, leading to the same section of that kid. */
export function KidTabs({ kids, currentId, section }: { kids: Kid[]; currentId: string; section: KidSection }) {
  const path = SECTIONS.find((s) => s.key === section)?.path ?? '';
  return (
    <nav className="tabs" aria-label="Kid">
      {kids.map((k) => {
        const on = k.id === currentId;
        const bg = safeColor(k.color);
        return (
          <Link key={k.id} to={`/kids/${k.id}${path}`} className={`tab${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}
            style={on ? { background: bg, color: textOn(bg) } : undefined}>{k.name}</Link>
        );
      })}
    </nav>
  );
}
