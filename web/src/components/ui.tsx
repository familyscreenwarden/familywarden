import { useEffect, useId, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { safeColor, textOn } from '../lib/color';
import { percent } from '../lib/format';

export function Logo({ width = 34, height = 40 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 120 140" aria-hidden="true">
      <path d="M60 8 L112 26 V68 C112 100 90 122 60 132 C30 122 8 100 8 68 V26 Z" fill="none" stroke="#34d399" strokeWidth="9" strokeLinejoin="round" />
      <path d="M82 46 H46 V68 H74 V92 H38" fill="none" stroke="#34d399" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="82" cy="46" r="6" fill="#04060f" stroke="#34d399" strokeWidth="4" />
      <circle cx="38" cy="92" r="6" fill="#04060f" stroke="#34d399" strokeWidth="4" />
    </svg>
  );
}

export function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export const ICON = {
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v5 M14 11v5',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4',
  close: 'M6 6l12 12 M18 6L6 18',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
} as const;

export function Card({ title, action, children, className = '', style }: {
  title?: string; action?: ReactNode; children: ReactNode; className?: string; style?: CSSProperties;
}) {
  const id = useId();
  return (
    <section className={`card ${className}`} style={style} aria-labelledby={title ? id : undefined}>
      {title && (
        <div className="card-head">
          <h2 className="card-title" id={id}>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {children && <div className="head-actions">{children}</div>}
    </div>
  );
}

export function KidPill({ color, children }: { color: string; children: ReactNode }) {
  const bg = safeColor(color);
  return <span className="pill" style={{ background: bg, color: textOn(bg) }}>{children}</span>;
}

export function Avatar({ name, color }: { name: string; color: string }) {
  const bg = safeColor(color);
  return (
    <span className="avatar" style={{ background: bg, color: textOn(bg) }} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean;
}) {
  return (
    <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label}
      disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-track" aria-hidden="true" />
      <span className="switch-text" aria-hidden="true">{checked ? 'On' : 'Off'}</span>
    </button>
  );
}

export function Progress({ used, limit, label, thin, plain }: {
  used: number; limit: number; label: string; thin?: boolean;
  /** A plain comparison bar: no "used up" colour at 100%. */
  plain?: boolean;
}) {
  const p = percent(used, limit);
  return (
    <div className={`bar${thin ? ' thin' : ''}${p >= 100 && !plain ? ' full' : ''}`} role="img" aria-label={label}>
      <div style={{ width: `${p}%` }} />
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state" role="status">
      <div className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <span className="grow">{message}</span>
      {onRetry && <button type="button" className="btn btn-ghost" onClick={onRetry}>Try again</button>}
    </div>
  );
}

/** A quiet note shown when a background refresh failed but older data is still on screen. */
export function StaleNote({ message }: { message: string }) {
  return <div className="banner banner-warn small" role="status">Could not refresh just now. {message}</div>;
}

export function Confirm({ open, title, body, confirmLabel, danger, busy, onConfirm, onCancel }: {
  open: boolean; title: string; body: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <h2 id={titleId}>{title}</h2>
      <div className="muted">{body}</div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
