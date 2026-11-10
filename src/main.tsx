import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import { AppProvider, TopBar, useApp, useRoute } from './ui/app';
import { Account, Onboarding, Projects, SignIn } from './ui/pages/Home';
import { LabPage, Labs } from './ui/pages/Labs';
import { ProjectPage } from './ui/pages/Project';
import type { Backend } from './data/backend';
import { LocalBackend } from './data/localBackend';
import { seedWorkspace } from './data/seed';

async function makeBackend(): Promise<Backend> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (url && key) {
    const { SupabaseBackend } = await import('./data/supabaseBackend');
    return new SupabaseBackend(url, key);
  }
  return new LocalBackend(undefined, seedWorkspace);
}

function Routes() {
  const { user, backend } = useApp();
  const r = useRoute();
  if (!user) return <SignIn />;
  // On a shared server, a new researcher completes the profile and accepts the terms before anything else.
  if (backend.mode === 'supabase' && !user.termsAcceptedAt) return <Onboarding />;
  if (r.path[0] === 'p' && r.path[1]) return <ProjectPage projectId={r.path[1]} tab={r.path[2] ?? 'dashboard'} sub={r.path[3]} />;
  const page = r.path[0] === 'account' ? <Account /> : r.path[0] === 'labs' && r.path[1] ? <LabPage labId={r.path[1]} /> : r.path[0] === 'labs' ? <Labs /> : <Projects />;
  return (
    <>
      <TopBar />
      <main id="main">{page}</main>
    </>
  );
}

// One backend per page load, even when React runs effects twice in development.
let booting: Promise<Backend> | null = null;
function bootOnce(): Promise<Backend> {
  booting ??= makeBackend().then(async (b) => {
    await b.init();
    return b;
  });
  return booting;
}

function Boot() {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    bootOnce().then(setBackend, (e: Error) => setError(e.message));
  }, []);
  if (error) return <div className="center-narrow"><div className="notice error">Agreemetry could not start: {error}</div></div>;
  if (!backend) return <div className="center-narrow muted">Starting Agreemetry. The first start prepares the bundled and demonstration projects.</div>;
  return (
    <AppProvider backend={backend}>
      <div className="shell"><Routes /></div>
    </AppProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
