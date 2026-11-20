/**
 * Track R — an independent replay of Alpöge's archive, packet by packet.
 *
 * A `rebuild` unit is a packet of sibling modules. A verifier node fetches the
 * pinned archive itself (from any of SOURCES, checked against ARCHIVE_SHA256;
 * we never re-host it), builds the packet from source in its Lean sandbox
 * against the pinned toolchain and Mathlib, replays the kernel with
 * leanchecker, and posts a signed receipt:
 *   { packet, toolchain, mathlib_rev, modules: [{ name, source_sha256, olean_sha256 }],
 *     lake_exit, leanchecker_exit, wall_ms, lint }
 * A packet is accepted when two different nodes report successful builds with
 * byte-identical olean hashes (no human review queue). A mismatch counts an
 * attempt, re-opens the packet for fresh runs, and posts a "stuck" note.
 * Accepted receipts appear on the board as findings labelled ⛓.
 */
import * as board from './board.js';

export const ARCHIVE_SHA256 = '9631b4f020199e580ba86178cb56c6e9b09f690c2369a80dc4334aa93f49c7fc';
export const TOOLCHAIN = 'leanprover/lean4:v4.33.1';
export const MATHLIB_REV = '0df444a360eaa60ab8c11dca51a86af692955474';
export const SOURCES = [
  { kind: 'parts', base: 'https://alpo.ge/lean.tar.gz.part', parts: 14 },
  { kind: 'github', repo: 'Deicyde/riemann-hypothesis' },
];
const LEASES_PER_PACKET = 2;
const MAX_ATTEMPTS = 6;
const MOD_RE = /^[\p{L}\p{N}_'.!?«»₀-₉]{1,300}$/u;
const HEX64 = /^[0-9a-f]{64}$/;

const parseJ = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export function initReplay(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, unit_id TEXT, node_id TEXT, lease_id TEXT, at INTEGER,
      ok INTEGER, olean_hash TEXT, receipt TEXT, status TEXT);
    CREATE INDEX IF NOT EXISTS receipts_unit ON receipts (unit_id);
  `);
}

export function rebuildUnitExtras(u) {
  if (u?.kind !== 'rebuild' || u?.track !== 'R') return null;
  const modules = Array.isArray(u.modules) ? u.modules.slice(0, 16).filter((m) => typeof m?.name === 'string' && MOD_RE.test(m.name) && HEX64.test(m.sha || '')) : [];
  if (!modules.length) return null;
  return {
    depth: Number.isInteger(u.depth) ? u.depth : null,
    area: typeof u.area === 'string' ? u.area.slice(0, 200) : null,
    payload: JSON.stringify({ modules: modules.map((m) => ({ name: m.name, sha: m.sha })) }),
  };
}

export function pickRebuildUnit(sql, nodeId, now) {
  const rows = sql.exec(
    `SELECT u.* FROM units u WHERE u.track = 'R' AND u.kind = 'rebuild' AND u.state = 'open'
       AND (SELECT COUNT(*) FROM leases l WHERE l.unit_id = u.id AND l.closed_at IS NULL AND l.expires_at >= ?) < ?
       AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.unit_id = u.id AND r.node_id = ? AND r.status != 'superseded')
       AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.unit_id = u.id AND l.node_id = ? AND l.closed_at IS NULL)
     ORDER BY u.depth ASC, u.id ASC LIMIT 1`,
    now, LEASES_PER_PACKET, nodeId, nodeId,
  ).toArray();
  const u = rows[0];
  if (!u) return null;
  const p = parseJ(u.payload, null);
  if (!p) return null;
  return {
    unit: u,
    payload: {
      kind: 'rebuild', unit_id: u.id, depth: u.depth,
      modules: p.modules.map((m) => ({ name: m.name, module_sha256: m.sha })),
      archive_sha256: ARCHIVE_SHA256, toolchain: TOOLCHAIN, mathlib_rev: MATHLIB_REV, sources: SOURCES,
    },
  };
}

function cleanReceipt(r, p) {
  if (!r || typeof r !== 'object') return { err: 'no_receipt' };
  if (r.toolchain !== TOOLCHAIN) return { err: 'wrong_toolchain' };
  if (r.mathlib_rev !== MATHLIB_REV) return { err: 'wrong_mathlib' };
  if (r.archive_sha256 !== ARCHIVE_SHA256) return { err: 'wrong_archive' };
  if (!Array.isArray(r.modules) || r.modules.length !== p.modules.length) return { err: 'module_count' };
  const mods = [];
  for (const m of p.modules) {
    const x = r.modules.find((y) => y && y.name === m.name);
    if (!x) return { err: `missing:${m.name.slice(0, 80)}` };
    if (x.source_sha256 !== m.sha) return { err: `source_mismatch:${m.name.slice(0, 80)}` };
    const ok = Number(r.lake_exit) === 0;
    if (ok && !HEX64.test(x.olean_sha256 || '')) return { err: 'bad_olean_hash' };
    mods.push({ name: m.name, source_sha256: x.source_sha256, olean_sha256: HEX64.test(x.olean_sha256 || '') ? x.olean_sha256 : null });
  }
  const lint = Array.isArray(r.lint) ? r.lint.filter((s) => typeof s === 'string').slice(0, 20).map((s) => s.slice(0, 120)) : [];
  return {
    receipt: {
      packet: p.modules.map((m) => m.name), toolchain: TOOLCHAIN, mathlib_rev: MATHLIB_REV, archive_sha256: ARCHIVE_SHA256,
      modules: mods, lake_exit: Number(r.lake_exit), leanchecker_exit: Number(r.leanchecker_exit),
      wall_ms: Math.max(0, Math.min(86_400_000, Number(r.wall_ms) || 0)), lint,
      sandbox: String(r.sandbox || '').slice(0, 40),
    },
  };
}

async function hashOf(mods) {
  const s = JSON.stringify(mods.map((m) => [m.name, m.olean_sha256]).sort());
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function rebuildResult(sw, { lease, unit, nodeId, body, now }) {
  const sql = sw.sql;
  const p = parseJ(unit.payload, null);
  const c = p ? cleanReceipt(body.receipt, p) : { err: 'no_payload' };
  if (c.err) {
    sql.exec('INSERT INTO receipts (unit_id, node_id, lease_id, at, ok, olean_hash, receipt, status) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)',
      unit.id, nodeId, lease.lease_id, now, JSON.stringify({ error: c.err }), 'invalid');
    return { verdict: 'fail', status: 'invalid', reason: c.err };
  }
  const r = c.receipt;
  const ok = r.lake_exit === 0 && r.leanchecker_exit === 0;
  const h = ok ? await hashOf(r.modules) : null;
  sql.exec('INSERT INTO receipts (unit_id, node_id, lease_id, at, ok, olean_hash, receipt, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    unit.id, nodeId, lease.lease_id, now, ok ? 1 : 0, h, JSON.stringify(r), 'pending');
  const others = sql.exec("SELECT * FROM receipts WHERE unit_id = ? AND node_id != ? AND status = 'pending' ORDER BY id", unit.id, nodeId).toArray();
  const mine = sql.exec("SELECT id FROM receipts WHERE unit_id = ? AND node_id = ? ORDER BY id DESC LIMIT 1", unit.id, nodeId).one().id;
  if (ok) {
    const partner = others.find((o) => o.ok && o.olean_hash === h);
    if (partner) {
      sql.exec("UPDATE receipts SET status = 'agreed' WHERE id IN (?, ?)", partner.id, mine);
      sql.exec("UPDATE units SET state = 'done', updated_at = ? WHERE id = ?", now, unit.id);
      const short = r.packet.length > 1 ? `${r.packet[0].split('.').slice(-1)[0]} +${r.packet.length - 1}` : r.packet[0].split('.').slice(-2).join('.');
      const body2 = [
        `Packet of ${r.packet.length} module${r.packet.length > 1 ? 's' : ''} rebuilt from source by two nodes with byte-identical .olean files, and the kernel replayed with leanchecker (exit 0 on both).`,
        `Toolchain ${TOOLCHAIN}; Mathlib ${MATHLIB_REV.slice(0, 12)}; archive sha256 ${ARCHIVE_SHA256.slice(0, 12)}.`,
        `Olean set hash ${h.slice(0, 16)}. Wall time ${(r.wall_ms / 1000).toFixed(0)} s and ${(JSON.parse(partner.receipt).wall_ms / 1000).toFixed(0)} s.`,
      ].join(' ');
      const res = board.createPost(sw, {
        body: { kind: 'finding', title: `Receipt: ${short} rebuilt and kernel-checked`.slice(0, 100), body: body2, refs: [unit.id, ...r.packet.slice(0, 10)] },
        nodeId: partner.node_id, now,
      }, { derived: true, fixedLabel: 'kernel' });
      if (res.post) sw.afterPost(res.post);
      sw.emit('receipt', { unit_id: unit.id, nodes: [partner.node_id, nodeId], olean_hash: h, accepted: true });
      return { verdict: 'ok', status: 'valid', accepted: true, olean_hash: h };
    }
  }
  const conflict = others.length > 0 || !ok;
  if (conflict) {
    sql.exec("UPDATE receipts SET status = 'superseded' WHERE unit_id = ? AND status = 'pending'", unit.id);
    sql.exec(`UPDATE units SET attempts = attempts + 1, state = CASE WHEN attempts + 1 >= ? THEN 'gap' ELSE 'open' END, updated_at = ? WHERE id = ?`, MAX_ATTEMPTS, now, unit.id);
    const why = !ok ? `build or kernel replay failed (lake exit ${r.lake_exit}, leanchecker exit ${r.leanchecker_exit})` : 'two nodes produced different .olean hashes';
    const res = board.createPost(sw, {
      body: { kind: 'stuck', title: `Replay mismatch: ${r.packet[0].split('.').slice(-2).join('.')}`.slice(0, 100), body: `Track R packet ${unit.id}: ${why}. The packet is re-queued for fresh runs.`, refs: [unit.id, ...r.packet.slice(0, 10)] },
      nodeId, now,
    }, { derived: true });
    if (res.post) sw.afterPost(res.post);
    sw.emit('receipt', { unit_id: unit.id, node_id: nodeId, accepted: false, mismatch: true });
    return { verdict: 'fail', status: ok ? 'valid' : 'failed', mismatch: true, olean_hash: h };
  }
  sw.emit('receipt', { unit_id: unit.id, node_id: nodeId, accepted: false });
  return { verdict: 'pending', status: 'valid', accepted: false, olean_hash: h };
}

export function replayLevels(sql, now) {
  const out = {};
  for (const r of sql.exec(`SELECT u.depth AS depth, u.state AS state, u.attempts AS attempts,
       (SELECT COUNT(*) FROM leases l WHERE l.unit_id = u.id AND l.closed_at IS NULL AND l.expires_at >= ?) AS leased,
       (SELECT COUNT(*) FROM receipts r WHERE r.unit_id = u.id AND r.status = 'pending' AND r.ok = 1) AS pending
     FROM units u WHERE u.track = 'R' AND u.kind = 'rebuild'`, now).toArray()) {
    const d = (out[r.depth ?? 0] ||= { depth: r.depth ?? 0, packets: 0, accepted: 0, in_flight: 0, mismatched: 0 });
    d.packets++;
    if (r.state === 'done') d.accepted++;
    else if (r.leased || r.pending) d.in_flight++;
    else if (r.attempts > 0) d.mismatched++;
  }
  return Object.values(out).sort((a, b) => a.depth - b.depth);
}

export function receiptsFor(sql, unitId) {
  return sql.exec('SELECT node_id, at, ok, olean_hash, receipt, status FROM receipts WHERE unit_id = ? ORDER BY id', unitId).toArray()
    .map((r) => ({ node_id: r.node_id, at: r.at, ok: !!r.ok, olean_hash: r.olean_hash, status: r.status, receipt: parseJ(r.receipt, null) }));
}
