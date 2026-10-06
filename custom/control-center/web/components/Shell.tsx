import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { Menu } from 'lucide-react';
import { NAV_GROUPS } from '../nav';
import { apiGet } from '../lib/api';
import { afterFocusSettles, isRendered } from '../lib/focus';
import { useLiveInvalidation } from '../lib/sse';
import { useTheme } from '../lib/theme';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AskDrawer, useAskHotkey } from './AskDrawer';
import { CommandPalette } from './CommandPalette';
import { ThemeSwitcher } from './ThemeSwitcher';
import { ConfirmProvider } from './ConfirmDialog';
import { UsageMeter } from '../features/settings/UsageMeter';
import { serverDown, useReloadStatus } from '../features/dev/DevChatPage';
import type { SystemStatus } from '@shared/types';
import type { DailyStatus, RunMeta, ScheduleLogs, SessionMeta } from '@shared/api';

function DailyBanner() {
  const q = useQuery({ queryKey: ['system', 'daily'], queryFn: () => apiGet<DailyStatus>('/api/system/daily'), refetchInterval: 10_000 });
  if (!q.data?.running) return null;
  return (
    <div className="banner" role="status">
      The daily job (run-daily.sh) is running. Writers stay available; the core locks serialize them.
    </div>
  );
}

/** Narrow windows replace a chip's text with its data-short form (not color-only); the full text stays in the accessibility tree. */
function ChipText({ children }: { children: string }) {
  return <span className="chip__text">{children}</span>;
}

function DailyJobChip() {
  const q = useQuery({ queryKey: ['immigration', 'logs', 'immigration-watch'], queryFn: () => apiGet<ScheduleLogs>('/api/schedule/logs?job=immigration-watch') });
  const latest = q.data?.latest;
  if (!latest) return null;
  const ok = latest.status === 'ok';
  return (
    <Link to="/runs" className={`chip chip--daily ${ok ? 'chip--ok' : latest.status === 'failed' ? 'chip--danger' : 'chip--warn'}`} aria-label={`Daily job ${latest.date}: ${latest.status}`}>
      Daily {latest.date.slice(5)}: {latest.status}
    </Link>
  );
}

function HealthChip() {
  const q = useQuery({ queryKey: ['system', 'status'], queryFn: () => apiGet<SystemStatus>('/api/system/status') });
  if (q.isPending)
    return (
      <span className="chip" aria-busy="true" title="Checking setup" data-short="Setup ...">
        <ChipText>Checking setup</ChipText>
      </span>
    );
  if (q.isError)
    return (
      <span className="chip chip--danger" title="Status unavailable" data-short="Setup ?">
        <ChipText>Status unavailable</ChipText>
      </span>
    );
  const s = q.data;
  // An unapproved Claude Code runs no session, but the rest of the app works: the chip says so instead of the server refusing to start.
  const ok = Boolean(s.claude.version) && s.claude.approved && s.keychainTokenPresent;
  const title = ok ? 'Claude CLI and Keychain token found' : (s.claude.problem ?? 'Setup incomplete: see Settings');
  return (
    <Link to="/settings" search={{ tab: 'engine' }} className={`chip ${ok ? 'chip--ok' : 'chip--warn'}`} title={title} data-short={ok ? 'Setup OK' : 'Setup !'}>
      <ChipText>{ok ? 'Setup OK' : 'Setup needs attention'}</ChipText>
    </Link>
  );
}

export function ReloadBanner() {
  const q = useReloadStatus();
  const s = q.data;
  if (!s || s.state !== 'failed') return null;
  // With no server running, Dev Chat cannot load either: only /__recovery (served by the supervisor) can revert or restart.
  if (serverDown(s)) {
    return (
      <div className="banner" role="alert">
        The server stopped: {s.error}. Nothing serves the app until it runs again: open <a href="/__recovery">/__recovery</a> to revert the change or restart the server.
      </div>
    );
  }
  return (
    <div className="banner" role="alert">
      Server reload failed: {s.error}. The previous server keeps running. Review the change in <Link to="/dev">Dev Chat</Link> or open <a href="/__recovery">/__recovery</a>.
    </div>
  );
}

function ActivityChip() {
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => apiGet<SessionMeta[]>('/api/sessions'), refetchInterval: 5000 });
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => apiGet<RunMeta[]>('/api/runs'), refetchInterval: 5000 });
  const active = (sessions.data ?? []).filter((s) => s.status === 'running' || s.status === 'queued').length + (runs.data ?? []).filter((r) => (r.status === 'running' || r.status === 'queued') && !r.actionId.startsWith('session.')).length;
  const waiting = (sessions.data ?? []).filter((s) => s.status === 'awaiting_user').length;
  return (
    <Link to="/sessions" className={`chip ${active ? 'chip--info' : waiting ? 'chip--warn' : 'chip--neutral'}`} aria-label={`Activity: ${active} running, ${waiting} waiting for you`} title={active ? `${active} running` : waiting ? `${waiting} waiting for you` : 'Idle'} data-short={active ? `${active} run` : waiting ? `${waiting} wait` : 'Idle'}>
      <ChipText>{active ? `${active} running` : waiting ? `${waiting} waiting for you` : 'Idle'}</ChipText>
    </Link>
  );
}

/** Any open Radix dialog other than the palette itself (confirm, action parameters, mode launch) is modal and owns the keyboard. */
function otherModalOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]:not(.palette), [role="alertdialog"][data-state="open"]') !== null;
}

/** Keep in step with the max-width media queries in base.css (the md breakpoint, 768px). */
const NARROW_QUERY = '(max-width: 767px)';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function usePaletteHotkey(toggle: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}

export function Shell() {
  useLiveInvalidation();
  const { resolved: theme } = useTheme();
  const [ask, setAsk] = useState(false);
  const [palette, setPalette] = useState(false);
  // Below the md breakpoint the sidebar is a drawer. It is open for the one path it was opened on, so any navigation closes it.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [navOpenOn, setNavOpenOn] = useState<string | null>(null);
  const navOpen = navOpenOn === pathname;
  const closeNav = useCallback(() => setNavOpenOn(null), []);
  const menuRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  // Set when another overlay closes the drawer: that overlay owns focus, so it is not handed back to Menu.
  const overlayTookFocus = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  // Browsers may already have moved focus to the body when its element is hidden, so remember whether it was last inside the nav.
  const focusInNav = useRef(false);
  useEffect(() => {
    const inNav = (t: EventTarget | null) => t instanceof Node && Boolean(navRef.current?.contains(t));
    const onIn = (e: FocusEvent) => {
      focusInNav.current = inNav(e.target);
    };
    const onOut = (e: FocusEvent) => {
      if (inNav(e.target) && isRendered(e.target as Element)) focusInNav.current = false;
    };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);
  /** The one place that keeps the invariant: focus is never left on an element that is not rendered. */
  const rescueFocus = useCallback((preferred?: HTMLElement | null) => {
    const active = document.activeElement;
    const lost = !active || active === document.body;
    const narrow = window.matchMedia(NARROW_QUERY).matches;
    if (lost ? !(focusInNav.current && narrow) : isRendered(active)) return;
    const fallback = narrow ? menuRef.current : navRef.current?.querySelector<HTMLElement>('a[href]');
    const target = [preferred, fallback].find(isRendered);
    if (target) target.focus();
    else if (!lost) (active as HTMLElement).blur();
  }, []);
  /** Every overlay toggles through here, by button or hotkey. At most one is open: opening one closes the other, and the original opener is kept for the close. */
  const toggleOverlay = useCallback(
    (which: 'ask' | 'palette') => {
      if (otherModalOpen()) return;
      if (wasOpen.current) overlayTookFocus.current = true;
      if (!ask && !palette) {
        const active = document.activeElement;
        const inDrawer = active instanceof HTMLElement && navRef.current?.contains(active) && window.matchMedia(NARROW_QUERY).matches;
        openerRef.current = inDrawer ? menuRef.current : active instanceof HTMLElement ? active : null;
      }
      setNavOpenOn(null);
      const wasThisOpen = which === 'ask' ? ask : palette;
      setAsk(which === 'ask' && !wasThisOpen);
      setPalette(which === 'palette' && !wasThisOpen);
    },
    [ask, palette],
  );
  const toggleAsk = useCallback(() => toggleOverlay('ask'), [toggleOverlay]);
  const togglePalette = useCallback(() => toggleOverlay('palette'), [toggleOverlay]);
  useAskHotkey(toggleAsk);
  usePaletteHotkey(togglePalette);
  const overlayOpen = ask || palette;
  const wasOverlayOpen = useRef(false);
  useEffect(() => {
    const closed = wasOverlayOpen.current && !overlayOpen;
    wasOverlayOpen.current = overlayOpen;
    if (!closed) return;
    return afterFocusSettles(() => {
      const active = document.activeElement;
      if (!active || active === document.body) {
        const opener = openerRef.current;
        if (isRendered(opener)) opener.focus();
        else rescueFocus();
      } else rescueFocus(openerRef.current);
    });
  }, [overlayOpen, rescueFocus]);
  useEffect(() => {
    if (navOpen) navRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    else if (wasOpen.current && !overlayTookFocus.current && window.matchMedia(NARROW_QUERY).matches) menuRef.current?.focus();
    wasOpen.current = navOpen;
    overlayTookFocus.current = false;
  }, [navOpen]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return setNavOpenOn(null);
      const nav = navRef.current;
      if (e.key !== 'Tab' || !nav) return;
      const items = [...nav.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (!nav.contains(active) || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
        e.preventDefault();
        (e.shiftKey && nav.contains(active) ? last : first).focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    let cancel = () => {};
    const onChange = () => {
      if (!mq.matches) setNavOpenOn(null);
      cancel();
      cancel = afterFocusSettles(() => rescueFocus());
    };
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
      cancel();
    };
  }, [rescueFocus]);
  return (
    <ConfirmProvider>
      <div className={`shell${navOpen ? ' shell--nav-open' : ''}`}>
        <nav ref={navRef} className="shell__side" id="primary-nav" aria-label="Primary">
          <div className="brand">
            <span className="brand__dot" aria-hidden="true" />
            <span>Control Center</span>
          </div>
          {NAV_GROUPS.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-group__label">{g.label}</div>
              {g.items.map((item) => (
                <Link key={item.to} to={item.to} className="nav-link" activeOptions={{ exact: item.to === '/' }} activeProps={{ 'aria-current': 'page' }} onClick={closeNav}>
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
          <div className="nav-group nav-group--bottom">
            <UsageMeter compact />
          </div>
        </nav>
        <div className="shell__scrim" onClick={closeNav} aria-hidden="true" />
        <header className="shell__top">
          <button ref={menuRef} type="button" className="menu-toggle" onClick={() => setNavOpenOn(navOpen ? null : pathname)} aria-expanded={navOpen} aria-controls="primary-nav">
            <Menu size={18} aria-hidden="true" />
            <span className="sr-only">Menu</span>
          </button>
          <button type="button" className="palette-trigger" onClick={togglePalette} aria-label="Open command palette" title="Command palette (Cmd+K)">
            <span className="palette-trigger__long">Search or run</span>
            <span className="palette-trigger__short">Search</span>
            <kbd>Cmd K</kbd>
          </button>
          <span style={{ flex: 1 }} />
          <DailyJobChip />
          <ActivityChip />
          <HealthChip />
          <ThemeSwitcher />
          <button type="button" onClick={toggleAsk} aria-expanded={ask} aria-label="Open Ask drawer" title="Ask the advisor (Cmd+J)">
            Ask
          </button>
        </header>
        <main className="shell__main" id="main">
          <ReloadBanner />
          <DailyBanner />
          <Outlet />
        </main>
        <AskDrawer open={ask} onClose={() => setAsk(false)} />
        <CommandPalette open={palette} onOpenChange={setPalette} />
        <Toaster theme={theme} position="bottom-right" closeButton />
      </div>
    </ConfirmProvider>
  );
}
