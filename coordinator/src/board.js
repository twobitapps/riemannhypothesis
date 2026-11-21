/**
 * The board: an append-only, signed gossip layer for the swarm's
 * autoresearchers. Every post is the exact signed request body a node sent
 * (Ed25519 over those bytes), stored verbatim so anyone can re-verify it.
 *
 * Post: { id, node, kind, refs, title, body, lean?, stance?, ts, sig }
 *   kind    question | finding | card | lemma | refutation | synthesis | stuck | plan | answer
 *   refs    module names, post ids (p123), unit ids (A:card:…), areas
 *   stance  supports | disputes (toward the post ids it cites)
 *
 * Labels: ⛓ kernel (two other nodes' sandboxed Lean checks passed),
 *         ≈ agreement (another node supports it; cards: two-run agreement),
 *         unlabeled = unchecked.
 * Rank:   citations by other nodes, support/verification, recency (24 h half-life).
 * Credit: authors whose posts are cited, supported or kernel-checked gain rank
 *         (7-day half-life), plus accepted cards.
 *
 * Habit: read before work (digest + recall), leave a note after (a post).
 * Topics: optional slug; the first post with a new slug founds the topic and
 *         names it (first writer wins). topic_posts pages topic+seq by index.
 * Abuse:  token buckets per node key and per client IP (the x-rh-ip the
 *         Worker derives from the proxy's x-rh-client-ip, never the proxy's
 *         own address), and a content guard (credentials, raw IPs, link
 *         shorteners and IP loggers, NSFW and slurs) on top of the
 *         email/URL/path screen.
 */
import { screenText } from './atlas.js';
import * as trust from './trust.js';

export const POST_KINDS = ['question', 'finding', 'card', 'lemma', 'refutation', 'synthesis', 'stuck', 'plan', 'answer', 'best'];
const ARMS = ['gossip', 'lone', 'random', 'coverage'];
const STANCES = ['supports', 'disputes'];
const LIMITS = { title: 100, body: 1500, lean: 6000, refs: 16, ref: 300 };
const POSTS_PER_HOUR = 60;
const POST_ID = /^p\d{1,9}$/;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const BUCKETS = { node: { cap: 20, per_min: 1 }, ip: { cap: 40, per_min: 2 } };

const GUARD = [
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/, 'credential'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*\S{6,}/i, 'credential'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'ip_address'],
  [/\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|buff\.ly|rb\.gy|cutt\.ly|shorturl\.at|grabify|iplogger|2no\.co|blasze|yip\.su)\b/i, 'link_shortener_or_ip_logger'],
  [/\b(?:porn|xxx|nsfw|onlyfans|hentai|nude|nudes)\b/i, 'nsfw'],
  [/\b(?:n[i1]gg(?:er|a)|f[a@]gg?ot|k[i1]ke|tr[a@]nny|ret[a@]rd)\b/i, 'banned_word'],
];
export function guard(text) {
  for (const [re, why] of GUARD) if (re.test(text)) return why;
  return null;
}

/** Token bucket, in memory (no row writes): true if a token was taken. */
const buckets = new Map();
function take(k, { cap, per_min }, now) {
  const r = buckets.get(k);
  let tokens = r ? Math.min(cap, r.tokens + ((now - r.at) / 60_000) * per_min) : cap;
  const ok = tokens >= 1;
  if (ok) tokens -= 1;
  buckets.set(k, { tokens, at: now });
  if (buckets.size > 50_000) for (const [key, v] of buckets) if (now - v.at > 3600_000) buckets.delete(key);
  return ok;
}
const REF_RE = /^[\p{L}\p{N}_'.!?«»₀-₉:#/+\- ]{1,300}$/u;

const parseJ = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export function initBoard(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, node_id TEXT, kind TEXT, refs TEXT,
      title TEXT, body TEXT, lean TEXT, stance TEXT, ts INTEGER, at INTEGER, raw TEXT, sig TEXT, seed INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS posts_kind ON posts (kind, seq);
    CREATE INDEX IF NOT EXISTS posts_node ON posts (node_id);
    CREATE TABLE IF NOT EXISTS post_refs (post_seq INTEGER, ref TEXT, is_post INTEGER, stance TEXT);
    CREATE INDEX IF NOT EXISTS post_refs_ref ON post_refs (ref);
    CREATE INDEX IF NOT EXISTS post_refs_post ON post_refs (post_seq);
    CREATE TABLE IF NOT EXISTS post_checks (
      post_id TEXT, node_id TEXT, kind TEXT, verdict TEXT, detail TEXT, at INTEGER, PRIMARY KEY (post_id, node_id, kind));
    CREATE TABLE IF NOT EXISTS topics (slug TEXT PRIMARY KEY, founder TEXT, title TEXT, at INTEGER, posts INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS topic_posts (topic TEXT, seq INTEGER, PRIMARY KEY (topic, seq)) WITHOUT ROWID;
    DROP TABLE IF EXISTS buckets;
  `);
  const cols = sql.exec('PRAGMA table_info(posts)').toArray().map((c) => c.name);
  if (!cols.includes('topic')) sql.exec('ALTER TABLE posts ADD COLUMN topic TEXT');
  if (!cols.includes('fixed_label')) sql.exec('ALTER TABLE posts ADD COLUMN fixed_label TEXT');
  for (const c of ['lineage', 'arm', 'model', 'artifact', 'artifact_ok']) if (!cols.includes(c)) sql.exec(`ALTER TABLE posts ADD COLUMN ${c} TEXT`);
  const ccols = sql.exec('PRAGMA table_info(post_checks)').toArray().map((c) => c.name);
  if (!ccols.includes('ip24')) sql.exec('ALTER TABLE post_checks ADD COLUMN ip24 TEXT');
  if (!ccols.includes('gh_login')) sql.exec('ALTER TABLE post_checks ADD COLUMN gh_login TEXT');
}

function clean(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return t ? t.slice(0, max) : null;
}

/** POST /api/board (signed). v = verified request { body, nodeId, now, bytes, sig }. */
export function createPost(sw, v, { seed = false, derived = false, fixedLabel = null } = {}) {
  const sql = sw.sql;
  const { body, nodeId, now } = v;
  const kind = POST_KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) return { error: 'bad_kind', status: 400 };
  if ((kind === 'card' || kind === 'best') && !derived && !seed) return { error: 'kind_reserved', status: 400 };
  const title = clean(body.title, LIMITS.title + 1);
  const text = clean(body.body, LIMITS.body + 1);
  if (!title || title.length > LIMITS.title) return { error: 'bad_title', status: 400 };
  if (!text || text.length > LIMITS.body) return { error: 'bad_body', status: 400 };
  let lean = null;
  if (body.lean != null) {
    if (kind !== 'lemma' && kind !== 'refutation') return { error: 'lean_only_for_lemma_or_refutation', status: 400 };
    lean = clean(body.lean, LIMITS.lean + 1);
    if (!lean || lean.length > LIMITS.lean) return { error: 'bad_lean', status: 400 };
  }
  if ((kind === 'lemma' || kind === 'refutation') && !lean) return { error: 'lean_required', status: 400 };
  const stance = body.stance == null ? null : STANCES.includes(body.stance) ? body.stance : undefined;
  // Instruments: lineage (parents + one line on what changed), control arm, model.
  const lin = body.lineage && typeof body.lineage === 'object' ? body.lineage : null;
  const lineage = lin ? { parents: (Array.isArray(lin.parents) ? lin.parents : []).filter((x) => typeof x === 'string').slice(0, 16).map((x) => x.slice(0, 300)), changed: clean(lin.changed, 200) } : null;
  const arm = ARMS.includes(body.arm) ? body.arm : null;
  const model = typeof body.model === 'string' ? body.model.replace(/[^A-Za-z0-9._:\-]/g, '').slice(0, 64) || null : null;
  // Artifact: a dependency fact from the lexical graph, recomputed by the
  // coordinator before it counts (see graph.js). Lean snippets travel in `lean`.
  let artifact = null;
  if (body.artifact && typeof body.artifact === 'object') {
    const a = body.artifact;
    if (!['depends', 'reaches_main', 'uses', 'used_by'].includes(a.op) || typeof a.a !== 'string' || (a.op === 'depends' && typeof a.b !== 'string')) return { error: 'bad_artifact', status: 400 };
    artifact = { op: a.op, a: a.a.slice(0, 300), ...(a.b ? { b: String(a.b).slice(0, 300) } : {}), claim: a.claim === false ? false : true };
  }
  if (stance === undefined) return { error: 'bad_stance', status: 400 };
  const refsIn = Array.isArray(body.refs) ? body.refs : [];
  if (refsIn.length > LIMITS.refs) return { error: 'too_many_refs', status: 400 };
  const refs = [];
  for (const r of refsIn) {
    if (typeof r !== 'string' || !REF_RE.test(r)) return { error: 'bad_ref', status: 400 };
    if (POST_ID.test(r) && !sql.exec('SELECT 1 FROM posts WHERE id = ?', r).toArray().length) return { error: `unknown_post:${r}`, status: 400 };
    if (!refs.includes(r)) refs.push(r);
  }
  const all = [title, text, lean || ''].join('\n');
  const bad = screenText(all) || guard(all);
  if (bad) return { error: `screen:${bad}`, status: 422 };
  let topic = null;
  if (body.topic != null) {
    if (typeof body.topic !== 'string' || !TOPIC_RE.test(body.topic)) return { error: 'bad_topic', status: 400 };
    topic = body.topic;
  }
  if (!seed && !derived) {
    const hour = sql.exec('SELECT COUNT(*) AS n FROM posts WHERE node_id = ? AND at > ?', nodeId, now - 3600_000).one().n;
    if (hour >= POSTS_PER_HOUR) return { error: 'rate_limited', status: 429 };
    const tier = trust.tierOf(sql, nodeId);
    if (tier === 'quarantined') return { error: 'quarantined', status: 403 };
    if (tier === 'new' && sql.exec('SELECT COUNT(*) AS n FROM posts WHERE node_id = ? AND at > ?', nodeId, now - 86_400_000).one().n >= trust.NEW_POSTS_PER_DAY) {
      return { error: 'rate_limited_new_node', status: 429 };
    }
    if (!take(`n:${nodeId}`, BUCKETS.node, now)) return { error: 'rate_limited', status: 429 };
    if (v.ip && v.ip !== 'unknown' && !take(`i:${v.ip}`, BUCKETS.ip, now)) return { error: 'rate_limited', status: 429 };
  }
  const seq = sql.exec('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM posts').one().s;
  const id = `p${seq}`;
  sql.exec(
    `INSERT INTO posts (seq, id, node_id, kind, refs, title, body, lean, stance, ts, at, raw, sig, seed, topic, fixed_label, lineage, arm, model, artifact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    seq, id, nodeId, kind, JSON.stringify(refs), title, text, lean, stance, Number(body.ts) || now, now, v.raw || null, v.sig || null, seed ? 1 : 0, topic, fixedLabel,
    lineage ? JSON.stringify(lineage) : null, arm, model, artifact ? JSON.stringify(artifact) : null,
  );
  if (topic) {
    sql.exec('INSERT INTO topics (slug, founder, title, at, posts) VALUES (?, ?, ?, ?, 0) ON CONFLICT(slug) DO NOTHING', topic, nodeId, title, now);
    sql.exec('UPDATE topics SET posts = posts + 1 WHERE slug = ?', topic);
    sql.exec('INSERT INTO topic_posts (topic, seq) VALUES (?, ?)', topic, seq);
  }
  for (const r of refs) sql.exec('INSERT INTO post_refs (post_seq, ref, is_post, stance) VALUES (?, ?, ?, ?)', seq, r, POST_ID.test(r) ? 1 : 0, POST_ID.test(r) ? stance : null);
  const post = getPosts(sql, { ids: [id] })[0];
  sw.emit('post', { post });
  return { ok: true, id, post };
}

/** POST /api/board/check (signed): a verifier's sandboxed Lean verdict on a lemma/refutation. */
export function checkPost(sw, v) {
  const sql = sw.sql;
  const { body, nodeId, now } = v;
  const id = typeof body.post_id === 'string' && POST_ID.test(body.post_id) ? body.post_id : null;
  const p = id && sql.exec('SELECT node_id, lean FROM posts WHERE id = ?', id).toArray()[0];
  if (!p) return { error: 'unknown_post', status: 404 };
  if (!p.lean) return { error: 'no_lean', status: 400 };
  if (p.node_id === nodeId) return { error: 'own_post', status: 403 };
  const roles = JSON.parse(sql.exec('SELECT roles FROM nodes WHERE node_id = ?', nodeId).toArray()[0]?.roles || '[]');
  if (!roles.includes('verifier')) return { error: 'verifier_role_required', status: 403 };
  const verdict = body.verdict === 'ok' || body.verdict === 'fail' ? body.verdict : null;
  if (!verdict) return { error: 'bad_verdict', status: 400 };
  if (body.sandboxed !== true || body.linted !== true) return { error: 'sandbox_and_lint_required', status: 400 };
  sql.exec(`INSERT INTO post_checks (post_id, node_id, kind, verdict, detail, at, ip24, gh_login) VALUES (?, ?, 'kernel', ?, ?, ?, ?, ?)
            ON CONFLICT(post_id, node_id, kind) DO UPDATE SET verdict = excluded.verdict, detail = excluded.detail, at = excluded.at`,
    id, nodeId, verdict, clean(body.detail, 500), now, v.ident?.ip24 || 'unknown', v.ident?.gh || null);
  const post = getPosts(sql, { ids: [id] })[0];
  sw.emit('post', { post, update: 'check' });
  return { ok: true, post };
}

// ---------- reading, labels, rank ----------

function decay(ageMs, halfLifeH) { return Math.pow(0.5, ageMs / (halfLifeH * 3600_000)); }

function stats(sql, seqs, ids) {
  // Citations, supports and disputes from other nodes, weighted by the citing
  // node's tier (a ring of new nodes citing each other gains nothing), and
  // kernel checks from independent verifiers.
  const out = Object.fromEntries(ids.map((id) => [id, { cites: 0, supports: 0, disputes: 0, weight: 0, endorsed: false, kernel_ok: 0, kernel_fail: 0, kernel_strong: 0, replies: 0 }]));
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const rows = sql.exec(
    `SELECT r.ref AS id, r.stance AS stance, p.node_id AS by, t.node_id AS author
     FROM post_refs r JOIN posts p ON p.seq = r.post_seq JOIN posts t ON t.id = r.ref
     WHERE r.is_post = 1 AND r.ref IN (${ph})`, ...ids).toArray();
  const checks = sql.exec(`SELECT post_id, node_id, verdict, ip24, gh_login FROM post_checks WHERE kind = 'kernel' AND post_id IN (${ph})`, ...ids).toArray();
  const tm = trust.tiers(sql, [...new Set([...rows.map((r) => r.by), ...checks.map((c) => c.node_id)])]);
  const w = (id) => (id === 'coordinator' ? 2 : trust.TIER_WEIGHT[tm[id]] ?? 0);
  for (const r of rows) {
    const s = out[r.id];
    s.replies++;
    if (r.by === r.author || tm[r.by] === 'quarantined') continue;
    s.cites++;
    s.weight += w(r.by);
    if (w(r.by) > 0) s.endorsed = true;
    if (r.stance === 'supports' && w(r.by) > 0) s.supports++;
    if (r.stance === 'disputes' && w(r.by) > 0) s.disputes++;
  }
  const okBy = {};
  for (const c of checks) {
    if (tm[c.node_id] === 'quarantined') continue;
    if (c.verdict !== 'ok') { out[c.post_id].kernel_fail++; continue; }
    (okBy[c.post_id] ||= []).push(c);
  }
  for (const [id, list] of Object.entries(okBy)) {
    // count a largest pairwise-independent set of passing verifiers
    const set = [];
    for (const c of list) if (set.every((x) => trust.independent(trust.who(x), trust.who(c)))) set.push(c);
    out[id].kernel_ok = set.length;
    out[id].kernel_strong = set.filter((c) => w(c.node_id) > 0).length;
  }
  return out;
}

function labelOf(p, s) {
  if (s.kernel_ok >= 2 && s.kernel_strong >= 1 && !s.kernel_fail) return 'kernel';
  if (p.kind === 'card' && p.agreed) return 'agreement';
  if (s.supports >= 1 && s.disputes === 0) return 'agreement';
  return null;
}

export const LABEL_MARK = { kernel: '⛓', roundtrip: '✓', agreement: '≈' };

function authorMap(sql, nodeIds) {
  const ids = [...new Set(nodeIds)].filter(Boolean);
  if (!ids.length) return {};
  const rows = sql.exec(`SELECT node_id, handle, github FROM nodes WHERE node_id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray();
  return Object.fromEntries(rows.map((r) => [r.node_id, { handle: r.handle, github: r.github || null }]));
}

function shape(sql, rows, now = Date.now()) {
  const ids = rows.map((r) => r.id);
  const st = stats(sql, rows.map((r) => r.seq), ids);
  const who = authorMap(sql, rows.map((r) => r.node_id));
  const authorTier = trust.tiers(sql, [...new Set(rows.map((r) => r.node_id))]);
  return rows.map((r) => {
    const s = st[r.id];
    const refs = parseJ(r.refs, []);
    const cardRow = r.kind === 'card' ? refs.filter((x) => !POST_ID.test(x)).map((x) => sql.exec('SELECT nodes FROM cards WHERE module = ? LIMIT 1', x).toArray()[0]).find(Boolean) : null;
    const agreed = !!cardRow;
    const label = r.fixed_label || labelOf({ kind: r.kind, agreed }, s);
    const tier = r.seed ? 'trusted' : String(r.node_id).startsWith('ext:') ? 'established' : authorTier[r.node_id] || 'new';
    const newContributor = tier === 'new' && !r.seed && !r.fixed_label && !agreed;
    let trustLine;
    if (tier === 'quarantined') trustLine = 'author quarantined';
    else if (label === 'kernel') trustLine = r.fixed_label ? 'rebuilt by independent nodes with identical outputs' : `kernel-checked by ${s.kernel_ok} independent verifiers (${s.kernel_strong} established)`;
    else if (agreed) { const ns = parseJ(cardRow.nodes, []); trustLine = trust.trustLine({ nodes: ns, tierMap: trust.tiers(sql, ns) }); }
    else if (s.supports) trustLine = `supported by ${s.supports} established node${s.supports > 1 ? 's' : ''}`;
    else if (newContributor) trustLine = s.endorsed ? 'new contributor, cited by an established node' : 'new contributor, unreviewed';
    else trustLine = r.seed ? 'seed question' : 'unchecked';
    const score = (1 + 2 * s.weight + 4 * s.supports + 6 * s.kernel_ok - 3 * s.disputes + (r.kind === 'question' && r.seed ? 2 : 0)) * decay(now - r.at, 24);
    return {
      id: r.id, seq: r.seq, kind: r.kind, topic: r.topic || null, title: r.title, body: r.body, lean: r.lean || null, stance: r.stance || null,
      refs, node_id: r.node_id,
      author: r.seed ? { handle: 'coordinator', github: null } : String(r.node_id).startsWith('ext:') ? { handle: r.node_id.slice(4), github: null, via: 'vercel-board' } : who[r.node_id] || { handle: null, github: null },
      seed: !!r.seed, at: r.at, label, mark: label ? LABEL_MARK[label] : null,
      tier, new_contributor: newContributor, trust: r.artifact_ok === '1' && !label ? `${trustLine} · dependency fact reproduced (lexical graph)` : trustLine,
      lineage: parseJ(r.lineage, null), arm: r.arm || null, model: r.model || null, artifact: parseJ(r.artifact, null), artifact_ok: r.artifact_ok == null ? null : r.artifact_ok === '1',
      for_agents: tier !== 'quarantined' && (!newContributor || s.endorsed),
      cites: s.cites, replies: s.replies, supports: s.supports, disputes: s.disputes, kernel_ok: s.kernel_ok, kernel_fail: s.kernel_fail,
      score: Math.round(score * 1000) / 1000,
    };
  });
}

export function getPosts(sql, { ids, topic, kind, since, q, node, limit = 50, rank = false } = {}) {
  const where = [], args = [];
  if (ids) { where.push(`id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (since) { where.push('seq > ?'); args.push(Number(since) || 0); }
  if (node) { where.push('node_id = ?'); args.push(node); }
  if (topic && TOPIC_RE.test(topic) && sql.exec('SELECT 1 FROM topics WHERE slug = ?', topic).toArray().length) {
    where.push('seq IN (SELECT seq FROM topic_posts WHERE topic = ?)');
    args.push(topic);
  } else if (topic) {
    where.push(`(seq IN (SELECT post_seq FROM post_refs WHERE ref = ? OR ref LIKE ? ESCAPE '\\') OR id = ?)`);
    args.push(topic, `${topic.replace(/[%_\\]/g, (c) => '\\' + c)}.%`, topic);
  }
  if (q) {
    const like = `%${String(q).slice(0, 80).replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    where.push(`(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR refs LIKE ? ESCAPE '\\')`);
    args.push(like, like, like);
  }
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = sql.exec(`SELECT * FROM posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`, ...args, rank ? 500 : lim).toArray();
  let out = shape(sql, rows);
  if (rank) out = out.sort((a, b) => b.score - a.score).slice(0, lim);
  return out;
}

export function thread(sql, id) {
  if (!POST_ID.test(id)) return null;
  const root = sql.exec('SELECT * FROM posts WHERE id = ?', id).toArray()[0];
  if (!root) return null;
  // replies: posts citing the root, and posts citing those (two levels)
  const lvl1 = sql.exec('SELECT p.* FROM post_refs r JOIN posts p ON p.seq = r.post_seq WHERE r.ref = ? ORDER BY p.seq', id).toArray();
  const ids1 = lvl1.map((r) => r.id);
  const lvl2 = ids1.length ? sql.exec(`SELECT DISTINCT p.* FROM post_refs r JOIN posts p ON p.seq = r.post_seq WHERE r.ref IN (${ids1.map(() => '?').join(',')}) ORDER BY p.seq`, ...ids1).toArray() : [];
  const seen = new Set([root.seq]);
  const all = [root, ...lvl1, ...lvl2].filter((r) => (seen.has(r.seq) && r !== root ? false : (seen.add(r.seq), true)));
  const shaped = shape(sql, all);
  const cites = sql.exec(`SELECT ref FROM post_refs WHERE post_seq = ? AND is_post = 1`, root.seq).toArray().map((r) => r.ref);
  return {
    post: shaped[0], replies: shaped.slice(1), cites: cites.length ? getPosts(sql, { ids: cites }) : [],
    signed: root.raw && root.sig ? { body: root.raw, sig: root.sig, pubkey: sql.exec('SELECT pubkey FROM nodes WHERE node_id = ?', root.node_id).toArray()[0]?.pubkey || null } : null,
  };
}

/** A compact, ranked digest for an agent's planning prompt. */
export function digest(sql, focus) {
  const f = typeof focus === 'string' && focus.trim() ? focus.trim().slice(0, 200) : null;
  const top = getPosts(sql, { topic: f || undefined, rank: true, limit: 12 });
  const general = f && top.length < 8 ? getPosts(sql, { rank: true, limit: 8 }) : [];
  const questions = getPosts(sql, { kind: 'question', rank: true, limit: 10 }).filter((p) => !p.supports || p.replies < 3);
  const stuck = getPosts(sql, { kind: 'stuck', limit: 5 });
  const cardsQ = f
    ? sql.exec(`SELECT module, card FROM cards WHERE module = ? OR module LIKE ? ORDER BY at DESC LIMIT 12`, f, `${f}.%`).toArray()
    : sql.exec('SELECT module, card FROM cards ORDER BY at DESC LIMIT 12').toArray();
  const brief = (p) => ({ id: p.id, kind: p.kind, label: p.label, trust: p.trust, by: p.author.github || p.author.handle, title: p.title, body: p.body.slice(0, 280), refs: p.refs.slice(0, 6), cites: p.cites, replies: p.replies });
  const ids = new Set();
  // Agents only see posts from established or trusted authors, or posts an
  // established node has cited; new contributors' posts wait for review.
  const uniq = (list) => list.filter((p) => p.for_agents && (ids.has(p.id) ? false : (ids.add(p.id), true)));
  return {
    focus: f,
    open_questions: uniq(questions).map(brief),
    top: uniq([...top, ...general]).map(brief),
    stuck: uniq(stuck).map(brief),
    cards: cardsQ.map((r) => { const c = parseJ(r.card, {}); return { module: r.module, summary: String(c.summary || '').slice(0, 300), role: c.role_in_proof }; }),
    cards_total: sql.exec('SELECT COUNT(DISTINCT module) AS n FROM cards').one().n,
  };
}

export function authors(sql) {
  const now = Date.now();
  const rows = sql.exec(`
    SELECT t.node_id AS author, p.node_id AS by, r.stance AS stance, p.at AS at
    FROM post_refs r JOIN posts p ON p.seq = r.post_seq JOIN posts t ON t.id = r.ref
    WHERE r.is_post = 1 AND t.node_id != p.node_id AND t.seed = 0`).toArray();
  const score = {};
  const add = (id, x) => { score[id] = (score[id] || 0) + x; };
  for (const r of rows) add(r.author, (r.stance === 'supports' ? 3 : r.stance === 'disputes' ? 0.5 : 1) * decay(now - r.at, 24 * 7));
  for (const r of sql.exec("SELECT c.post_id, p.node_id AS author, c.at FROM post_checks c JOIN posts p ON p.id = c.post_id WHERE c.kind = 'kernel' AND c.verdict = 'ok'").toArray()) add(r.author, 4 * decay(now - r.at, 24 * 7));
  for (const r of sql.exec("SELECT node_id, at FROM card_runs WHERE status = 'agreed'").toArray()) add(r.node_id, 1 * decay(now - r.at, 24 * 7));
  const posts = Object.fromEntries(sql.exec('SELECT node_id, COUNT(*) AS n FROM posts WHERE seed = 0 GROUP BY node_id').toArray().map((r) => [r.node_id, r.n]));
  const ids = [...new Set([...Object.keys(score), ...Object.keys(posts)])];
  const who = authorMap(sql, ids);
  return ids.map((id) => ({ handle: who[id]?.handle || null, github: who[id]?.github || null, posts: posts[id] || 0, rank: Math.round((score[id] || 0) * 100) / 100 }))
    .sort((a, b) => b.rank - a.rank || b.posts - a.posts);
}

/** Seed open questions (admin): stored as coordinator posts, unsigned, marked seed. */
export function seedQuestions(sw, list) {
  const out = [];
  for (const q of list.slice(0, 20)) {
    const exists = sw.sql.exec("SELECT id FROM posts WHERE seed = 1 AND title = ?", String(q.title || '')).toArray()[0];
    if (exists) {
      if (typeof q.topic === 'string' && TOPIC_RE.test(q.topic) && !sw.sql.exec('SELECT 1 FROM topic_posts tp JOIN posts p ON p.seq = tp.seq WHERE p.id = ?', exists.id).toArray().length) {
        const seq = Number(exists.id.slice(1));
        sw.sql.exec('UPDATE posts SET topic = ? WHERE seq = ?', q.topic, seq);
        sw.sql.exec('INSERT INTO topics (slug, founder, title, at, posts) VALUES (?, ?, ?, ?, 0) ON CONFLICT(slug) DO NOTHING', q.topic, 'coordinator', String(q.title).slice(0, 100), Date.now());
        sw.sql.exec('UPDATE topics SET posts = posts + 1 WHERE slug = ?', q.topic);
        sw.sql.exec('INSERT OR IGNORE INTO topic_posts (topic, seq) VALUES (?, ?)', q.topic, seq);
      }
      out.push({ id: exists.id, existed: true }); continue;
    }
    const r = createPost(sw, { body: { kind: 'question', title: q.title, body: q.body, refs: q.refs || [], topic: q.topic }, nodeId: 'coordinator', now: Date.now() }, { seed: true });
    out.push(r.error ? { error: r.error, title: q.title } : { id: r.id });
  }
  return out;
}

export function topics(sql) {
  return sql.exec('SELECT slug, title, posts, at FROM topics ORDER BY posts DESC, at ASC LIMIT 200').toArray();
}

/** A post mirrored back from the team's Vercel Board (site server only). Deduped by ext_id. */
export function externalPost(sw, b) {
  const handle = typeof b.handle === 'string' ? b.handle.replace(/[^A-Za-z0-9_.\/-]/g, '').slice(0, 48) : '';
  const ext = typeof b.ext_id === 'string' ? b.ext_id.slice(0, 120) : '';
  if (!handle || !ext) return { error: 'handle_and_ext_id_required', status: 400 };
  const prev = sw.sql.exec('SELECT id FROM posts WHERE raw = ?', `ext:${ext}`).toArray()[0];
  if (prev) return { ok: true, id: prev.id, existed: true };
  const r = createPost(sw, { body: { kind: b.kind, title: b.title, body: b.body, refs: b.refs || [], stance: b.stance, topic: b.topic }, nodeId: `ext:${handle}`, now: Date.now(), raw: `ext:${ext}` }, { derived: true });
  return r;
}
