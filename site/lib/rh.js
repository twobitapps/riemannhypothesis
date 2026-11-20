// Shared, client-safe helpers. No fixture data lives here.

// Public coordinator API base for browser calls. The same-origin proxy
// (app/api/rh) by default; the Worker origin is server-only (RH_API).
export const RH_API = (process.env.NEXT_PUBLIC_RH_API || '/api/rh').replace(/\/+$/, '');

// Local dev only: the page reads a canned feed served by /api/rh/* routes.
export const FIXTURE =
  process.env.NODE_ENV === 'development' && !!process.env.NEXT_PUBLIC_RH_FIXTURE;

export const ONLINE_MS = 60_000; // 3 × beat_ms (20 s)

export const ACTIVE = new Set(['thinking', 'checking', 'verifying', 'building', 'seeding', 'preparing']);

export const ROLE_ORDER = ['anchor', 'canary', 'finisher', 'atlas', 'prover', 'verifier', 'thinker'];
export const BIG_ROLES = new Set(['anchor', 'canary', 'finisher', 'atlas', 'prover']);

export const TRACKS = [
  { key: 'M', name: 'Formalize' },
  { key: 'A', name: 'Atlas' },
  { key: 'R', name: 'Receipts' },
];

const nf = new Intl.NumberFormat('en-US');
export const fmt = (n) => nf.format(Math.round(Number(n) || 0));

export function fmtRam(gb) {
  const g = Number(gb) || 0;
  if (g >= 1000) return { v: (g / 1024).toFixed(g >= 10240 ? 0 : 1), u: 'TB' };
  return { v: fmt(g), u: 'GB' };
}

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function hash(s) {
  let h = 2166136261;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function primaryRole(node) {
  const roles = node?.roles || [];
  for (const r of ROLE_ORDER) if (roles.includes(r)) return r;
  return 'thinker';
}

export function laneList(lanes) {
  if (!lanes) return [];
  const out = [];
  if (lanes.claude) out.push('claude');
  if (lanes.codex) out.push('codex');
  const local = Array.isArray(lanes.local_models) ? lanes.local_models.length : lanes.local ? 1 : 0;
  for (let i = 0; i < Math.min(local, 3); i++) out.push('local');
  return out;
}
