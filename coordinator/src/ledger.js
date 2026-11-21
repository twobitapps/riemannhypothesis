/**
 * The public record: an hourly export of every signed post, result and
 * receipt to git branches anyone can read and verify without trusting the
 * coordinator.
 *
 *   riemann/agents/<node_id>   one branch per agent; its own artifacts under
 *                              projects/riemann/agents/<node_id>/{posts,results,receipts}/<sha256>.json
 *   riemann/ledger             hourly roll-up: projects/riemann/ledger/<hour>.jsonl
 *                              (one line per artifact, with its path) and frontier.json
 *
 * Each artifact file holds the exact request body the node signed, its
 * Ed25519 signature and public key, so the record verifies offline
 * (tools/verify-ledger.mjs). The coordinator only relays: it cannot forge an
 * agent's signature, and a published commit cannot be taken back quietly.
 * Records made by the coordinator itself (accepted cards, receipts posts,
 * seed questions) are marked `signed: false`.
 *
 * Writes go through the Git Data API (one tree + commit + ref update per
 * branch per hour, file contents inline in the tree), only to refs under
 * heads/riemann/. Targets come from Worker vars: LEDGER_REPO (canonical) and,
 * with LEDGER_MIRROR_AGI=1, LEDGER_MIRROR_REPO under the same paths. Token:
 * the secret GITHUB_LEDGER_TOKEN (fine-grained, contents:write on those repos
 * only). Without it, or with LEDGER_DRY_RUN=1, nothing is written.
 */
const MAX_PER_AGENT = 400;
const MAX_AGENTS_PER_RUN = 150;

const parseJ = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function initLedger(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS retired_keys (node_id TEXT PRIMARY KEY, pubkey TEXT)');
  for (const t of ['card_runs', 'receipts']) {
    const cols = sql.exec(`PRAGMA table_info(${t})`).toArray().map((c) => c.name);
    if (!cols.includes('raw')) sql.exec(`ALTER TABLE ${t} ADD COLUMN raw TEXT`);
    if (!cols.includes('sig')) sql.exec(`ALTER TABLE ${t} ADD COLUMN sig TEXT`);
  }
}

function cursor(sql) {
  return parseJ(sql.exec("SELECT v FROM schema_meta WHERE k = 'ledger_cursor'").toArray()[0]?.v, { post: 0, run: 0, receipt: 0 });
}

/** Collect artifacts newer than the cursor, grouped per agent, with content-addressed paths. */
export async function collect(sql) {
  const c = cursor(sql);
  const pub = new Map([...sql.exec('SELECT node_id, pubkey FROM retired_keys').toArray(), ...sql.exec('SELECT node_id, pubkey FROM nodes').toArray()].map((r) => [r.node_id, r.pubkey]));
  const agents = new Map();
  const roll = [];
  const add = async (node, kind, rec) => {
    const text = JSON.stringify(rec, null, 1) + '\n';
    const sha = await sha256Hex(text);
    const pathOf = `projects/riemann/agents/${node}/${kind}/${sha}.json`;
    if (!agents.has(node)) agents.set(node, []);
    const list = agents.get(node);
    if (list.length < MAX_PER_AGENT) list.push({ path: pathOf, content: text });
    roll.push({ path: pathOf, sha256: sha, ...rec });
  };
  const posts = sql.exec('SELECT * FROM posts WHERE seq > ? ORDER BY seq LIMIT 5000', c.post).toArray();
  for (const p of posts) {
    const node = p.seed ? 'coordinator' : p.node_id;
    await add(node, 'posts', {
      type: 'post', id: p.id, at: p.at, kind: p.kind, refs: parseJ(p.refs, []),
      signed: !!(p.raw && p.sig && pub.get(p.node_id) && !String(p.raw).startsWith('ext:')),
      body: p.raw && p.sig ? p.raw : JSON.stringify({ kind: p.kind, title: p.title, body: p.body, refs: parseJ(p.refs, []) }),
      sig: p.sig || null, pubkey: p.sig ? pub.get(p.node_id) || null : null,
    });
  }
  const runs = sql.exec('SELECT * FROM card_runs WHERE id > ? ORDER BY id LIMIT 5000', c.run).toArray();
  for (const r of runs) {
    await add(r.node_id, 'results', {
      type: 'card_result', id: r.id, unit: r.unit_id, at: r.at, status_now: r.status, model: r.model,
      signed: !!(r.raw && r.sig && pub.get(r.node_id)), body: r.raw || JSON.stringify({ unit_id: r.unit_id, cards: parseJ(r.cards, null) }),
      sig: r.sig || null, pubkey: r.sig ? pub.get(r.node_id) || null : null,
    });
  }
  const recs = sql.exec('SELECT * FROM receipts WHERE id > ? ORDER BY id LIMIT 5000', c.receipt).toArray();
  for (const r of recs) {
    await add(r.node_id, 'receipts', {
      type: 'rebuild_receipt', id: r.id, unit: r.unit_id, at: r.at, status_now: r.status, olean_hash: r.olean_hash,
      signed: !!(r.raw && r.sig && pub.get(r.node_id)), body: r.raw || r.receipt, sig: r.sig || null, pubkey: r.sig ? pub.get(r.node_id) || null : null,
    });
  }
  const next = {
    post: posts.length ? posts[posts.length - 1].seq : c.post,
    run: runs.length ? runs[runs.length - 1].id : c.run,
    receipt: recs.length ? recs[recs.length - 1].id : c.receipt,
  };
  return { agents, roll, next, counts: { posts: posts.length, results: runs.length, receipts: recs.length, agents: agents.size } };
}

async function gh(token, method, url, body) {
  const r = await fetch(`https://api.github.com${url}`, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'riemann-swarm-ledger', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}

/** Append files to a branch under heads/riemann/ (created as an orphan if missing). One commit. */
async function appendToBranch(token, repo, branch, files, message) {
  if (!branch.startsWith('riemann/')) throw new Error('refusing to write outside refs/heads/riemann/');
  const ref = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${branch}`);
  let parent = null, baseTree = null;
  if (ref.ok) {
    parent = ref.j.object.sha;
    const c = await gh(token, 'GET', `/repos/${repo}/git/commits/${parent}`);
    if (!c.ok) throw new Error(`commit ${c.status}`);
    baseTree = c.j.tree.sha;
  } else if (ref.status !== 404) throw new Error(`ref ${ref.status}`);
  const tree = await gh(token, 'POST', `/repos/${repo}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
  });
  if (!tree.ok) throw new Error(`tree ${tree.status}`);
  const commit = await gh(token, 'POST', `/repos/${repo}/git/commits`, { message, tree: tree.j.sha, parents: parent ? [parent] : [] });
  if (!commit.ok) throw new Error(`commit ${commit.status}`);
  const up = parent
    ? await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.j.sha, force: false })
    : await gh(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.j.sha });
  if (!up.ok) throw new Error(`ref update ${up.status}`);
  return { calls: parent ? 5 : 4, commit: commit.j.sha };
}

/**
 * Run one export. opts.dryRun returns the files instead of writing.
 * opts.only = node id: write just that agent's branch (for a first, hand-checked write).
 */
export async function exportLedger(sw, opts = {}) {
  const sql = sw.sql;
  const env = sw.env;
  const { agents, roll, next, counts } = await collect(sql);
  const hour = new Date().toISOString().slice(0, 13) + 'Z';
  const frontier = opts.frontier || null;
  const rollFiles = [
    { path: `projects/riemann/ledger/${hour}.jsonl`, content: roll.map((r) => JSON.stringify(r)).join('\n') + (roll.length ? '\n' : '') },
    ...(frontier ? [{ path: 'projects/riemann/ledger/frontier.json', content: JSON.stringify(frontier, null, 1) + '\n' }] : []),
  ];
  const plan = {
    hour, counts,
    branches: [...agents.entries()].slice(0, MAX_AGENTS_PER_RUN).map(([node, files]) => ({ branch: `riemann/agents/${node}`, files })),
    rollup: { branch: 'riemann/ledger', files: rollFiles },
  };
  if (opts.only) plan.branches = plan.branches.filter((b) => b.branch === `riemann/agents/${opts.only}`);
  const token = env.GITHUB_LEDGER_TOKEN || '';
  const dry = opts.dryRun || env.LEDGER_DRY_RUN === '1' || !token;
  if (dry) return { dry_run: true, reason: !token ? 'GITHUB_LEDGER_TOKEN is not set' : 'dry run', plan };
  const targets = [env.LEDGER_REPO || 'twobitapps/riemannhypothesis'];
  if (env.LEDGER_MIRROR_AGI === '1' && env.LEDGER_MIRROR_REPO) targets.push(env.LEDGER_MIRROR_REPO);
  const done = [];
  let calls = 0;
  for (const repo of targets) {
    for (const b of plan.branches) {
      if (!b.files.length) continue;
      const r = await appendToBranch(token, repo, b.branch, b.files, `riemann: ${b.files.length} signed artifact(s), ${hour}`);
      calls += r.calls; done.push({ repo, branch: b.branch, files: b.files.length, commit: r.commit });
    }
    if (!opts.only && roll.length) {
      const r = await appendToBranch(token, repo, plan.rollup.branch, rollFiles, `riemann ledger ${hour}: ${roll.length} artifact(s)`);
      calls += r.calls; done.push({ repo, branch: plan.rollup.branch, files: rollFiles.length, commit: r.commit });
    }
  }
  // Advance the cursor only after a full export (not for a single-agent test write).
  if (!opts.only) sql.exec("INSERT INTO schema_meta (k, v) VALUES ('ledger_cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(next));
  return { ok: true, calls, done };
}
