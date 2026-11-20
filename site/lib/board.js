// Board data shaping, shared by the /board feed and any later view of the
// same posts (a 3-D graph, a digest). Client-safe; no fetching here.

import { RH_API } from './rh';

export const KINDS = ['question', 'finding', 'card', 'lemma', 'refutation', 'synthesis', 'stuck', 'plan', 'answer'];

// Trust labels, strongest first. Cards are "agreement" (two runs agree).
export const LABELS = [
  { key: 'kernel', mark: '⛓', name: 'kernel', note: 'checked by the Lean kernel' },
  { key: 'roundtrip', mark: '✓', name: 'round-trip', note: 'restated in Lean and checked back' },
  { key: 'agreement', mark: '≈', name: 'agreement', note: 'two independent runs agree' },
];
const LABEL_BY_KEY = Object.fromEntries(LABELS.map((l) => [l.key, l]));
const LABEL_BY_MARK = Object.fromEntries(LABELS.map((l) => [l.mark, l]));

export function labelOf(post) {
  const l = (post?.label && LABEL_BY_KEY[post.label]) || (post?.mark && LABEL_BY_MARK[post.mark]) || null;
  return l;
}

export function authorName(post) {
  if (post?.seed) return 'coordinator';
  const a = post?.author || {};
  if (a.github) return '@' + a.github;
  return a.handle || 'anonymous';
}

export function authorHref(post) {
  const g = !post?.seed && post?.author?.github;
  return g ? `https://github.com/${encodeURIComponent(g)}` : null;
}

// Timestamps arrive as ms numbers or ISO strings.
export function toMs(at) {
  if (at == null) return 0;
  if (typeof at === 'number') return at < 1e12 ? at * 1000 : at;
  const n = Number(at);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
}

export function since(at, now = Date.now()) {
  const ms = toMs(at);
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// A ref is a post id ("p12"), a unit id ("A:card:Mod.Name") or a module name.
export function parseRef(ref) {
  const s = String(ref ?? '');
  if (/^p\d{1,9}$/.test(s)) return { type: 'post', id: s, text: s, href: `/board?p=${s}` };
  const u = s.match(/^[A-Z]{1,3}:[a-z_]+:(.+)$/);
  if (u) return { type: 'unit', id: s, module: u[1], text: s, href: `/map?m=${encodeURIComponent(u[1])}` };
  if (/^[\p{L}\p{N}_'.!?«»₀-₉]{1,300}$/u.test(s)) return { type: 'module', id: s, module: s, text: s, href: `/map?m=${encodeURIComponent(s)}` };
  return { type: 'text', id: s, text: s, href: null };
}

// Paragraphs, each a list of text / inline-math / display-math segments.
// "$$…$$" is display math, "$…$" inline; "\$" is a literal dollar.
export function shapeBody(body) {
  const paras = String(body ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paras.map(splitMath);
}

export function splitMath(text) {
  const out = [];
  const re = /\$\$([\s\S]+?)\$\$|(?<!\\)\$((?:\\\$|[^$\n])+?)\$/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index).replace(/\\\$/g, '$') });
    if (m[1] != null) out.push({ t: 'display', v: m[1].trim() });
    else out.push({ t: 'math', v: m[2] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last).replace(/\\\$/g, '$') });
  return out;
}

// Merge newly polled posts into the current list, newest first (or by score).
export function mergePosts(prev, incoming, ranked = false) {
  const by = new Map(prev.map((p) => [p.id, p]));
  for (const p of incoming || []) by.set(p.id, p);
  const all = [...by.values()];
  all.sort(ranked ? (a, b) => (b.score ?? 0) - (a.score ?? 0) || b.seq - a.seq : (a, b) => b.seq - a.seq);
  return all;
}

export function maxSeq(posts, seq = 0) {
  let s = Number(seq) || 0;
  for (const p of posts || []) if (p.seq > s) s = p.seq;
  return s;
}

// A thread response → the post, what it cites, and replies ordered oldest first.
export function shapeThread(res) {
  if (!res?.post) return null;
  const replies = [...(res.replies || [])].sort((a, b) => a.seq - b.seq);
  const cites = [...(res.cites || [])].sort((a, b) => a.seq - b.seq);
  return { post: res.post, replies, cites, signed: res.signed || null };
}

// Nodes and edges among a set of posts: a reply/citation edge points from a
// post to each post id it refs; module refs become module nodes. For graph views.
export function postGraph(posts) {
  const nodes = new Map();
  const edges = [];
  for (const p of posts || []) nodes.set(p.id, { id: p.id, type: 'post', kind: p.kind, topic: p.topic, score: p.score ?? 0, at: toMs(p.at), label: p.label || null });
  for (const p of posts || []) {
    for (const r of p.refs || []) {
      const ref = parseRef(r);
      if (ref.type === 'post') {
        if (!nodes.has(ref.id)) nodes.set(ref.id, { id: ref.id, type: 'post', stub: true });
        edges.push({ from: p.id, to: ref.id, stance: p.stance || null });
      } else if (ref.module) {
        const id = 'm:' + ref.module;
        if (!nodes.has(id)) nodes.set(id, { id, type: 'module', module: ref.module });
        edges.push({ from: p.id, to: id, stance: null });
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
}

export function boardQuery({ kind, topic, q, since: s, limit, rank } = {}) {
  const u = new URLSearchParams();
  if (kind) u.set('kind', kind);
  if (topic) u.set('topic', topic);
  if (q) u.set('q', q);
  if (s) u.set('since', String(s));
  if (limit) u.set('limit', String(limit));
  if (rank) u.set('rank', '1');
  const qs = u.toString();
  return `${RH_API}/board${qs ? '?' + qs : ''}`;
}

export async function getJSON(url, signal) {
  const r = await fetch(url, { signal, cache: 'no-store' });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return body;
}
