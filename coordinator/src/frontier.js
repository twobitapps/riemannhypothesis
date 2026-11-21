/**
 * Frontiers: one deterministic, unforgeable number per track, derived at read
 * time from stored inputs (never from stored flags), with its history and
 * "new best" events.
 *
 *   A  load-bearing declarations with a certified statement: distinct Lean
 *      names in accepted cards (≈ independent agreement) that the lexical
 *      graph says Main reaches.
 *   R  modules rebuilt by an independent quorum (accepted rebuild packets).
 *   M  sorries left in the locked skeleton: coming, with the Track M pilot.
 *
 * A new best is posted on the board (kind `best`) at most once per track per
 * hour, citing the work that moved the number.
 */
import * as board from './board.js';
import * as graph from './graph.js';

const parseJ = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const HOUR = 3600_000;

async function seriesA(sw) {
  const sql = sw.sql;
  const A = await graph.arrays(sw);
  const cards = sql.exec('SELECT key, module, unit_id, card, nodes, at FROM cards ORDER BY at ASC').toArray();
  const seen = new Set();
  const points = [];
  const events = [];
  for (const c of cards) {
    const names = (parseJ(c.card, {}).statements || []).map((s) => s.lean_name);
    let added = 0;
    for (const n of names) {
      if (seen.has(n)) continue;
      const id = sql.exec('SELECT id FROM decl_names WHERE name = ?', n).toArray()[0]?.id;
      if (id == null || !A || A.parent[id] === -2) continue;
      seen.add(n); added++;
    }
    if (added) { points.push([c.at, seen.size]); events.push({ at: c.at, value: seen.size, unit: c.unit_id, module: c.module, nodes: parseJ(c.nodes, []) }); }
  }
  return { value: seen.size, points, events, graph: !!A };
}

function seriesR(sw) {
  const rows = sw.sql.exec("SELECT id, payload, updated_at FROM units WHERE track = 'R' AND kind = 'rebuild' AND state = 'done' ORDER BY updated_at ASC").toArray();
  let v = 0;
  const points = [], events = [];
  for (const u of rows) {
    const n = (parseJ(u.payload, {}).modules || []).length;
    v += n;
    points.push([u.updated_at, v]);
    const nodes = sw.sql.exec("SELECT node_id FROM receipts WHERE unit_id = ? AND status = 'agreed'", u.id).toArray().map((r) => r.node_id);
    events.push({ at: u.updated_at, value: v, unit: u.id, nodes });
  }
  return { value: v, points, events };
}

function thin(points, max = 120) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function who(sql, ids) {
  if (!ids?.length) return [];
  return sql.exec(`SELECT handle, github FROM nodes WHERE node_id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray().map((r) => r.github ? `@${r.github}` : r.handle);
}

export async function frontier(sw) {
  const A = await seriesA(sw);
  const R = seriesR(sw);
  const last = (s) => {
    const e = s.events[s.events.length - 1];
    if (!e) return null;
    const post = sw.sql.exec("SELECT id FROM posts WHERE kind = 'best' AND refs LIKE ? ORDER BY seq DESC LIMIT 1", `%${e.unit}%`).toArray()[0]?.id || null;
    return { at: e.at, value: e.value, unit: e.unit, by: who(sw.sql, e.nodes), post };
  };
  return {
    at: Date.now(),
    tracks: {
      A: { name: 'load-bearing declarations with a certified statement', mark: '≈', value: A.value, series: thin(A.points), last_best: last(A), note: A.graph ? 'certified = accepted card (independent agreement); load-bearing = reaches Main in the lexical graph (approximate)' : 'graph not loaded' },
      R: { name: 'modules rebuilt by an independent quorum', mark: '⛓', value: R.value, series: thin(R.points), last_best: last(R) },
      M: { name: 'sorries left in the locked skeleton', status: 'coming', value: null, series: [] },
    },
  };
}

/** After an acceptance: post a `best` when a track's number rose, at most hourly per track. */
export async function maybePostBest(sw) {
  const sql = sw.sql;
  const f = await frontier(sw);
  for (const [k, t] of Object.entries(f.tracks)) {
    if (t.value == null || !t.last_best) continue;
    const key = `best_${k}`;
    const prev = parseJ(sql.exec('SELECT v FROM schema_meta WHERE k = ?', key).toArray()[0]?.v, { value: 0, at: 0 });
    if (t.value <= prev.value || Date.now() - prev.at < HOUR) continue;
    const since = (k === 'A' ? (await seriesA(sw)).events : seriesR(sw).events).filter((e) => e.at > prev.at);
    const units = [...new Set(since.map((e) => e.unit))].slice(0, 12);
    const by = [...new Set(since.flatMap((e) => who(sql, e.nodes)))].slice(0, 8);
    const author = since[since.length - 1]?.nodes?.[0] || 'coordinator';
    const r = board.createPost(sw, {
      body: {
        kind: 'best', title: `New best on track ${k}: ${t.value.toLocaleString('en-US')} ${t.name}`.slice(0, 100),
        body: `Track ${k} rose from ${prev.value} to ${t.value} (${t.name}). Work that moved it: ${units.join(', ')}. By ${by.join(', ') || 'the swarm'}.`.slice(0, 1500),
        refs: units,
      },
      nodeId: author, now: Date.now(),
    }, { derived: true, seed: author === 'coordinator' });
    sql.exec('INSERT INTO schema_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, JSON.stringify({ value: t.value, at: Date.now() }));
    if (r.post) sw.afterPost(r.post);
  }
}
