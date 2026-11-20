/**
 * Module-name search, served by the Worker from the compact module index
 * (a few blob rows in the Durable Object, read once per isolate), so a search
 * never scans the module table.
 */
let names = null; // { at, list: [[name, depth, lines]] }
const TTL_MS = 6 * 3600_000;

async function load(env) {
  if (names && Date.now() - names.at < TTL_MS) return names.list;
  const stub = env.SWARM.get(env.SWARM.idFromName('swarm'));
  const r = await stub.fetch(new Request('https://swarm/api/index/modules'));
  if (!r.ok) return names?.list || null;
  const text = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
  const list = text.split('\n').map((l) => { const [n, d, ln] = l.split('\t'); return [n, Number(d), Number(ln)]; });
  names = { at: Date.now(), list };
  return list;
}

export async function searchModules(env, q, limit = 20) {
  q = String(q || '').trim().slice(0, 120);
  if (q.length < 2) return { q, modules: [] };
  const list = await load(env);
  if (!list) return { q, modules: [], error: 'index_unavailable' };
  const ql = q.toLowerCase();
  const hits = [];
  for (const [n, d, ln] of list) {
    if (n.toLowerCase().includes(ql)) hits.push({ name: n, depth: d, lines: ln, area: n.split('.').slice(0, n.split('.').length > 2 ? 2 : 1).join('.') });
    if (hits.length >= 400) break;
  }
  hits.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return { q, modules: hits.slice(0, limit) };
}
