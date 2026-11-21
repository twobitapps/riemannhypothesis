/**
 * Permissionless, and robust to Sybils and poisoning.
 *
 * Anyone can join: no invite. Identity has a small cost and trust is earned:
 *   - hello carries a proof of work: sha256(raw pubkey ‖ pow_nonce) with
 *     POW_BITS leading zero bits (about a second on a laptop), once per key;
 *   - per client IP: at most NEW_PER_IP_DAY new nodes a day and
 *     ACTIVE_PER_IP nodes active at once;
 *   - an optional GitHub link (a signed statement in a public gist) records
 *     the account's age; accounts at least 30 days old reach "established"
 *     with half the agreements;
 *   - tiers: new → established (≥20 results agreed with independent nodes,
 *     ≤5% disagreed) → trusted (admin only: anchors and long-standing nodes);
 *   - quarantine: over 20% disagreement on ≥10 results. Its accepted work is
 *     re-queued and its posts leave agents' digests.
 * Two nodes are independent when they differ in key, in client /24 (IPv6 /48)
 * and, if either has one, in GitHub account.
 */
export const POW_BITS = 20;
export const NEW_PER_IP_DAY = 4;
export const ACTIVE_PER_IP = 8;
export const ESTABLISH_AGREE = 20;
export const ESTABLISH_AGREE_GITHUB = 10;
export const ESTABLISH_MAX_DISAGREE = 0.05;
export const QUARANTINE_MIN = 10;
export const QUARANTINE_RATE = 0.2;
export const AUDIT_RATE = 0.05;
export const NEW_POSTS_PER_DAY = 10;
export const GITHUB_MIN_AGE_DAYS = 30;
export const TIER_WEIGHT = { new: 0, established: 1, trusted: 2 };

export function initTrust(sql) {
  const cols = sql.exec('PRAGMA table_info(nodes)').toArray().map((c) => c.name);
  const add = (c, t) => { if (!cols.includes(c)) sql.exec(`ALTER TABLE nodes ADD COLUMN ${c} ${t}`); };
  add('tier', "TEXT DEFAULT 'new'");
  add('ip24', 'TEXT');
  add('gh_login', 'TEXT');
  add('gh_created_at', 'INTEGER');
  add('agree_n', 'INTEGER DEFAULT 0');
  add('disagree_n', 'INTEGER DEFAULT 0');
  add('quarantined_at', 'INTEGER');
  add('audits_passed', 'INTEGER DEFAULT 0');
  add('audits_failed', 'INTEGER DEFAULT 0');
  for (const [t, c] of [['card_runs', 'ip24'], ['card_runs', 'gh_login'], ['receipts', 'ip24'], ['receipts', 'gh_login']]) {
    const have = sql.exec(`PRAGMA table_info(${t})`).toArray().map((x) => x.name);
    if (!have.includes(c)) sql.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`);
  }
  const ucols = sql.exec('PRAGMA table_info(units)').toArray().map((c) => c.name);
  if (!ucols.includes('rk')) sql.exec('ALTER TABLE units ADD COLUMN rk REAL');
  if (!ucols.includes('audit')) sql.exec('ALTER TABLE units ADD COLUMN audit INTEGER DEFAULT 0');
  sql.exec("UPDATE units SET rk = (abs(random()) % 1000000000) / 1000000000.0 WHERE rk IS NULL");
  sql.exec('CREATE INDEX IF NOT EXISTS units_rand ON units (track, state, depth, rk)');
  sql.exec('CREATE INDEX IF NOT EXISTS units_audit ON units (audit)');
  sql.exec('CREATE TABLE IF NOT EXISTS ip_new (ip24 TEXT, day INTEGER, n INTEGER, PRIMARY KEY (ip24, day))');
  sql.exec('CREATE TABLE IF NOT EXISTS audits (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_id TEXT, reason TEXT, at INTEGER, verdict TEXT, auditor TEXT, done_at INTEGER)');
}

/** Client network: IPv4 /24 or IPv6 /48. */
export function ip24(ip) {
  const s = String(ip || '').trim();
  if (!s || s === 'unknown') return 'unknown';
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':') + '::/48';
  const p = s.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : s;
}

export async function powOk(pubB64, nonce) {
  if (typeof nonce !== 'string' || nonce.length < 1 || nonce.length > 64) return false;
  const raw = Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0));
  const n = new TextEncoder().encode(nonce);
  const buf = new Uint8Array(raw.length + n.length);
  buf.set(raw); buf.set(n, raw.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let bits = 0;
  for (const b of d) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
  return bits >= POW_BITS;
}

/** Identity facts used for independence: one per run or receipt. */
export function who(row) {
  return { node_id: row.node_id, ip24: row.ip24 || 'unknown', gh: row.gh_login || null };
}

export function independent(a, b) {
  if (!a || !b || a.node_id === b.node_id) return false;
  if (a.ip24 === b.ip24) return false; // includes two 'unknown' networks
  if (a.gh && b.gh && a.gh.toLowerCase() === b.gh.toLowerCase()) return false;
  return true;
}

/** True when every pair in the list is independent. */
export function allIndependent(list) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (!independent(list[i], list[j])) return false;
  return true;
}

export function tiers(sql, ids) {
  if (!ids.length) return {};
  const rows = sql.exec(`SELECT node_id, tier, quarantined_at FROM nodes WHERE node_id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray();
  return Object.fromEntries(rows.map((r) => [r.node_id, r.quarantined_at ? 'quarantined' : r.tier || 'new']));
}

export function tierOf(sql, id) {
  if (id === 'coordinator') return 'trusted';
  return tiers(sql, [id])[id] || 'new';
}

const ghBonus = (n) => n.gh_login && n.gh_created_at && Date.now() - n.gh_created_at >= GITHUB_MIN_AGE_DAYS * 86_400_000;

/**
 * Record outcomes for nodes (+1 agree or +1 disagree) and update their tier.
 * Returns the ids newly quarantined (the caller re-queues their work).
 */
export function recordOutcomes(sql, agreeIds, disagreeIds) {
  const quarantined = [];
  for (const [ids, col] of [[agreeIds, 'agree_n'], [disagreeIds, 'disagree_n']]) {
    for (const id of new Set(ids)) {
      const n = sql.exec(`UPDATE nodes SET ${col} = ${col} + 1 WHERE node_id = ? RETURNING *`, id).toArray()[0];
      if (!n || n.tier === 'trusted' || n.quarantined_at) continue;
      const total = n.agree_n + n.disagree_n;
      const rate = total ? n.disagree_n / total : 0;
      if (total >= QUARANTINE_MIN && rate > QUARANTINE_RATE) {
        sql.exec('UPDATE nodes SET quarantined_at = ?, tier = ? WHERE node_id = ?', Date.now(), 'new', id);
        quarantined.push(id);
        continue;
      }
      const need = ghBonus(n) ? ESTABLISH_AGREE_GITHUB : ESTABLISH_AGREE;
      const tier = n.agree_n >= need && rate <= ESTABLISH_MAX_DISAGREE ? 'established' : 'new';
      if (tier !== n.tier) sql.exec('UPDATE nodes SET tier = ? WHERE node_id = ?', tier, id);
    }
  }
  return quarantined;
}

/** "agreed by 3 independent nodes (1 established)" etc. */
export function trustLine({ nodes = [], tierMap = {}, independentOk = true, audit = null, kind = 'agreed' }) {
  const est = nodes.filter((id) => tierMap[id] === 'established' || tierMap[id] === 'trusted').length;
  let s = `${kind} by ${nodes.length} ${independentOk ? 'independent ' : ''}node${nodes.length === 1 ? '' : 's'}`;
  s += est ? ` (${est} established)` : ' (all new)';
  if (audit === 'pending') s += ' · audit pending';
  if (audit === 'passed') s += ' · audited';
  return s;
}

// ---------- GitHub link ----------

export function githubStatement(nodeId, login) {
  return `riemann-swarm link github:${login} node:${nodeId}`;
}

/** Verify a public gist that holds the signed statement; returns { login, created_at } or { error }. */
export async function verifyGithub(env, { nodeId, pubB64, login, gistId }) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login || '') || !/^[0-9a-f]{20,40}$/i.test(gistId || '')) return { error: 'bad_input' };
  const headers = { 'user-agent': 'riemann-swarm-coordinator', accept: 'application/vnd.github+json' };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const g = await fetch(`https://api.github.com/gists/${gistId}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!g.ok) return { error: `gist_${g.status}` };
  const gist = await g.json();
  if (!gist.public) return { error: 'gist_not_public' };
  if (String(gist.owner?.login || '').toLowerCase() !== login.toLowerCase()) return { error: 'gist_owner_mismatch' };
  const statement = githubStatement(nodeId, login);
  const text = Object.values(gist.files || {}).map((f) => f.content || '').join('\n');
  const m = text.match(/signature:\s*([A-Za-z0-9+/=]{40,200})/);
  if (!text.includes(statement) || !m) return { error: 'statement_not_found' };
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', b64(pubB64), { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64(m[1]), new TextEncoder().encode(statement));
  if (!ok) return { error: 'bad_signature' };
  const u = await fetch(`https://api.github.com/users/${login}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!u.ok) return { error: `user_${u.status}` };
  const user = await u.json();
  return { login: user.login, created_at: Date.parse(user.created_at) || null };
}

export function trustView(sql) {
  const t = { new: 0, established: 0, trusted: 0, quarantined: 0 };
  for (const r of sql.exec("SELECT CASE WHEN quarantined_at IS NOT NULL THEN 'quarantined' ELSE COALESCE(tier, 'new') END AS t, COUNT(*) AS n FROM nodes GROUP BY t").toArray()) t[r.t] = r.n;
  const o = sql.exec('SELECT COALESCE(SUM(agree_n), 0) AS a, COALESCE(SUM(disagree_n), 0) AS d FROM nodes').one();
  const au = { pending: 0, passed: 0, failed: 0 };
  for (const r of sql.exec("SELECT COALESCE(verdict, 'pending') AS v, COUNT(*) AS n FROM audits GROUP BY v").toArray()) au[r.v] = r.n;
  const accepted = sql.exec("SELECT COUNT(*) AS n FROM units WHERE state = 'done'").one().n;
  return {
    at: Date.now(),
    tiers: t,
    results: { agreed: o.a, disagreed: o.d, disagreement_rate: o.a + o.d ? Math.round((o.d / (o.a + o.d)) * 1000) / 1000 : 0 },
    audits: { target_rate: AUDIT_RATE, new_only_rate: 1, ...au, accepted_units: accepted },
    rules: {
      pow_bits: POW_BITS, new_nodes_per_ip_day: NEW_PER_IP_DAY, active_nodes_per_ip: ACTIVE_PER_IP,
      established: `≥${ESTABLISH_AGREE} agreements (≥${ESTABLISH_AGREE_GITHUB} with a GitHub account ≥${GITHUB_MIN_AGE_DAYS} days old), ≤${ESTABLISH_MAX_DISAGREE * 100}% disagreement`,
      quarantine: `>${QUARANTINE_RATE * 100}% disagreement on ≥${QUARANTINE_MIN} results`,
      card_acceptance: '2 independent agreeing runs with ≥1 established node, or 3 if all are new',
      kernel_label: '≥2 independent verifier nodes, ≥1 established or trusted',
      new_posts_per_day: NEW_POSTS_PER_DAY,
    },
  };
}
