/** Small, dependency-free helpers shared by the core modules. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(prefix = ''): string {
  const c = globalThis.crypto;
  const raw = c && 'randomUUID' in c ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return prefix ? `${prefix}_${raw}` : raw;
}

/** 32-bit FNV-1a hash of a string; used to derive seeds. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32: a small, fast seeded generator. Reproducible across browsers. */
export function rng(seed: string | number): () => number {
  let a = typeof seed === 'number' ? seed >>> 0 : hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle with a seeded generator; returns a new array. */
export function shuffle<T>(xs: readonly T[], seed: string | number): T[] {
  const r = rng(seed);
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function groupBy<T, K extends string | number>(xs: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export function isMissing(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

export function fmt(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || Number.isNaN(x)) return 'NA';
  if (!Number.isFinite(x)) return x > 0 ? 'Inf' : '-Inf';
  return x.toFixed(digits);
}

export function pct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return 'NA';
  return `${(x * 100).toFixed(digits)}%`;
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'x';
}

export function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/**
 * Normalise an ORCID iD (bare or as an https://orcid.org/ link) to 0000-0000-0000-000X, or return null
 * if it is malformed or its ISO 7064 MOD 11-2 check character is wrong.
 */
export function normalizeOrcid(input: string): string | null {
  const raw = input.trim().replace(/^https?:\/\/(www\.)?orcid\.org\//i, '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^\d{15}[\dX]$/.test(raw)) return null;
  let total = 0;
  for (const ch of raw.slice(0, 15)) total = (total + Number(ch)) * 2;
  const check = (12 - (total % 11)) % 11;
  const expected = check === 10 ? 'X' : String(check);
  if (raw[15] !== expected) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
}

/** A lab handle: lowercase letters, digits and single hyphens, 2 to 63 characters. */
export function labSlug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'lab';
}

export const LAB_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
