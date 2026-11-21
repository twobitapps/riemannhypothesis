/**
 * The lexical declaration graph (LEXICAL, APPROXIMATE: see tools/depgraph.py).
 *
 * Storage: per module row, `deps` and `rdeps` (for each of its declarations,
 * the global ids it mentions / that mention it); `decl_names` maps a full
 * declaration name to its global id; the blob `declofs` (cumulative
 * declaration counts per module, Int32) and the blob `reach` (for each id the
 * next declaration toward Main, -1 for Main's own, -2 for unreached; Int32)
 * are held in memory. Queries are answered from these, with bounded work.
 */
export const LABEL = 'lexical (approximate)';
const BFS_MAX = 4000;

const parseJ = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export function initGraph(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS decl_names (name TEXT PRIMARY KEY, id INTEGER) WITHOUT ROWID');
  const cols = sql.exec('PRAGMA table_info(atlas_modules)').toArray().map((c) => c.name);
  if (!cols.includes('idx')) sql.exec('ALTER TABLE atlas_modules ADD COLUMN idx INTEGER');
  if (!cols.includes('deps')) sql.exec('ALTER TABLE atlas_modules ADD COLUMN deps TEXT');
  if (!cols.includes('rdeps')) sql.exec('ALTER TABLE atlas_modules ADD COLUMN rdeps TEXT');
  sql.exec('CREATE INDEX IF NOT EXISTS atlas_modules_idx ON atlas_modules (idx)');
}

async function blobBytes(sql, name) {
  const rows = sql.exec('SELECT part, parts, data FROM blobs WHERE name = ? ORDER BY part', name).toArray();
  if (!rows.length || rows.length !== rows[0].parts) return null;
  const total = rows.reduce((n, r) => n + r.data.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const r of rows) { out.set(new Uint8Array(r.data), o); o += r.data.byteLength; }
  const s = new Blob([out]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** In-memory arrays, loaded once per object. */
export async function arrays(sw) {
  if (sw.graphArrays) return sw.graphArrays;
  const ofs = await blobBytes(sw.sql, 'declofs');
  const reach = await blobBytes(sw.sql, 'reach');
  const meta = await blobBytes(sw.sql, 'graphmeta');
  if (!ofs || !reach || !meta) return null;
  sw.graphArrays = {
    ofs: new Int32Array(ofs.buffer, ofs.byteOffset, ofs.byteLength / 4),
    parent: new Int32Array(reach.buffer, reach.byteOffset, reach.byteLength / 4),
    meta: JSON.parse(new TextDecoder().decode(meta)),
  };
  return sw.graphArrays;
}

function locate(ofs, id) {
  let lo = 0, hi = ofs.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ofs[mid] <= id) lo = mid; else hi = mid - 1; }
  return { mod: lo, local: id - ofs[lo] };
}

function moduleByIdx(sql, cache, idx) {
  if (cache.has(idx)) return cache.get(idx);
  const r = sql.exec('SELECT name, idx, decls, deps, rdeps FROM atlas_modules WHERE idx = ?', idx).toArray()[0] || null;
  const v = r && { name: r.name, decls: parseJ(r.decls, []), deps: parseJ(r.deps, []), rdeps: parseJ(r.rdeps, []) };
  cache.set(idx, v);
  return v;
}

function declOf(sql, A, cache, id) {
  const { mod, local } = locate(A.ofs, id);
  const m = moduleByIdx(sql, cache, mod);
  if (!m) return null;
  const d = m.decls[local] || [];
  return { id, name: d[1], kind: d[0], private: !!d[2], module: m.name, deps: m.deps[local] || [], rdeps: m.rdeps[local] || [] };
}

function idOf(sql, name) {
  return sql.exec('SELECT id FROM decl_names WHERE name = ?', String(name || '').trim()).toArray()[0]?.id ?? null;
}

/** USES / USED_BY / REACHES_MAIN for one declaration. */
export async function declView(sw, name) {
  const A = await arrays(sw);
  if (!A) return { error: 'graph_not_loaded' };
  const id = idOf(sw.sql, name);
  if (id == null) return { error: 'unknown_declaration' };
  const cache = new Map();
  const d = declOf(sw.sql, A, cache, id);
  const names = (ids, cap) => ids.slice(0, cap).map((x) => declOf(sw.sql, A, cache, x)).filter(Boolean).map((x) => ({ name: x.name, module: x.module }));
  const path = [];
  let cur = id;
  for (let hop = 0; hop < 60 && A.parent[cur] >= 0; hop++) { cur = A.parent[cur]; path.push(cur); }
  const reaches = A.parent[id] !== -2;
  return {
    label: LABEL, name: d.name, kind: d.kind, module: d.module,
    uses: names(d.deps, 100), uses_total: d.deps.length,
    used_by: names(d.rdeps, 100), used_by_total: d.rdeps.length,
    reaches_main: reaches,
    path_to_main: reaches ? names([id, ...path], 61).map((x) => x.name) : null,
  };
}

/** Does `a` (transitively) mention `b`? Bounded breadth-first search. */
export async function depends(sw, a, b) {
  const A = await arrays(sw);
  if (!A) return { error: 'graph_not_loaded' };
  const ia = idOf(sw.sql, a), ib = idOf(sw.sql, b);
  if (ia == null || ib == null) return { error: 'unknown_declaration' };
  const cache = new Map();
  // Fast path: b's recorded path toward Main passes through a.
  const chain = [ib];
  for (let c = ib, hop = 0; hop < 200 && A.parent[c] >= 0; hop++) { c = A.parent[c]; chain.push(c); if (c === ia) break; }
  const at = chain.indexOf(ia);
  if (at >= 0) return { label: LABEL, a, b, depends: true, path: chain.slice(0, at + 1).reverse().map((x) => declOf(sw.sql, A, cache, x)?.name), visited: chain.length };
  const prev = new Map([[ia, -1]]);
  const q = [ia];
  let visited = 0;
  while (q.length && visited < BFS_MAX) {
    const x = q.shift();
    visited++;
    if (x === ib) {
      const path = [];
      for (let c = ib; c !== -1; c = prev.get(c)) path.unshift(declOf(sw.sql, A, cache, c)?.name);
      return { label: LABEL, a, b, depends: true, path, visited };
    }
    const d = declOf(sw.sql, A, cache, x);
    for (const y of d?.deps || []) if (!prev.has(y)) { prev.set(y, x); q.push(y); }
  }
  return { label: LABEL, a, b, depends: q.length ? 'unknown (search bound reached)' : false, visited };
}

export async function stats(sw) {
  const A = await arrays(sw);
  if (!A) return { error: 'graph_not_loaded' };
  return { label: LABEL, ...A.meta };
}

export function adminModDeps(sql, body) {
  const list = Array.isArray(body?.modules) ? body.modules.slice(0, 5000) : [];
  let n = 0;
  for (const m of list) {
    if (typeof m?.name !== 'string' || !Number.isInteger(m.idx)) continue;
    sql.exec('UPDATE atlas_modules SET idx = ?, deps = ?, rdeps = ? WHERE name = ?', m.idx, JSON.stringify(m.deps || []), JSON.stringify(m.rdeps || []), m.name);
    n++;
  }
  return { ok: true, updated: n };
}

export function adminDeclNames(sql, body) {
  const list = Array.isArray(body?.names) ? body.names.slice(0, 20000) : [];
  for (const [name, id] of list) sql.exec('INSERT INTO decl_names (name, id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET id = excluded.id', String(name), id | 0);
  return { ok: true, upserted: list.length };
}
