import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Backend } from '../data/backend';
import type { ItemState, ProjectData, Role, User } from '../core/types';
import { computeAllStatuses, type ItemStatus } from '../core/workflow';
import { Icon, Logo } from './components';
import { roleIn } from '../core/policy';

// Routing (hash based, so it works on GitHub Pages without server rewrites) ------------------------------

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [p, q] = raw.split('?');
  return { path: p ? p.split('/').map(decodeURIComponent) : [], query: new URLSearchParams(q ?? '') };
}

export function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

export function go(path: string) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

// App context ---------------------------------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  details?: string[];
  tone: 'ok' | 'error';
}

interface AppCtx {
  backend: Backend;
  user: User | null;
  refreshUser: () => void;
  toast: (text: string, tone?: 'ok' | 'error', details?: string[]) => void;
  fail: (e: unknown) => void;
  theme: 'light' | 'dark' | 'system';
  setTheme: (t: 'light' | 'dark' | 'system') => void;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('App context missing');
  return c;
}

export function AppProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  const [user, setUser] = useState<User | null>(backend.currentUser());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setThemeState] = useState<'light' | 'dark' | 'system'>(() => {
    try {
      return (localStorage.getItem('agreemetry.theme') as 'light' | 'dark' | null) ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('agreemetry.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  useEffect(() => backend.subscribe(() => setUser(backend.currentUser())), [backend]);
  const toast = useCallback((text: string, tone: 'ok' | 'error' = 'ok', details?: string[]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone, details }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 9000 : 3500);
  }, []);
  const fail = useCallback(
    (e: unknown) => {
      const err = e as Error & { details?: string[] };
      toast(err?.message ?? String(e), 'error', err?.details);
    },
    [toast],
  );
  const value = useMemo(() => ({ backend, user, refreshUser: () => setUser(backend.currentUser()), toast, fail, theme, setTheme: setThemeState }), [backend, user, toast, fail, theme]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'error' ? 'error' : ''}`}>
            <Icon name={t.tone === 'error' ? 'alert' : 'check'} />
            <div>
              {t.text}
              {t.details && t.details.length > 0 && (
                <ul>
                  {t.details.slice(0, 8).map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              )}
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

// Project data hook -----------------------------------------------------------------------------------

export interface ProjectView {
  data: ProjectData;
  statuses: Map<string, ItemStatus>;
  role: Role | undefined;
  isAdmin: boolean;
  isLead: boolean;
  /** Whether this viewer sees every judgment (so statuses are computed locally rather than taken from the server). */
  fullView: boolean;
  stateOf: (itemId: string) => ItemState;
  reload: () => Promise<void>;
}

export function useProject(projectId: string): { view: ProjectView | null; error: string | null } {
  const { backend, user } = useApp();
  const [data, setData] = useState<ProjectData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await backend.getProjectData(projectId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [backend, projectId]);
  useEffect(() => {
    void load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = backend.subscribe(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void load(), 120);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [backend, load, user?.id]);
  const view = useMemo<ProjectView | null>(() => {
    if (!data || !user) return null;
    const role = roleIn(data, user.id);
    const statuses = computeAllStatuses(data);
    const fullView = role === 'admin';
    const stateOf = (id: string): ItemState => (fullView || !data.serverStatus ? statuses.get(id)?.state ?? 'awaiting' : data.serverStatus[id]?.state ?? statuses.get(id)?.state ?? 'awaiting');
    return { data, statuses, role, isAdmin: role === 'admin', isLead: role === 'lead', fullView, stateOf, reload: load };
  }, [data, user, load]);
  return { view, error };
}

// Shell ---------------------------------------------------------------------------------------------------

export function TopBar() {
  const { backend, user, theme, setTheme } = useApp();
  const r = useRoute();
  const section = r.path[0] === 'labs' ? 'labs' : r.path[0] === 'account' ? 'account' : r.path[0] === 'p' ? 'project' : 'projects';
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        <Logo />
        <span>Agreemetry</span>
        <small className="hide-sm">Research adjudication</small>
      </a>
      {user && (
        <nav className="topnav" aria-label="Workspace">
          <a href="#/" className={section === 'projects' ? 'active' : ''} aria-current={section === 'projects' ? 'page' : undefined}>Projects</a>
          <a href="#/labs" className={section === 'labs' ? 'active' : ''} aria-current={section === 'labs' ? 'page' : undefined}>Labs</a>
        </nav>
      )}
      <span className="spacer" />
      <span className="mode-pill" title={backend.mode === 'local' ? 'Data are stored in this browser. Use the Supabase deployment for a shared, server-enforced workspace.' : 'Connected to the shared server.'}>
        {backend.mode === 'local' ? 'Local workspace' : 'Shared server'}
      </span>
      <button className="btn ghost icon" onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')} aria-label={`Theme: ${theme}. Change theme`} title={`Theme: ${theme}`}>
        <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
      </button>
      {user && (
        <>
          <a className="btn ghost" href="#/account" title="Account">
            {user.displayName}
          </a>
          <button className="btn ghost icon" onClick={() => void backend.signOut()} aria-label="Sign out" title="Sign out">
            <Icon name="out" />
          </button>
        </>
      )}
    </header>
  );
}

export interface NavEntry {
  key: string;
  label: string;
  icon: string;
  count?: number;
  show: boolean;
}

export function SideNav({ projectId, project, current, entries, role }: { projectId: string; project: string; current: string; entries: NavEntry[]; role?: Role }) {
  return (
    <nav className="sidenav" aria-label="Project">
      <div className="proj">
        <strong>{project}</strong>
        <span>{role === 'admin' ? 'Administrator' : role === 'lead' ? 'Adjudication lead' : 'Adjudicator'}</span>
      </div>
      {entries
        .filter((e) => e.show)
        .map((e) => (
          <a key={e.key} className={`navlink ${current === e.key ? 'active' : ''}`} href={`#/p/${encodeURIComponent(projectId)}/${e.key}`} aria-current={current === e.key ? 'page' : undefined}>
            <Icon name={e.icon} />
            {e.label}
            {e.count !== undefined && e.count > 0 && <span className="count">{e.count}</span>}
          </a>
        ))}
      <div className="navsection">Workspace</div>
      <a className="navlink" href="#/">
        <Icon name="left" />
        All projects
      </a>
    </nav>
  );
}
