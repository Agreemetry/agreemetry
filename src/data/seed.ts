/**
 * First launch of a local workspace: an administrator account, the bundled project archives listed in
 * public/projects/index.json (loaded first, so they appear as the first projects), and the simulated
 * demonstrations.
 */
import type { ProjectArchive } from '../core/types';
import type { LocalBackend } from './localBackend';
import { seedDemos } from './demo';

export interface BundledProject {
  file: string;
  title: string;
  description: string;
}

export async function fetchArchive(url: string): Promise<ProjectArchive> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status}).`);
  return parseArchiveBytes(new Uint8Array(await res.arrayBuffer()));
}

/** Plain or gzip-compressed archive bytes; servers sometimes decompress .gz transparently, so check the magic bytes. */
export async function parseArchiveBytes(buf: Uint8Array): Promise<ProjectArchive> {
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress the bundled project.');
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text()) as ProjectArchive;
  }
  return JSON.parse(new TextDecoder().decode(buf)) as ProjectArchive;
}

export async function bundledProjects(): Promise<BundledProject[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}projects/index.json`);
    if (!res.ok) return [];
    return ((await res.json()) as { projects: BundledProject[] }).projects ?? [];
  } catch {
    return [];
  }
}

export async function seedWorkspace(b: LocalBackend): Promise<void> {
  const admin = await b.createUser('Workspace administrator');
  for (const bp of await bundledProjects()) {
    try {
      const archive = await fetchArchive(`${import.meta.env.BASE_URL}projects/${bp.file}`);
      await b.runAs(admin.id, (s) => {
        const p = s.importArchive(archive, { newIds: false });
        // Make the workspace administrator an administrator of the bundled project too.
        s.upsertMembership({ projectId: p.id, userId: admin.id, role: 'admin', pseudonym: 'ADM-W', active: true, adjudicates: false });
      });
    } catch (e) {
      console.warn('Bundled project not loaded:', bp.file, e);
    }
  }
  await b.runAs(admin.id, (s) => {
    void s;
    seedDemos(b.db, admin.id);
  });
}
