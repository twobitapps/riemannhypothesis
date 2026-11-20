/**
 * Semantic recall for "read before work": the most relevant earlier posts and
 * cards for a module or a question.
 *
 * Workers AI embeds text (@cf/baai/bge-small-en-v1.5, 384 dims) into the
 * Vectorize index `riemann-recall`. Every call is best-effort: indexing runs in
 * the background, and when AI or Vectorize is unavailable recall falls back to
 * SQLite keyword search over posts and cards. The response says which ran.
 */
const MODEL = '@cf/baai/bge-small-en-v1.5';

async function idFor(prefix, key) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return prefix + [...new Uint8Array(d)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function embed(env, texts) {
  const r = await env.AI.run(MODEL, { text: texts.map((t) => String(t).slice(0, 2000)) });
  return r?.data || null;
}

export async function indexPost(env, post) {
  if (!env.AI || !env.VECTORIZE) return false;
  const text = `${post.kind}: ${post.title}\n${post.body}\n${(post.refs || []).join(' ')}`;
  const [v] = (await embed(env, [text])) || [];
  if (!v) return false;
  await env.VECTORIZE.upsert([{ id: await idFor('p', post.id), values: v, metadata: { type: 'post', ref: post.id } }]);
  return true;
}

export async function indexCard(env, key, module, card) {
  if (!env.AI || !env.VECTORIZE) return false;
  const st = (card.statements || []).slice(0, 6).map((s) => `${s.lean_name}: ${s.latex}`).join('\n');
  const text = `${module}\n${card.summary}\n${card.role_in_proof}\n${st}`;
  const [v] = (await embed(env, [text])) || [];
  if (!v) return false;
  await env.VECTORIZE.upsert([{ id: await idFor('c', key), values: v, metadata: { type: 'card', ref: key } }]);
  return true;
}

const parseJ = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

function keyword(sql, q, k) {
  const terms = String(q).toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
  const uniq = [...new Set(terms)].slice(0, 6);
  if (!uniq.length) return [];
  const esc = (t) => `%${t.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  const scoreOf = (text) => uniq.reduce((s, t) => s + (text.toLowerCase().includes(t) ? 1 : 0), 0);
  const posts = sql.exec(`SELECT id, kind, title, body FROM posts WHERE ${uniq.map(() => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')").join(' OR ')} ORDER BY seq DESC LIMIT 100`,
    ...uniq.flatMap((t) => [esc(t), esc(t)])).toArray()
    .map((p) => ({ type: 'post', ref: p.id, kind: p.kind, title: p.title, text: p.body.slice(0, 280), score: scoreOf(p.title + ' ' + p.body) }));
  const cards = sql.exec(`SELECT key, module, card FROM cards WHERE ${uniq.map(() => "(module LIKE ? ESCAPE '\\' OR card LIKE ? ESCAPE '\\')").join(' OR ')} ORDER BY at DESC LIMIT 100`,
    ...uniq.flatMap((t) => [esc(t), esc(t)])).toArray()
    .map((c) => { const x = parseJ(c.card, {}); return { type: 'card', ref: c.key, module: c.module, text: String(x.summary || '').slice(0, 280), score: scoreOf(c.module + ' ' + c.card) }; });
  return [...posts, ...cards].sort((a, b) => b.score - a.score).slice(0, k);
}

/** Top-k earlier posts and cards for a query. Returns { method, hits }. */
export async function recall(env, sql, q, k = 8) {
  q = String(q || '').trim().slice(0, 500);
  if (q.length < 3) return { method: 'none', hits: [] };
  if (env.AI && env.VECTORIZE) {
    try {
      const [v] = (await embed(env, [q])) || [];
      if (v) {
        const r = await env.VECTORIZE.query(v, { topK: Math.min(20, k), returnMetadata: 'all' });
        const hits = [];
        for (const m of r.matches || []) {
          const ref = m.metadata?.ref;
          if (m.metadata?.type === 'post') {
            const p = sql.exec('SELECT id, kind, title, body FROM posts WHERE id = ?', ref).toArray()[0];
            if (p) hits.push({ type: 'post', ref: p.id, kind: p.kind, title: p.title, text: p.body.slice(0, 280), score: Math.round(m.score * 1000) / 1000 });
          } else if (m.metadata?.type === 'card') {
            const c = sql.exec('SELECT key, module, card FROM cards WHERE key = ?', ref).toArray()[0];
            if (c) hits.push({ type: 'card', ref: c.key, module: c.module, text: String(parseJ(c.card, {}).summary || '').slice(0, 280), score: Math.round(m.score * 1000) / 1000 });
          }
        }
        return { method: 'vectorize', hits };
      }
    } catch { /* fall through to keyword search */ }
  }
  return { method: 'keyword', hits: keyword(sql, q, k) };
}
