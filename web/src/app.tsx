import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DependencyList, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, createApi, errorMessage } from './api/client';
import type { Api, FetchLike } from './api/client';

interface Toast { id: number; kind: 'ok' | 'error'; text: string }

interface AppCtx {
  api: Api;
  /** True once the server has said the account is locked (trial over, no plan). */
  locked: boolean;
  setLocked: (v: boolean) => void;
  toast: (kind: 'ok' | 'error', text: string) => void;
  /** Runs a change, shows the success or the error message, and reports whether it worked. */
  run: (action: () => Promise<unknown>, okText?: string) => Promise<boolean>;
  /** Bumped whenever something that the sidebar badge depends on has changed. */
  badgeTick: number;
  bumpBadge: () => void;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside AppProvider');
  return v;
}

export function AppProvider({ fetchFn, children }: { fetchFn: FetchLike; children: ReactNode }) {
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const [locked, setLocked] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [badgeTick, setBadgeTick] = useState(0);
  const nextId = useRef(1);

  const api = useMemo(
    () => createApi(fetchFn, {
      onUnauthorized: () => {
        if (window.location.pathname !== '/signin') navRef.current('/signin', { replace: true });
      },
      onLocked: () => setLocked(true),
    }),
    [fetchFn],
  );

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback((kind: 'ok' | 'error', text: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    window.setTimeout(() => dismiss(id), kind === 'ok' ? 4000 : 9000);
  }, [dismiss]);

  const run = useCallback(async (action: () => Promise<unknown>, okText?: string) => {
    try {
      await action();
      if (okText) toast('ok', okText);
      return true;
    } catch (e) {
      // A 401 already sends the parent to sign in; everything else is shown.
      if (!(e instanceof ApiError && e.status === 401)) toast('error', errorMessage(e));
      return false;
    }
  }, [toast]);

  const bumpBadge = useCallback(() => setBadgeTick((n) => n + 1), []);

  const value = useMemo<AppCtx>(
    () => ({ api, locked, setLocked, toast, run, badgeTick, bumpBadge }),
    [api, locked, toast, run, badgeTick, bumpBadge],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span>{t.text}</span>
            <button type="button" aria-label="Dismiss message" onClick={() => dismiss(t.id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Loads data when the deps change and, optionally, again every intervalMs.
 * A failed background refresh keeps the last good data and sets `error`.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList, intervalMs?: number): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await fnRef.current();
      if (mine !== seq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(true);
    void load();
    if (!intervalMs) return () => { seq.current++; };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, intervalMs);
    return () => { window.clearInterval(timer); seq.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, load]);

  return { data, error, loading, reload: load };
}

/** True while the media query matches (used to draw charts for narrow screens). */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return on;
}
