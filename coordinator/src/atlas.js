/**
 * Track A — the atlas: a checked English map of Alpöge's Lean proof.
 *
 * Storage (Durable Object SQLite; R2 is not used):
 *   src_packs      sources as concatenated gzip members (~0.9 MB per row), so
 *                  175k modules cost ~300 rows; one module = substr(data, off, len)
 *   atlas_modules  one row per module: depth, area, size, sha256, pack slot,
 *                  parsed declarations and the statements a card must cover
 *   atlas_meta     per-depth and per-area totals for the whole cone
 *   card_runs      every lane result for a card unit (valid or not)
 *   cards          accepted cards: two valid runs from different nodes that
 *                  name the same Lean declarations ("two-run agreement")
 *
 * Unit payload (lease response): module name(s), source (<=200 KB), its
 * sha256, the statements to cover, and the accepted cards of the unit's direct
 * project imports (summary + role only).
 */

import * as trust from './trust.js';

export const CARD_LIMITS = {
  summary_words: 120, summary_chars: 1200,
  role_words: 40, role_chars: 400,
  statements: 40, lean_name: 200, latex: 1500,
};
const LEASES_PER_CARD_UNIT = 2;
const RUNS_TO_ACCEPT = 2;
const MAX_CARD_ATTEMPTS = 6;
const IMPORT_CARDS_MAX = 40;

const parseJ = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

export function initAtlas(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS src_packs (id INTEGER PRIMARY KEY, data BLOB NOT NULL, bytes INTEGER);
    CREATE TABLE IF NOT EXISTS atlas_modules (
      name TEXT PRIMARY KEY, depth INTEGER, area TEXT, lines INTEGER, bytes INTEGER, sha TEXT,
      pack INTEGER, off INTEGER, len INTEGER, imports TEXT, decls TEXT, expect TEXT);
    CREATE INDEX IF NOT EXISTS atlas_modules_sha ON atlas_modules (sha);
    CREATE INDEX IF NOT EXISTS atlas_modules_depth ON atlas_modules (depth);
    CREATE TABLE IF NOT EXISTS atlas_meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS card_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, unit_id TEXT, node_id TEXT, lease_id TEXT, at INTEGER,
      status TEXT, reason TEXT, names TEXT, cards TEXT, vendor TEXT, model TEXT, lane_ms INTEGER);
    CREATE INDEX IF NOT EXISTS card_runs_unit ON card_runs (unit_id);
    CREATE TABLE IF NOT EXISTS cards (
      key TEXT PRIMARY KEY, module TEXT, unit_id TEXT, depth INTEGER, area TEXT, part TEXT,
      card TEXT, second TEXT, nodes TEXT, label TEXT, at INTEGER);
    CREATE INDEX IF NOT EXISTS cards_module ON cards (module);
    CREATE INDEX IF NOT EXISTS cards_at ON cards (at);
    CREATE TABLE IF NOT EXISTS unit_modules (module TEXT, unit_id TEXT, PRIMARY KEY (module, unit_id)) WITHOUT ROWID;
  `);
  const cols = sql.exec('PRAGMA table_info(units)').toArray().map((c) => c.name);
  if (!cols.includes('depth')) sql.exec('ALTER TABLE units ADD COLUMN depth INTEGER');
  if (!cols.includes('area')) sql.exec('ALTER TABLE units ADD COLUMN area TEXT');
  if (!cols.includes('payload')) sql.exec('ALTER TABLE units ADD COLUMN payload TEXT');
  sql.exec('CREATE INDEX IF NOT EXISTS units_pick ON units (track, state, depth)');
  sql.exec('CREATE INDEX IF NOT EXISTS units_next ON units (track, state, depth, id)');
  if (!sql.exec('SELECT 1 FROM unit_modules LIMIT 1').toArray().length) {
    for (const u of sql.exec("SELECT id, payload FROM units WHERE track = 'A' AND kind = 'card' AND payload IS NOT NULL").toArray()) {
      for (const m of parseJ(u.payload, {}).modules || []) sql.exec('INSERT OR IGNORE INTO unit_modules (module, unit_id) VALUES (?, ?)', m.name, u.id);
    }
  }
}

export function indexUnitModules(sql, id, payload) {
  for (const m of parseJ(payload, {}).modules || []) sql.exec('INSERT OR IGNORE INTO unit_modules (module, unit_id) VALUES (?, ?)', m.name, id);
}

// ---------- admin loading ----------

export async function adminPack(sql, req, url) {
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id < 0 || id > 100000) return { error: 'bad_id', status: 400 };
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length || buf.length > 1_900_000) return { error: 'bad_size', status: 413 };
  sql.exec('INSERT INTO src_packs (id, data, bytes) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, bytes = excluded.bytes', id, buf, buf.length);
  return { ok: true, id, bytes: buf.length };
}

const MOD_RE = /^[\p{L}\p{N}_'.!?«»₀-₉]{1,300}$/u;

export async function adminModules(sql, req) {
  const body = await req.json().catch(() => null);
  const list = Array.isArray(body?.modules) ? body.modules.slice(0, 5000) : null;
  if (!list) return { error: 'modules_required', status: 400 };
  let upserted = 0;
  const rejected = [];
  for (const m of list) {
    if (typeof m?.name !== 'string' || !MOD_RE.test(m.name) || !/^[0-9a-f]{64}$/.test(m.sha || '')) { rejected.push(m?.name ?? null); continue; }
    sql.exec(
      `INSERT INTO atlas_modules (name, depth, area, lines, bytes, sha, pack, off, len, imports, decls, expect)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET depth = excluded.depth, area = excluded.area, lines = excluded.lines, bytes = excluded.bytes,
         sha = excluded.sha, pack = excluded.pack, off = excluded.off, len = excluded.len, imports = excluded.imports,
         decls = excluded.decls, expect = excluded.expect`,
      m.name, m.depth | 0, String(m.area || '').slice(0, 200), m.lines | 0, m.bytes | 0, m.sha, m.pack | 0, m.off | 0, m.len | 0,
      JSON.stringify((m.imports || []).slice(0, 2000)), JSON.stringify((m.decls || []).slice(0, 20000)), JSON.stringify((m.expect || []).slice(0, 40)),
    );
    upserted++;
  }
  return { ok: true, upserted, rejected };
}

export async function adminAtlas(sql, req) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.levels) || !Array.isArray(body.areas)) return { error: 'bad_meta', status: 400 };
  const meta = {
    modules: body.modules | 0, lines: body.lines | 0, max_depth: body.max_depth | 0, units: body.units | 0,
    levels: body.levels.map((l) => ({ depth: l.depth | 0, modules: l.modules | 0, lines: l.lines | 0 })),
    areas: body.areas.slice(0, 2000).map((a) => ({ area: String(a.area).slice(0, 200), modules: a.modules | 0, lines: a.lines | 0 })),
  };
  sql.exec("INSERT INTO atlas_meta (k, v) VALUES ('meta', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(meta));
  return { ok: true, levels: meta.levels.length, areas: meta.areas.length };
}

/** Card units arrive through /api/admin/units with extra fields; keep them here. */
export function cardUnitExtras(u) {
  if (u?.kind !== 'card' || u?.track !== 'A') return null;
  const modules = Array.isArray(u.modules) ? u.modules.slice(0, 8).filter((m) => typeof m?.name === 'string' && MOD_RE.test(m.name)) : [];
  if (!modules.length) return null;
  const part = u.part && typeof u.part === 'object'
    ? { i: u.part.i | 0, n: u.part.n | 0, from_line: u.part.from_line | 0, to_line: u.part.to_line | 0 } : null;
  return {
    depth: Number.isInteger(u.depth) ? u.depth : null,
    area: typeof u.area === 'string' ? u.area.slice(0, 200) : null,
    payload: JSON.stringify({
      modules: modules.map((m) => ({ name: m.name, expect: (m.expect || []).filter((x) => typeof x === 'string').slice(0, 40) })),
      imports: (u.imports || []).filter((x) => typeof x === 'string' && MOD_RE.test(x)).slice(0, 2000),
      part,
    }),
  };
}

// ---------- sources ----------

async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}
async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function moduleRow(sql, name) {
  return sql.exec('SELECT * FROM atlas_modules WHERE name = ?', name).toArray()[0] || null;
}

function gzSlice(sql, row) {
  const r = sql.exec('SELECT substr(data, ?, ?) AS b FROM src_packs WHERE id = ?', row.off + 1, row.len, row.pack).toArray()[0];
  return r?.b ? new Uint8Array(r.b) : null;
}

export async function moduleSource(sql, row) {
  const gz = gzSlice(sql, row);
  return gz ? gunzip(gz) : null;
}

/** GET /api/source/:sha → the gzip member (client gunzips and checks the sha). */
export function sourceBySha(sql, sha) {
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  const row = sql.exec('SELECT * FROM atlas_modules WHERE sha = ? LIMIT 1', sha).toArray()[0];
  return row ? gzSlice(sql, row) : null;
}

// ---------- leasing ----------

function cardsFor(sql, modules) {
  if (!modules.length) return [];
  const out = [];
  for (let i = 0; i < modules.length && out.length < IMPORT_CARDS_MAX; i += 100) {
    const chunk = modules.slice(i, i + 100);
    const rows = sql.exec(`SELECT key, module, card FROM cards WHERE module IN (${chunk.map(() => '?').join(',')}) ORDER BY key`, ...chunk).toArray();
    for (const r of rows) {
      const c = parseJ(r.card, {});
      out.push({ module: r.module, key: r.key, summary: c.summary, role_in_proof: c.role_in_proof });
    }
  }
  return out.slice(0, IMPORT_CARDS_MAX);
}

function importsReady(sql, imports) {
  if (!imports.length) return true;
  for (let i = 0; i < imports.length; i += 100) {
    const chunk = imports.slice(i, i + 100);
    const n = sql.exec(`SELECT COUNT(DISTINCT module) AS n FROM cards WHERE module IN (${chunk.map(() => '?').join(',')})`, ...chunk).one().n;
    if (n < chunk.length) return false;
  }
  return true;
}

/**
 * Pick a card unit for this node. The coordinator chooses, at random: audit
 * units first for established and trusted nodes, otherwise a random open unit
 * at the shallowest depth that has one this node may take. Returns {unit, payload} or null.
 */
export async function pickCardUnit(sql, nodeId, now, tier = 'new') {
  const ok = (u) => {
    const active = sql.exec('SELECT COUNT(*) AS n FROM leases WHERE unit_id = ? AND closed_at IS NULL AND expires_at >= ?', u.id, now).one().n;
    if (active >= LEASES_PER_CARD_UNIT) return false;
    return !sql.exec('SELECT 1 FROM leases WHERE unit_id = ? AND node_id = ? LIMIT 1', u.id, nodeId).toArray().length;
  };
  const tryRows = async (rows, audit) => {
    for (const u of rows) {
      if (!ok(u)) continue;
      const p = parseJ(u.payload, null);
      if (!p || (!audit && !importsReady(sql, p.imports || []))) continue;
      const payload = await buildPayload(sql, u, p);
      if (payload) return { unit: u, payload: { ...payload, audit: !!audit } };
    }
    return null;
  };
  if (tier === 'established' || tier === 'trusted') {
    const audits = sql.exec("SELECT * FROM units WHERE audit = 1 AND track = 'A' AND kind = 'card' LIMIT 20").toArray()
      .sort(() => Math.random() - 0.5);
    const r = await tryRows(audits, true);
    if (r) return r;
  }
  let depth = -1e9;
  for (let step = 0; step < 4; step++) {
    const d = sql.exec("SELECT depth FROM units WHERE track = 'A' AND state = 'open' AND depth > ? ORDER BY depth LIMIT 1", depth).toArray()[0];
    if (!d) return null;
    depth = d.depth;
    const x = Math.random();
    const q = (cmp) => sql.exec(`SELECT * FROM units WHERE track = 'A' AND state = 'open' AND depth = ? AND rk ${cmp} ? AND kind = 'card' ORDER BY rk LIMIT 20`, depth, x).toArray();
    const r = (await tryRows(q('>='), false)) || (await tryRows(q('<'), false));
    if (r) return r;
  }
  return null;
}

async function buildPayload(sql, u, p) {
  const mods = [];
  for (const m of p.modules) {
    const row = moduleRow(sql, m.name);
    if (!row) return null;
    let source = await moduleSource(sql, row);
    if (source == null) return null;
    if (p.part) source = source.split('\n').slice(p.part.from_line, p.part.to_line).join('\n');
    mods.push({
      name: m.name, depth: row.depth, area: row.area, lines: row.lines, module_sha256: row.sha,
      source, source_sha256: await sha256Hex(source), expect: m.expect,
    });
  }
  return {
    kind: 'card', unit_id: u.id, part: p.part || null, modules: mods,
    imports: cardsFor(sql, p.imports || []),
    limits: CARD_LIMITS,
  };
}

// ---------- results ----------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const URLISH = /\b(?:https?|ftp|file|ssh):\/\/|\bwww\.[a-z0-9-]+\./i;
const PATHISH = /(?:^|[\s"'`(])(?:~\/[\w.-]+\/|\/(?:Users|home|private|tmp|var|etc|opt|root|Volumes)\/[\w.-])|\b[A-Z]:\\(?:Users|Windows|Program|Documents)/;
const HOSTISH = /\b[a-z0-9-]+\.(?:local|lan|internal|home|corp)\b/i;

// Text that addresses other agents with instructions (prompt injection).
const INSTRUCT = /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|guidelines)\b|\byou must\b|\bnew instructions\b|\bsystem prompt\b|\bas an ai\b|<\/?\s*(?:system|untrusted|instructions?)\b|\b(?:agents?|assistants?|models?|lanes?)\s*[,:]\s*(?:please\s+)?(?:do|run|post|execute|reply|ignore|always|never)\b/i;

export function screenText(s) {
  if (INSTRUCT.test(s)) return 'instructions';
  if (EMAIL.test(s)) return 'email';
  if (URLISH.test(s)) return 'url';
  if (PATHISH.test(s)) return 'path';
  if (HOSTISH.test(s)) return 'hostname';
  return null;
}

function canon(decls, name) {
  // exact full name, or a unique match by dotted suffix
  const n = String(name).replace(/^_root_\./, '').trim();
  const full = decls.map((d) => d[1]);
  if (full.includes(n)) return n;
  const hits = full.filter((f) => f.endsWith('.' + n));
  return hits.length === 1 ? hits[0] : null;
}

function cleanCard(c, mod, decls, expect) {
  if (!c || typeof c !== 'object') return { err: 'not_object' };
  const summary = typeof c.summary === 'string' ? c.summary.trim() : '';
  const role = typeof c.role_in_proof === 'string' ? c.role_in_proof.trim() : '';
  if (!summary || words(summary) > CARD_LIMITS.summary_words || summary.length > CARD_LIMITS.summary_chars) return { err: 'summary_size' };
  if (!role || words(role) > CARD_LIMITS.role_words || role.length > CARD_LIMITS.role_chars) return { err: 'role_size' };
  if (!Array.isArray(c.statements) || c.statements.length > CARD_LIMITS.statements) return { err: 'statements_size' };
  const statements = [];
  const names = new Set();
  for (const s of c.statements) {
    if (!s || typeof s.lean_name !== 'string' || typeof s.latex !== 'string') return { err: 'statement_shape' };
    if (s.lean_name.length > CARD_LIMITS.lean_name || s.latex.length > CARD_LIMITS.latex || !s.latex.trim()) return { err: 'statement_size' };
    const k = canon(decls, s.lean_name);
    if (!k) return { err: `unknown_decl:${s.lean_name.slice(0, 80)}` };
    names.add(k);
    statements.push({ lean_name: k, latex: s.latex.trim() });
  }
  for (const e of expect) if (!names.has(e)) return { err: `missing_decl:${e.slice(0, 80)}` };
  const bad = screenText([summary, role, ...statements.map((s) => s.latex)].join('\n'));
  if (bad) return { err: `screen:${bad}` };
  return { card: { module: mod, summary, statements, role_in_proof: role }, names: [...names].sort() };
}

/**
 * A lane result for a card unit. Validates every card against the declarations
 * parsed from the source; on the second valid run from a different node that
 * names the same declarations, the cards are accepted.
 */
export function cardResult(sw, { lease, unit, nodeId, body, now, ident }) {
  const sql = sw.sql;
  const p = parseJ(unit.payload, null);
  const submitted = Array.isArray(body.cards) ? body.cards : [];
  let status = 'valid', reason = null;
  const cards = [], names = {};
  if (typeof body.discarded === 'string') { status = 'invalid'; reason = `discarded:${body.discarded.slice(0, 120)}`; }
  else if (!p) { status = 'invalid'; reason = 'no_payload'; }
  else if (submitted.length !== p.modules.length) { status = 'invalid'; reason = 'card_count'; }
  else {
    for (const m of p.modules) {
      const row = moduleRow(sql, m.name);
      const c = submitted.find((x) => x && x.module === m.name);
      const decls = parseJ(row?.decls, []);
      const r = c ? cleanCard(c, m.name, decls, m.expect || []) : { err: `no_card:${m.name}` };
      if (r.err) { status = 'invalid'; reason = r.err; break; }
      cards.push(r.card);
      names[m.name] = r.names;
    }
  }
  const vendor = typeof body.vendor === 'string' ? body.vendor.slice(0, 16) : null;
  const model = typeof body.model === 'string' ? body.model.slice(0, 64) : null;
  const laneMs = Number.isFinite(Number(body.lane_ms)) ? Math.max(0, Math.min(3600_000, Math.round(Number(body.lane_ms)))) : null;
  sql.exec(`INSERT INTO card_runs (unit_id, node_id, lease_id, at, status, reason, names, cards, vendor, model, lane_ms, ip24, gh_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    unit.id, nodeId, lease.lease_id, now, status, reason, JSON.stringify(names), status === 'valid' ? JSON.stringify(cards) : null, vendor, model, laneMs, ident?.ip24 || 'unknown', ident?.gh || null);

  let accepted = false, disagreed = false, audit = null;
  if (status === 'valid' && unit.state === 'done' && unit.audit) {
    // Spot audit by an established or trusted node.
    const agreed = sql.exec("SELECT * FROM card_runs WHERE unit_id = ? AND status = 'agreed'", unit.id).toArray();
    const key = JSON.stringify(names);
    const tier = trust.tierOf(sql, nodeId);
    if (agreed.length && (tier === 'established' || tier === 'trusted')) {
      if (agreed[0].names === key) {
        sql.exec('UPDATE units SET audit = 0, updated_at = ? WHERE id = ?', now, unit.id);
        sql.exec("UPDATE audits SET verdict = 'passed', auditor = ?, done_at = ? WHERE unit_id = ? AND verdict IS NULL", nodeId, now, unit.id);
        sql.exec("UPDATE card_runs SET status = 'audit' WHERE unit_id = ? AND node_id = ? AND status = 'valid'", unit.id, nodeId);
        trust.recordOutcomes(sql, [nodeId, ...agreed.map((r) => r.node_id)], []);
        audit = 'passed';
      } else {
        sql.exec("UPDATE audits SET verdict = 'failed', auditor = ?, done_at = ? WHERE unit_id = ? AND verdict IS NULL", nodeId, now, unit.id);
        reopenUnit(sw, unit.id, now, 'audit');
        const q = trust.recordOutcomes(sql, [], agreed.map((r) => r.node_id));
        for (const id of q) requeueNode(sw, id, now);
        audit = 'failed';
      }
    }
    const verdict = audit === 'passed' ? 'ok' : audit === 'failed' ? 'fail' : 'pending';
    return { verdict, status, reason, accepted: false, audit };
  }
  if (status === 'valid') {
    const runs = sql.exec("SELECT * FROM card_runs WHERE unit_id = ? AND status = 'valid' ORDER BY id ASC", unit.id).toArray();
    const tierMap = trust.tiers(sql, [...new Set(runs.map((r) => r.node_id))]);
    const live = runs.filter((r) => tierMap[r.node_id] !== 'quarantined');
    const mine = live.find((r) => r.lease_id === lease.lease_id);
    const key = JSON.stringify(names);
    // Largest set of pairwise-independent runs with my answer, starting from mine.
    const group = mine ? [mine] : [];
    for (const r of live) {
      if (r === mine || r.names !== key) continue;
      if (group.every((g) => trust.independent(trust.who(g), trust.who(r)))) group.push(r);
    }
    const est = group.filter((r) => tierMap[r.node_id] === 'established' || tierMap[r.node_id] === 'trusted').length;
    if (mine && ((group.length >= 2 && est >= 1) || group.length >= 3)) {
      accepted = true;
      acceptCards(sw, unit, p, group, now);
      const wrong = live.filter((r) => r.names !== key && group.some((g) => trust.independent(trust.who(g), trust.who(r))));
      const q = trust.recordOutcomes(sql, group.map((r) => r.node_id), wrong.map((r) => r.node_id));
      for (const id of q) requeueNode(sw, id, now);
      const allNew = est === 0;
      if (allNew || Math.random() < trust.AUDIT_RATE) {
        sql.exec('UPDATE units SET audit = 1 WHERE id = ?', unit.id);
        sql.exec('INSERT INTO audits (unit_id, reason, at) VALUES (?, ?, ?)', unit.id, allNew ? 'accepted by new nodes only' : 'random 5%', now);
      }
    } else if (live.some((r) => r.names !== key && r !== mine)) {
      disagreed = true;
    }
  }
  if (!accepted && (status === 'invalid' || disagreed)) {
    sql.exec(`UPDATE units SET attempts = attempts + 1, state = CASE WHEN attempts + 1 >= ? THEN 'gap' ELSE 'open' END, updated_at = ? WHERE id = ?`,
      MAX_CARD_ATTEMPTS, now, unit.id);
  }
  const verdict = accepted ? 'ok' : status === 'invalid' ? 'fail' : disagreed ? 'fail' : 'pending';
  return { verdict, status, reason, accepted, disagreed, needs: accepted ? null : 'independent agreement: 2 runs with an established node, or 3 new nodes' };
}

function acceptCards(sw, unit, p, group, now) {
  const sql = sw.sql;
  const first = group[0], second = group[1];
  const a = parseJ(first.cards, []), b = parseJ(second.cards, []);
  const ids = group.map((r) => r.node_id);
  for (const c of a) {
    const row = moduleRow(sql, c.module);
    const other = b.find((x) => x.module === c.module) || null;
    const key = p.part ? `${c.module}#${p.part.i}/${p.part.n}` : c.module;
    sql.exec(`INSERT INTO cards (key, module, unit_id, depth, area, part, card, second, nodes, label, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'agreement', ?)
              ON CONFLICT(key) DO UPDATE SET card = excluded.card, second = excluded.second, nodes = excluded.nodes, at = excluded.at`,
      key, c.module, unit.id, row?.depth ?? unit.depth, row?.area ?? unit.area, p.part ? JSON.stringify(p.part) : null,
      JSON.stringify(c), JSON.stringify(other), JSON.stringify(ids), now);
  }
  sql.exec("UPDATE units SET state = 'done', updated_at = ? WHERE id = ?", now, unit.id);
  for (const r of group) sql.exec("UPDATE card_runs SET status = 'agreed' WHERE id = ?", r.id);
  sw.emit('card', { unit_id: unit.id, modules: a.map((c) => c.module), nodes: ids, label: 'agreement' });
}

/** Undo an acceptance: cards removed, unit open again, its agreeing runs set aside. */
export function reopenUnit(sw, unitId, now, why) {
  const sql = sw.sql;
  sql.exec('DELETE FROM cards WHERE unit_id = ?', unitId);
  sql.exec("UPDATE units SET state = 'open', audit = 0, updated_at = ? WHERE id = ?", now, unitId);
  sql.exec(`UPDATE card_runs SET status = ? WHERE unit_id = ? AND status = 'agreed'`, why === 'audit' ? 'disputed' : 'valid', unitId);
  sw.emit('card', { unit_id: unitId, reopened: true, why });
}

/** A quarantined node's accepted work goes back in the queue. */
export function requeueNode(sw, nodeId, now) {
  const units = sw.sql.exec("SELECT DISTINCT unit_id FROM card_runs WHERE node_id = ? AND status = 'agreed'", nodeId).toArray();
  for (const u of units) reopenUnit(sw, u.unit_id, now, 'quarantine');
  sw.sql.exec("UPDATE card_runs SET status = 'quarantined' WHERE node_id = ? AND status IN ('valid', 'agreed')", nodeId);
}

// ---------- public reads ----------

function handles(sql, ids) {
  if (!ids.length) return {};
  const rows = sql.exec(`SELECT node_id, handle, github FROM nodes WHERE node_id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray();
  return Object.fromEntries(rows.map((r) => [r.node_id, { handle: r.handle, github: r.github || null }]));
}

export function mapView(sql) {
  const meta = parseJ(sql.exec("SELECT v FROM atlas_meta WHERE k = 'meta'").toArray()[0]?.v, null);
  const cardsByDepth = Object.fromEntries(sql.exec('SELECT depth, COUNT(DISTINCT module) AS n FROM cards GROUP BY depth').toArray().map((r) => [r.depth, r.n]));
  const cardsByArea = Object.fromEntries(sql.exec('SELECT area, COUNT(DISTINCT module) AS n FROM cards GROUP BY area').toArray().map((r) => [r.area, r.n]));
  const unitsByDepth = {};
  for (const r of sql.exec("SELECT depth, state, COUNT(*) AS n FROM units WHERE track = 'A' AND kind = 'card' GROUP BY depth, state").toArray()) {
    const d = (unitsByDepth[r.depth] ||= { loaded: 0, done: 0, gap: 0 });
    d.loaded += r.n; if (r.state === 'done') d.done += r.n; if (r.state === 'gap') d.gap += r.n;
  }
  const pendingByDepth = Object.fromEntries(sql.exec(
    `SELECT u.depth AS depth, COUNT(DISTINCT u.id) AS n FROM units u JOIN card_runs r ON r.unit_id = u.id
     WHERE u.track = 'A' AND u.state = 'open' AND r.status = 'valid' GROUP BY u.depth`).toArray().map((r) => [r.depth, r.n]));
  const levels = (meta?.levels || []).map((l) => ({
    depth: l.depth, modules: l.modules, lines: l.lines, cards: cardsByDepth[l.depth] || 0,
    units_loaded: unitsByDepth[l.depth]?.loaded || 0, units_done: unitsByDepth[l.depth]?.done || 0,
    units_one_run: pendingByDepth[l.depth] || 0, units_gap: unitsByDepth[l.depth]?.gap || 0,
  }));
  const areas = (meta?.areas || []).map((a) => ({ area: a.area, modules: a.modules, lines: a.lines, cards: cardsByArea[a.area] || 0 }));
  const runs = sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(lane_ms), 0) AS ms, SUM(CASE WHEN status IN ('valid','agreed') THEN 1 ELSE 0 END) AS ok FROM card_runs").one();
  const recent = sql.exec('SELECT key, module, depth, area, at FROM cards ORDER BY at DESC LIMIT 12').toArray();
  return {
    at: Date.now(),
    label: 'two-run agreement',
    totals: {
      modules: meta?.modules || 0, lines: meta?.lines || 0, max_depth: meta?.max_depth ?? null,
      cards: sql.exec('SELECT COUNT(DISTINCT module) AS n FROM cards').one().n,
      units_loaded: Object.values(unitsByDepth).reduce((s, d) => s + d.loaded, 0),
      runs: runs.n, runs_valid: runs.ok || 0, lane_hours: Math.round((runs.ms / 3600_000) * 100) / 100,
    },
    levels, areas, recent,
  };
}

export function moduleView(sql, name) {
  const row = moduleRow(sql, name);
  if (!row) return null;
  const cards = sql.exec('SELECT * FROM cards WHERE module = ? ORDER BY key', name).toArray();
  const ids = [...new Set(cards.flatMap((c) => parseJ(c.nodes, [])))];
  const who = handles(sql, ids);
  const unit = sql.exec(`SELECT u.id, u.state, u.attempts, u.audit FROM unit_modules m JOIN units u ON u.id = m.unit_id WHERE m.module = ? ORDER BY u.id LIMIT 1`, name).toArray()[0] || null;
  let runs = 0;
  if (unit) runs = sql.exec("SELECT COUNT(*) AS n FROM card_runs WHERE unit_id = ? AND status IN ('valid','agreed')", unit.id).one().n;
  const decls = parseJ(row.decls, []);
  const imports = parseJ(row.imports, []);
  const importedCards = imports.length ? new Set(sql.exec(`SELECT DISTINCT module FROM cards WHERE module IN (${imports.slice(0, 200).map(() => '?').join(',')})`, ...imports.slice(0, 200)).toArray().map((r) => r.module)) : new Set();
  return {
    module: row.name, depth: row.depth, area: row.area, lines: row.lines, bytes: row.bytes, sha256: row.sha,
    declarations: decls.length, theorems: decls.filter((d) => d[0] === 'theorem' || d[0] === 'lemma').length,
    imports: imports.map((m) => ({ module: m, card: importedCards.has(m) })),
    status: cards.length ? 'accepted' : unit ? (unit.state === 'gap' ? 'gap' : runs ? 'one run' : 'queued') : 'not loaded',
    unit: unit ? { id: unit.id, state: unit.state, attempts: unit.attempts, valid_runs: runs } : null,
    cards: cards.map((c) => ({
      key: c.key, label: c.label, part: parseJ(c.part, null), at: c.at,
      trust: trust.trustLine({ nodes: parseJ(c.nodes, []), tierMap: trust.tiers(sql, parseJ(c.nodes, [])), audit: unit?.audit ? 'pending' : null }),
      card: parseJ(c.card, null), second: parseJ(c.second, null),
      readers: parseJ(c.nodes, []).map((id) => who[id] || { handle: null, github: null }),
    })),
  };
}

export function contributors(sql) {
  const rows = sql.exec(`
    SELECT n.node_id, n.handle, n.github,
      (SELECT COUNT(*) FROM card_runs r WHERE r.node_id = n.node_id AND r.status IN ('valid','agreed')) AS runs,
      (SELECT COUNT(*) FROM card_runs r WHERE r.node_id = n.node_id AND r.status = 'agreed') AS accepted
    FROM nodes n WHERE n.github IS NOT NULL OR EXISTS (SELECT 1 FROM card_runs r WHERE r.node_id = n.node_id)`).toArray();
  return rows.map((r) => ({ handle: r.handle, github: r.github || null, runs: r.runs, cards_accepted: r.accepted }))
    .sort((a, b) => b.cards_accepted - a.cards_accepted || b.runs - a.runs);
}
