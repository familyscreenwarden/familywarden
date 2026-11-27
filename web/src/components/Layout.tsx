import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import type { Account } from '../api/types';
import { ErrorBox, ICON, Icon, Loading, Logo, PageHead, Card } from './ui';

const NAV_MAIN = [
  { to: '/', label: 'Dashboard', d: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z' },
  { to: '/kids', label: 'Kids and rules', d: 'M8 11a3 3 0 100-6 3 3 0 000 6z M2 20c0-3 3-5 6-5s6 2 6 5 M17 11a3 3 0 100-6 M22 20c0-3-2-4.5-4-5' },
  { to: '/devices', label: 'Devices', d: 'M3 5h18v11H3z M8 20h8 M12 16v4' },
  { to: '/requests', label: 'Requests', d: 'M6 16V11a6 6 0 0112 0v5l2 2H4z M10 21h4' },
  { to: '/reports', label: 'Reports', d: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2' },
  { to: '/safe-browsing', label: 'Safe browsing', d: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
] as const;
const NAV_MORE = [
  { to: '/billing', label: 'Billing', d: 'M3 6h18v12H3z M3 10h18' },
  { to: '/settings', label: 'Settings', d: 'M12 9a3 3 0 100 6 3 3 0 000-6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2' },
  { to: '/help', label: 'Help', d: 'M12 21a9 9 0 100-18 9 9 0 000 18z M9.5 9a2.5 2.5 0 115 0c0 2-2.5 2-2.5 4 M12 17v.5' },
] as const;

/** Pages a locked account may still open. */
const OPEN_WHEN_LOCKED = ['/billing', '/settings', '/help'];

export interface ShellContext { account: Account; reloadAccount: () => Promise<void> }
export function useShell(): ShellContext { return useOutletContext<ShellContext>(); }

export function Layout() {
  const { api, locked, setLocked, badgeTick } = useApp();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const me = useLoad(() => api.me(), []);
  const account = me.data?.account ?? null;
  const isLocked = locked || account?.plan === 'locked';

  useEffect(() => { setOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (account) setLocked(account.plan === 'locked');
  }, [account, setLocked]);

  const pending = useLoad(
    async () => (account && !isLocked ? (await api.requests('pending')).requests.length : 0),
    [account?.id, isLocked, badgeTick],
    30000,
  );
  const count = pending.data ?? 0;

  const link = (item: { to: string; label: string; d: string }) => (
    <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
      <Icon d={item.d} />
      <span>{item.label}</span>
      {item.to === '/requests' && count > 0 && (
        <span className="nav-badge"><span aria-hidden="true">{count}</span><span className="sr-only">{count} waiting</span></span>
      )}
    </NavLink>
  );

  const showLockScreen = isLocked && !OPEN_WHEN_LOCKED.some((p) => location.pathname.startsWith(p));

  return (
    <div className="backdrop">
      <div className="window">
        <nav className="nav" aria-label="Main">
          <div className="nav-top">
            <Link to="/" className="brand" aria-label="Family Screen Warden, dashboard">
              <Logo />
              <div className="brand-name">Family<br />Screen Warden</div>
            </Link>
            <button type="button" className="btn btn-ghost menu-btn" aria-expanded={open} aria-controls="nav-links" onClick={() => setOpen((o) => !o)}>
              <Icon d={open ? ICON.close : ICON.menu} />
              <span>Menu</span>
              {count > 0 && !open && <span className="nav-badge"><span aria-hidden="true">{count}</span><span className="sr-only">{count} requests waiting</span></span>}
            </button>
          </div>
          <div id="nav-links" className={`nav-links${open ? ' open' : ''}`}>
            {NAV_MAIN.map(link)}
            <div className="nav-sep" />
            {NAV_MORE.map(link)}
          </div>
        </nav>
        <main className="main">
          {me.loading && !account && <Loading label="Loading your family" />}
          {me.error && !account && <ErrorBox message={me.error} onRetry={() => void me.reload()} />}
          {account && (showLockScreen
            ? <ChoosePlan />
            : <Outlet context={{ account, reloadAccount: me.reload } satisfies ShellContext} />)}
        </main>
      </div>
    </div>
  );
}

function ChoosePlan() {
  return (
    <>
      <PageHead title="Choose a plan" />
      <Card className="first-run">
        <p style={{ fontSize: 16 }}>Your free trial has ended.</p>
        <p className="muted">
          The rules on your kids' devices keep working with the last settings you saved. To change rules,
          answer requests or see reports again, choose a plan: $4 a month or $36 a year per family, with
          unlimited kids and devices.
        </p>
        <div className="row">
          <Link to="/billing" className="btn btn-primary">Choose a plan</Link>
          <Link to="/settings" className="btn btn-ghost">Settings and sign out</Link>
        </div>
      </Card>
    </>
  );
}
