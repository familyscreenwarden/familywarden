import { useState } from 'react';
import { useApp } from '../app';
import type { Kid, KidPatch } from '../api/types';
import { Switch } from './ui';

type SafeKey = 'onlyAllowedSites' | 'safeSearch' | 'youtubeRestricted' | 'blockPrivate';

export const SAFE_ROWS: { key: SafeKey; label: string; help: string }[] = [
  { key: 'onlyAllowedSites', label: 'Only allowed websites', help: 'The browser opens only the websites you have allowed.' },
  { key: 'safeSearch', label: 'SafeSearch on Google and Bing', help: 'Search results are filtered.' },
  { key: 'youtubeRestricted', label: 'YouTube Restricted Mode', help: 'YouTube hides videos marked as mature.' },
  { key: 'blockPrivate', label: 'Block private browsing', help: 'Private or incognito windows cannot be opened.' },
];

/** The four safe-browsing switches for one kid. Each change is saved at once. */
export function SafeSwitches({ kid, onSaved, showHelp }: { kid: Kid; onSaved: () => void | Promise<void>; showHelp?: boolean }) {
  const { api, run } = useApp();
  const [busy, setBusy] = useState<SafeKey | null>(null);

  async function set(key: SafeKey, label: string, value: boolean) {
    setBusy(key);
    const patch: KidPatch = { [key]: value };
    await run(() => api.updateKid(kid.id, patch), `${label} is ${value ? 'on' : 'off'} for ${kid.name}.`);
    await onSaved();
    setBusy(null);
  }

  return (
    <>
      {SAFE_ROWS.map((r) => (
        <div key={r.key} className="setting-row">
          <div>
            <div>{r.label}</div>
            {showHelp && <div className="tiny muted">{r.help}</div>}
          </div>
          <Switch checked={kid[r.key]} disabled={busy === r.key} label={`${r.label} for ${kid.name}`}
            onChange={(v) => void set(r.key, r.label, v)} />
        </div>
      ))}
    </>
  );
}
