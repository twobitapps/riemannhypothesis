/**
 * riemann-swarm — coordinator for the Riemann swarm (docs/PROTOCOL.md v1).
 *
 * The Worker routes every /api/* call to ONE SQLite Durable Object ("Swarm"),
 * which holds nodes, nonces, the event log, units, leases, results and the
 * signup list. Node calls (hello/beat/lease/result/bye) are Ed25519-signed over
 * the exact request body bytes. Public reads (state, events, signups/count)
 * never carry emails, IPs, tokens or public keys.
 *
 * SSE uses Last-Event-ID replay; onboarding text is bundled at deploy time.
 */
import JOIN_SH from '../../client/join.sh';
import AGENTS_MD from '../../AGENTS.md';

const DEFAULT_BEAT_MS = 20_000;
const TS_WINDOW_MS = 5 * 60_000;
const NONCE_WINDOW_MS = 10 * 60_000;
const EVENTS_KEEP = 1000;
const STATE_EVENTS = 200;
const LEASE_MS = 30 * 60_000;
const MAX_BODY = 64 * 1024;
const SIGNUP_LIMIT_PER_HOUR = 5;
const MAX_ATTEMPTS = 6;
const NODES_LISTED_MS = 7 * 24 * 3600_000;

const ROLES = ['thinker', 'verifier', 'anchor', 'canary', 'finisher', 'prover', 'atlas'];
const STATUSES = ['idle', 'preparing', 'thinking', 'checking', 'verifying', 'building', 'seeding', 'paused'];
const TRACKS = ['M', 'A', 'R'];
const UNIT_KINDS = ['statement', 'proof', 'roundtrip', 'card', 'verify', 'build', 'rebuild'];
const UNIT_STATES = ['open', 'leased', 'done', 'failed', 'gap'];
const LANE_KINDS = ['claude', 'codex', 'local'];
const CLAUDE_PLANS = ['pro', 'max5', 'max20', 'team', 'none'];
const CODEX_PLANS = ['plus', 'pro', 'team', 'none'];
const SIGNUP_MACHINE_KINDS = ['mac', 'big'];
const SIGNUP_EXPERT = ['lean', 'number-theory'];
const PROOFS = ['alpoge', 'masullo'];
const PROOF_TRACKS = { alpoge: ['A', 'R'], masullo: ['M'] };
const VERDICTS = ['ok', 'fail', 'gap', 'skip'];

const CORS = { 'access-control-allow-origin': '*' };
const TEXT = (type) => ({ 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', ...CORS });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...CORS, 'access-control-allow-headers': 'content-type, last-event-id', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '86400' },
      });
    }
    // Public clients reach the coordinator through the site proxy (RH_PUBLIC_API),
    // which adds x-rh-proxy-key and x-rh-client-ip. Only a request carrying the
    // right key may name its client IP; everyone else is rate limited by the
    // connecting IP. With REQUIRE_PROXY=1, non-admin API calls must come through
    // the proxy. Admin routes are worker-direct only and never proxied.
    const proxyKey = env.RH_PROXY_KEY || '';
    const viaProxy = proxyKey.length >= 16 && timingSafeEqual(req.headers.get('x-rh-proxy-key') || '', proxyKey);
    const api = publicApi(env, `${url.origin}/api`);
    if (p.startsWith('/api/')) {
      const admin = p.startsWith('/api/admin/');
      if (admin && viaProxy) return json({ error: 'not_found' }, 404);
      if (!admin && !viaProxy && env.REQUIRE_PROXY === '1') return json({ error: 'use_public_api', api }, 403, CORS);
      const h = new Headers(req.headers);
      h.delete('x-rh-proxy-key');
      h.delete('x-rh-client-ip');
      h.delete('x-rh-ip');
      const ip = (viaProxy ? (req.headers.get('x-rh-client-ip') || '').split(',')[0].trim() : '') || req.headers.get('cf-connecting-ip') || 'unknown';
      h.set('x-rh-ip', ip.slice(0, 64));
      const stub = env.SWARM.get(env.SWARM.idFromName('swarm'));
      return stub.fetch(new Request(req, { headers: h }));
    }
    if (p === '/join.sh') return new Response(JOIN_SH.replaceAll('__RH_COORDINATOR__', api), { headers: TEXT('text/x-shellscript') });
    if (p === '/agent.md') return new Response(agentDoc(api), { headers: TEXT('text/markdown') });
    if (p === '/llms.txt' || p === '/') return new Response(llmsTxt(api), { headers: TEXT('text/plain') });
    return json({ error: 'not_found' }, 404);
  },
};

/** The API base clients should use: the public proxy when configured, else this Worker's /api. */
function publicApi(env, fallback) {
  return String(env.RH_PUBLIC_API || fallback).replace(/\/+$/, '');
}

function agentDoc(api) {
  return `<!-- Served by ${api}. Join from any shell:
  curl -fsSL ${api}/join.sh | bash -s -- --handle <handle> --roles verifier --proofs both
-->
${AGENTS_MD}
## Coordinator

- API base: ${api}
- Join: \`curl -fsSL ${api}/join.sh | bash -s -- --handle <h> --place <city> --roles thinker,verifier --cap <n> --proofs alpoge|masullo|both\`
- Proofs: ask your person which claimed proof to help verify — alpoge (tracks A+R), masullo (track M), or both (default).
- Live state: ${api}/state (no emails or IPs)
- Live events: ${api}/events (SSE)
`;
}

function llmsTxt(api) {
  return `# Riemann swarm

> A community supercomputer that checks and formalizes claimed proofs of the
> Riemann Hypothesis in Lean. Lean's kernel is the referee.

Machines join with an Ed25519 identity, report hardware, heartbeat, and (from
phase 2) lease work units. Every node call is signed.

- API base: ${api}
- Agent instructions: ${api}/agent.md
- Join script: ${api}/join.sh  (needs a checkout: git clone https://github.com/twobitapps/riemannhypothesis)
- Public state: ${api}/state
- Live events (SSE): ${api}/events
- Interest list count: ${api}/signups/count
`;
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}
const pub = (obj, status = 200) => json(obj, status, CORS);

// ---------- small helpers ----------

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function str(v, max, re) {
  if (typeof v !== 'string') return null;
  let s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  if (re) s = s.replace(re, '');
  return s || null;
}
function num(v, min = 0, max = 1e9) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}
function int(v, min = 0, max = 1e9) {
  const n = num(v, min, max);
  return n == null ? null : Math.round(n);
}
function pick(v, allowed) {
  return allowed.includes(v) ? v : null;
}
function pickList(v, allowed, max = allowed.length) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x) => allowed.includes(x)))].slice(0, max);
}
function parseJ(s, dflt) {
  try { return s == null ? dflt : JSON.parse(s); } catch { return dflt; }
}

const ADJ = ['quiet', 'prime', 'bright', 'steady', 'lucid', 'patient', 'golden', 'silver', 'brisk', 'calm', 'keen', 'noble'];
const NOUN = ['zeta', 'lemma', 'kernel', 'prime', 'orbit', 'field', 'ring', 'ideal', 'sheaf', 'torus', 'modulus', 'residue'];
function genHandle(seedHex) {
  const a = parseInt(seedHex.slice(0, 4), 16), b = parseInt(seedHex.slice(4, 8), 16);
  return `${ADJ[a % ADJ.length]}-${NOUN[b % NOUN.length]}`;
}

function cleanMachine(m) {
  m = m && typeof m === 'object' ? m : {};
  return {
    chip: str(m.chip, 64) || 'unknown',
    cores: int(m.cores, 0, 4096) ?? 0,
    perf_cores: int(m.perf_cores, 0, 4096),
    ram_gb: num(m.ram_gb, 0, 65536) ?? 0,
    disk_free_gb: num(m.disk_free_gb, 0, 1e7),
    os: str(m.os, 24),
    os_version: str(m.os_version, 32),
    arch: str(m.arch, 16),
    gpu: str(m.gpu, 96),
  };
}
function cleanLanes(l) {
  l = l && typeof l === 'object' ? l : {};
  const local = Array.isArray(l.local_models) ? l.local_models.map((x) => str(x, 64)).filter(Boolean).slice(0, 16) : [];
  return { claude: l.claude === true, codex: l.codex === true, local_models: local };
}
function cleanActivity(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    track: pick(a.track, TRACKS),
    unit_id: str(a.unit_id, 128),
    lane: pick(a.lane, LANE_KINDS),
    phase: str(a.phase, 32),
    since: int(a.since, 0, 1e15),
  };
}
/** Subset of PROOFS; missing/empty → both. Returns null when present but invalid. */
function cleanProofs(v) {
  if (v == null) return [...PROOFS];
  if (!Array.isArray(v) || v.some((x) => !PROOFS.includes(x))) return null;
  const out = PROOFS.filter((x) => v.includes(x));
  return out.length ? out : [...PROOFS];
}
function suggestRoles(m, lanes) {
  const out = [];
  const big = m.cores >= 64 || m.ram_gb >= 128;
  if ((lanes.claude || lanes.codex) && m.ram_gb >= 16) out.push('thinker');
  if (m.ram_gb >= 32 && m.cores >= 10) out.push('verifier');
  if (big) out.push('anchor', 'canary');
  if (m.ram_gb >= 192) out.push('prover');
  if (m.ram_gb >= 384 && m.cores >= 96) out.push('finisher');
  if (m.ram_gb >= 512) out.push('atlas');
  if (!out.length) out.push('verifier');
  return out;
}

// ---------- the Durable Object ----------

export class Swarm {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.subs = new Set();
    this.beatMs = Number(env.BEAT_MS) || DEFAULT_BEAT_MS;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, handle TEXT, place TEXT,
        machine TEXT, lanes TEXT, roles TEXT, client TEXT,
        status TEXT DEFAULT 'idle', activity TEXT, load TEXT,
        joined_at INTEGER, last_beat INTEGER, left_at INTEGER);
      CREATE TABLE IF NOT EXISTS nonces (node_id TEXT, nonce TEXT, ts INTEGER, PRIMARY KEY (node_id, nonce));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, at INTEGER, data TEXT);
      CREATE TABLE IF NOT EXISTS units (
        id TEXT PRIMARY KEY, track TEXT, kind TEXT, ref TEXT, page INTEGER, deps TEXT, needs TEXT,
        attempts INTEGER DEFAULT 0, state TEXT DEFAULT 'open', updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS leases (
        lease_id TEXT PRIMARY KEY, unit_id TEXT, node_id TEXT, role TEXT,
        created_at INTEGER, expires_at INTEGER, closed_at INTEGER);
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, lease_id TEXT, unit_id TEXT, node_id TEXT, verdict TEXT,
        artifact_sha256 TEXT, summary TEXT, vendor TEXT, model TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS signups (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, data TEXT NOT NULL,
        created_at INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS ratelimit (k TEXT, hour INTEGER, n INTEGER, PRIMARY KEY (k, hour));
    `);
    const cols = this.sql.exec('PRAGMA table_info(nodes)').toArray().map((c) => c.name);
    if (!cols.includes('proofs')) this.sql.exec('ALTER TABLE nodes ADD COLUMN proofs TEXT');
  }

  // ----- events -----

  emit(type, payload) {
    const at = Date.now();
    const data = JSON.stringify(payload);
    const seq = this.sql.exec('INSERT INTO events (type, at, data) VALUES (?, ?, ?) RETURNING seq', type, at, data).one().seq;
    if (seq % 100 === 0) this.sql.exec('DELETE FROM events WHERE seq <= ?', seq - EVENTS_KEEP);
    const rec = { id: seq, type, at, ...payload };
    this.broadcast(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(rec)}\n\n`);
    return seq;
  }

  broadcast(text) {
    const bytes = new TextEncoder().encode(text);
    for (const w of this.subs) w.write(bytes).catch(() => this.subs.delete(w));
  }

  eventsSince(seq, limit) {
    return this.sql.exec('SELECT seq, type, at, data FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?', seq, limit).toArray()
      .map((r) => ({ id: r.seq, type: r.type, at: r.at, ...parseJ(r.data, {}) }));
  }

  lastSeq() {
    return this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM events').one().s;
  }

  // ----- snapshot -----

  publicNode(r, now) {
    const m = parseJ(r.machine, {});
    return {
      node_id: r.node_id,
      handle: r.handle,
      place: r.place,
      roles: parseJ(r.roles, []),
      proofs: parseJ(r.proofs, null) || [...PROOFS],
      status: r.status,
      activity: parseJ(r.activity, null),
      machine: { chip: m.chip, cores: m.cores, ram_gb: m.ram_gb },
      lanes: parseJ(r.lanes, { claude: false, codex: false, local_models: [] }),
      joined_at: r.joined_at,
      last_beat: r.last_beat,
      online: this.isOnline(r, now),
    };
  }

  isOnline(r, now) {
    return !r.left_at && r.last_beat != null && now - r.last_beat <= 3 * this.beatMs;
  }

  state() {
    const now = Date.now();
    const rows = this.sql.exec('SELECT * FROM nodes WHERE last_beat >= ? ORDER BY last_beat DESC LIMIT 2000', now - NODES_LISTED_MS).toArray();
    const nodes = rows.map((r) => this.publicNode(r, now));
    const totals = {
      nodes_online: 0,
      nodes_ever: this.sql.exec('SELECT COUNT(*) AS n FROM nodes').one().n,
      cores: 0, ram_gb: 0,
      lanes: { claude: 0, codex: 0, local: 0 },
      by_role: Object.fromEntries(ROLES.map((r) => [r, 0])),
      by_status: Object.fromEntries(STATUSES.map((s) => [s, 0])),
      by_proof: Object.fromEntries(PROOFS.map((x) => [x, 0])),
    };
    for (const n of nodes) {
      if (!n.online) continue;
      totals.nodes_online++;
      totals.cores += n.machine.cores || 0;
      totals.ram_gb += n.machine.ram_gb || 0;
      if (n.lanes.claude) totals.lanes.claude++;
      if (n.lanes.codex) totals.lanes.codex++;
      if (n.lanes.local_models?.length) totals.lanes.local++;
      for (const r of n.roles) if (r in totals.by_role) totals.by_role[r]++;
      if (n.status in totals.by_status) totals.by_status[n.status]++;
      for (const x of n.proofs) if (x in totals.by_proof) totals.by_proof[x]++;
    }
    totals.ram_gb = Math.round(totals.ram_gb);
    const tracks = Object.fromEntries(TRACKS.map((t) => [t, { units: 0, done: 0, gap: 0, leased: 0 }]));
    for (const r of this.sql.exec('SELECT track, state, COUNT(*) AS n FROM units GROUP BY track, state').toArray()) {
      const t = tracks[r.track];
      if (!t) continue;
      t.units += r.n;
      if (r.state === 'done') t.done += r.n;
      if (r.state === 'gap') t.gap += r.n;
      if (r.state === 'leased') t.leased += r.n;
    }
    const last = this.lastSeq();
    const events = this.eventsSince(Math.max(0, last - STATE_EVENTS), STATE_EVENTS);
    return { at: now, seq: last, beat_ms: this.beatMs, totals, nodes, tracks, events };
  }

  // ----- signed requests -----

  async verifySigned(req, isHello) {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > MAX_BODY) return { err: json({ error: 'too_large' }, 413) };
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > MAX_BODY) return { err: json({ error: 'too_large' }, 413) };
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return { err: json({ error: 'bad_json' }, 400) }; }
    if (!body || typeof body !== 'object') return { err: json({ error: 'bad_json' }, 400) };
    const sigB64 = req.headers.get('x-rh-sig') || '';
    const now = Date.now();
    const ts = Number(body.ts);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > TS_WINDOW_MS) return { err: json({ error: 'bad_ts' }, 401) };
    const nonce = typeof body.nonce === 'string' ? body.nonce : '';
    if (nonce.length < 8 || nonce.length > 64) return { err: json({ error: 'bad_nonce' }, 400) };

    let pubB64, nodeId;
    if (isHello) {
      pubB64 = typeof body.pubkey === 'string' ? body.pubkey : '';
      let raw;
      try { raw = b64ToBytes(pubB64); } catch { raw = null; }
      if (!raw || raw.length !== 32) return { err: json({ error: 'bad_pubkey' }, 400) };
      nodeId = (await sha256Hex(raw)).slice(0, 16);
      if (body.node_id != null && body.node_id !== nodeId) return { err: json({ error: 'node_id_mismatch' }, 400) };
    } else {
      nodeId = typeof body.node_id === 'string' ? body.node_id : '';
      const row = this.sql.exec('SELECT pubkey FROM nodes WHERE node_id = ?', nodeId).toArray()[0];
      if (!row) return { err: json({ error: 'unknown_node' }, 401) };
      pubB64 = row.pubkey;
    }
    let ok = false;
    try {
      const key = await crypto.subtle.importKey('raw', b64ToBytes(pubB64), { name: 'Ed25519' }, false, ['verify']);
      ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64ToBytes(sigB64), bytes);
    } catch { ok = false; }
    if (!ok) return { err: json({ error: 'bad_signature' }, 401) };

    this.sql.exec('DELETE FROM nonces WHERE ts < ?', now - NONCE_WINDOW_MS);
    const seen = this.sql.exec('SELECT 1 FROM nonces WHERE node_id = ? AND nonce = ?', nodeId, nonce).toArray().length;
    if (seen) return { err: json({ error: 'replay' }, 401) };
    this.sql.exec('INSERT INTO nonces (node_id, nonce, ts) VALUES (?, ?, ?)', nodeId, nonce, now);
    return { body, nodeId, pubB64, now };
  }

  hello(v) {
    const { body, nodeId, pubB64, now } = v;
    const machine = cleanMachine(body.machine);
    const lanes = cleanLanes(body.lanes);
    const roles = pickList(body.roles, ROLES);
    const proofs = cleanProofs(body.proofs);
    if (!proofs) return json({ error: 'bad_proofs' }, 400);
    const c = body.client && typeof body.client === 'object' ? body.client : {};
    const client = { name: str(c.name, 32), version: str(c.version, 16), platform: str(c.platform, 16) };
    const prev = this.sql.exec('SELECT handle, joined_at FROM nodes WHERE node_id = ?', nodeId).toArray()[0];
    const handle = str(body.handle, 24, /[^A-Za-z0-9 _.\-]/g) || prev?.handle || genHandle(nodeId);
    const place = str(body.place, 40, /[^\p{L}\p{N} ,.'\-]/gu);
    const joinedAt = prev?.joined_at || now;
    const suggested = suggestRoles(machine, lanes);
    const finalRoles = roles.length ? roles : suggested.slice(0, 1);
    this.sql.exec(
      `INSERT INTO nodes (node_id, pubkey, handle, place, machine, lanes, roles, proofs, client, status, activity, load, joined_at, last_beat, left_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, ?, NULL)
       ON CONFLICT(node_id) DO UPDATE SET handle = excluded.handle, place = excluded.place, machine = excluded.machine,
         lanes = excluded.lanes, roles = excluded.roles, proofs = excluded.proofs, client = excluded.client, status = 'idle', activity = NULL,
         last_beat = excluded.last_beat, left_at = NULL`,
      nodeId, pubB64, handle, place, JSON.stringify(machine), JSON.stringify(lanes), JSON.stringify(finalRoles), JSON.stringify(proofs), JSON.stringify(client), joinedAt, now,
    );
    const row = this.sql.exec('SELECT * FROM nodes WHERE node_id = ?', nodeId).one();
    this.emit('node', { node_id: nodeId, node: this.publicNode(row, now) });
    return json({ node_id: nodeId, handle, roles: finalRoles, proofs, suggested_roles: suggested, beat_ms: this.beatMs });
  }

  beat(v) {
    const { body, nodeId, now } = v;
    const status = pick(body.status, STATUSES) || 'idle';
    const activity = cleanActivity(body.activity);
    let load = null;
    if (body.load && typeof body.load === 'object') {
      load = { cpu: num(body.load.cpu, 0, 1e4), mem_used_gb: num(body.load.mem_used_gb, 0, 65536) };
    }
    const was = this.sql.exec('SELECT left_at FROM nodes WHERE node_id = ?', nodeId).one();
    this.sql.exec('UPDATE nodes SET status = ?, activity = ?, load = ?, last_beat = ?, left_at = NULL WHERE node_id = ?',
      status, activity ? JSON.stringify(activity) : null, load ? JSON.stringify(load) : null, now, nodeId);
    if (was.left_at) {
      const row = this.sql.exec('SELECT * FROM nodes WHERE node_id = ?', nodeId).one();
      this.emit('node', { node_id: nodeId, node: this.publicNode(row, now) });
    }
    this.emit('beat', { node_id: nodeId, status, activity });
    return json({ ok: true });
  }

  expireLeases(now) {
    const stale = this.sql.exec('SELECT lease_id, unit_id FROM leases WHERE closed_at IS NULL AND expires_at < ?', now).toArray();
    for (const l of stale) {
      this.sql.exec('UPDATE leases SET closed_at = ? WHERE lease_id = ?', now, l.lease_id);
      this.sql.exec(`UPDATE units SET state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'open' END, attempts = attempts + 1, updated_at = ?
                     WHERE id = ? AND state = 'leased'`, MAX_ATTEMPTS, now, l.unit_id);
    }
  }

  lease(v) {
    const { body, nodeId, now } = v;
    const node = this.sql.exec('SELECT roles, proofs, machine FROM nodes WHERE node_id = ?', nodeId).one();
    const tracks = new Set((parseJ(node.proofs, null) || PROOFS).flatMap((x) => PROOF_TRACKS[x] || []));
    const role = pick(body.role, ROLES);
    if (!role) return json({ error: 'bad_role' }, 400);
    if (!parseJ(node.roles, []).includes(role)) return json({ error: 'role_not_offered' }, 403);
    this.expireLeases(now);
    const vendor = typeof body.vendor === 'string' ? body.vendor : null;
    const ram = num(parseJ(node.machine, {}).ram_gb) ?? 0;
    const tl = [...tracks];
    if (!tl.length) return json({});
    const candidates = this.sql.exec(`SELECT * FROM units WHERE state = 'open' AND track IN (${tl.map(() => '?').join(',')}) ORDER BY attempts ASC, id ASC LIMIT 500`, ...tl).toArray();
    for (const u of candidates) {
      const needs = parseJ(u.needs, {});
      if (needs.role && needs.role !== role) continue;
      if (needs.ram_gb && ram < needs.ram_gb) continue;
      if (needs.vendor_not && vendor && needs.vendor_not === vendor) continue;
      const deps = parseJ(u.deps, []);
      if (deps.length) {
        const ph = deps.map(() => '?').join(',');
        const done = this.sql.exec(`SELECT COUNT(*) AS n FROM units WHERE state = 'done' AND id IN (${ph})`, ...deps).one().n;
        if (done < deps.length) continue;
      }
      const leaseId = crypto.randomUUID();
      const expires = now + LEASE_MS;
      this.sql.exec("UPDATE units SET state = 'leased', updated_at = ? WHERE id = ?", now, u.id);
      this.sql.exec('INSERT INTO leases (lease_id, unit_id, node_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', leaseId, u.id, nodeId, role, now, expires);
      const unit = unitOut({ ...u, state: 'leased' });
      this.emit('lease', { node_id: nodeId, unit_id: u.id, track: u.track, role });
      return json({ unit, lease_id: leaseId, expires_at: expires });
    }
    return json({});
  }

  result(v) {
    const { body, nodeId, now } = v;
    const l = this.sql.exec('SELECT * FROM leases WHERE lease_id = ?', String(body.lease_id || '')).toArray()[0];
    if (!l || l.node_id !== nodeId || l.unit_id !== body.unit_id) return json({ error: 'unknown_lease' }, 404);
    if (l.closed_at) return json({ error: 'lease_closed' }, 409);
    const verdict = pick(body.verdict, VERDICTS);
    if (!verdict) return json({ error: 'bad_verdict' }, 400);
    const sha = typeof body.artifact_sha256 === 'string' && /^[0-9a-f]{64}$/.test(body.artifact_sha256) ? body.artifact_sha256 : null;
    this.sql.exec('UPDATE leases SET closed_at = ? WHERE lease_id = ?', now, l.lease_id);
    this.sql.exec(`INSERT INTO results (lease_id, unit_id, node_id, verdict, artifact_sha256, summary, vendor, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      l.lease_id, l.unit_id, nodeId, verdict, sha, str(body.summary, 2000), str(body.vendor, 32), str(body.model, 64), now);
    if (verdict === 'ok') this.sql.exec("UPDATE units SET state = 'done', updated_at = ? WHERE id = ?", now, l.unit_id);
    else if (verdict === 'gap') this.sql.exec("UPDATE units SET state = 'gap', updated_at = ? WHERE id = ?", now, l.unit_id);
    else if (verdict === 'skip') this.sql.exec("UPDATE units SET state = 'open', updated_at = ? WHERE id = ?", now, l.unit_id);
    else this.sql.exec(`UPDATE units SET attempts = attempts + 1, state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'open' END, updated_at = ? WHERE id = ?`, MAX_ATTEMPTS, now, l.unit_id);
    const track = this.sql.exec('SELECT track FROM units WHERE id = ?', l.unit_id).toArray()[0]?.track ?? null;
    this.emit('result', { node_id: nodeId, unit_id: l.unit_id, track, verdict });
    return json({ ok: true });
  }

  bye(v) {
    const { nodeId, now } = v;
    this.sql.exec('UPDATE nodes SET left_at = ?, activity = NULL WHERE node_id = ?', now, nodeId);
    const open = this.sql.exec('SELECT lease_id, unit_id FROM leases WHERE node_id = ? AND closed_at IS NULL', nodeId).toArray();
    for (const l of open) {
      this.sql.exec('UPDATE leases SET closed_at = ? WHERE lease_id = ?', now, l.lease_id);
      this.sql.exec("UPDATE units SET state = 'open', updated_at = ? WHERE id = ? AND state = 'leased'", now, l.unit_id);
    }
    this.emit('bye', { node_id: nodeId });
    return json({ ok: true });
  }

  // ----- admin -----

  isAdmin(req) {
    const tok = this.env.RH_ADMIN_TOKEN || '';
    const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    return tok.length >= 16 && timingSafeEqual(got, tok);
  }

  async adminUnits(req) {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const units = Array.isArray(body?.units) ? body.units.slice(0, 5000) : null;
    if (!units) return json({ error: 'units_required' }, 400);
    const now = Date.now();
    let upserted = 0;
    const rejected = [];
    for (const u of units) {
      const id = str(u?.id, 128);
      const track = pick(u?.track, TRACKS);
      const kind = pick(u?.kind, UNIT_KINDS);
      if (!id || !track || !kind) { rejected.push(u?.id ?? null); continue; }
      const needs = u.needs && typeof u.needs === 'object'
        ? { role: pick(u.needs.role, ROLES), vendor_not: str(u.needs.vendor_not, 16), ram_gb: num(u.needs.ram_gb, 0, 65536) }
        : {};
      const deps = Array.isArray(u.deps) ? u.deps.map((d) => str(d, 128)).filter(Boolean).slice(0, 500) : [];
      const state = pick(u.state, UNIT_STATES) || 'open';
      this.sql.exec(
        `INSERT INTO units (id, track, kind, ref, page, deps, needs, attempts, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET track = excluded.track, kind = excluded.kind, ref = excluded.ref, page = excluded.page,
           deps = excluded.deps, needs = excluded.needs, attempts = excluded.attempts, state = excluded.state, updated_at = excluded.updated_at`,
        id, track, kind, str(u.ref, 256), int(u.page, 0, 1e6), JSON.stringify(deps), JSON.stringify(needs), int(u.attempts, 0, 1e6) ?? 0, state, now,
      );
      upserted++;
    }
    return json({ ok: true, upserted, rejected });
  }

  // ----- signups -----

  async signup(req) {
    const ip = req.headers.get('x-rh-ip') || 'unknown';
    const k = (await sha256Hex(`rh-signup:${ip}`)).slice(0, 32);
    const hour = Math.floor(Date.now() / 3600_000);
    this.sql.exec('DELETE FROM ratelimit WHERE hour < ?', hour - 1);
    const used = this.sql.exec('SELECT n FROM ratelimit WHERE k = ? AND hour = ?', k, hour).toArray()[0]?.n ?? 0;
    if (used >= SIGNUP_LIMIT_PER_HOUR) return pub({ error: 'rate_limited' }, 429);
    this.sql.exec('INSERT INTO ratelimit (k, hour, n) VALUES (?, ?, 1) ON CONFLICT(k, hour) DO UPDATE SET n = n + 1', k, hour);

    if (Number(req.headers.get('content-length') || 0) > 16_384) return pub({ error: 'too_large' }, 413);
    let b;
    try { b = await req.json(); } catch { return pub({ error: 'bad_json' }, 400); }
    const res = validateSignup(b);
    if (res.error) return pub({ error: res.error }, 400);
    const s = res.signup;
    const now = Date.now();
    const prev = this.sql.exec('SELECT id FROM signups WHERE email = ?', s.email).toArray()[0];
    let id;
    if (prev) {
      this.sql.exec('UPDATE signups SET data = ?, updated_at = ? WHERE id = ?', JSON.stringify(s), now, prev.id);
      id = prev.id;
    } else {
      id = this.sql.exec('INSERT INTO signups (email, data, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id', s.email, JSON.stringify(s), now, now).one().id;
    }
    const position = this.sql.exec('SELECT COUNT(*) AS n FROM signups WHERE id <= ?', id).one().n;
    return pub({ ok: true, position, updated: !!prev });
  }

  signupCount() {
    const t = { total: 0, macs: 0, big_machines: 0, claude: 0, codex: 0, cores: 0, ram_gb: 0, by_proof: Object.fromEntries(PROOFS.map((x) => [x, 0])) };
    for (const r of this.sql.exec('SELECT data FROM signups').toArray()) {
      const s = parseJ(r.data, null);
      if (!s?.machine) continue;
      t.total++;
      if (s.machine.kind === 'mac') t.macs++;
      if (s.machine.kind === 'big') t.big_machines++;
      t.cores += s.machine.cores || 0;
      t.ram_gb += s.machine.ram_gb || 0;
      if (s.claude && s.claude !== 'none') t.claude++;
      if (s.codex && s.codex !== 'none') t.codex++;
      for (const x of s.proofs || PROOFS) if (x in t.by_proof) t.by_proof[x]++;
    }
    t.ram_gb = Math.round(t.ram_gb);
    return t;
  }

  signupRows() {
    return this.sql.exec('SELECT id, email, data, created_at, updated_at FROM signups ORDER BY id ASC').toArray()
      .map((r) => ({ id: r.id, ...parseJ(r.data, {}), email: r.email, created_at: r.created_at, updated_at: r.updated_at }));
  }

  // ----- SSE -----

  events(req) {
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const lastId = Number(req.headers.get('last-event-id') || new URL(req.url).searchParams.get('last_event_id') || 0);
    w.write(enc.encode('retry: 3000\n\n'));
    const oldest = this.sql.exec('SELECT COALESCE(MIN(seq), 0) AS s FROM events').one().s;
    if (lastId > 0 && lastId >= oldest - 1 && lastId <= this.lastSeq()) {
      for (const e of this.eventsSince(lastId, EVENTS_KEEP)) w.write(enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    } else {
      const st = this.state();
      w.write(enc.encode(`id: ${st.seq}\nevent: snapshot\ndata: ${JSON.stringify(st)}\n\n`));
    }
    this.subs.add(w);
    const ping = setInterval(() => w.write(enc.encode(`: ping ${Date.now()}\n\n`)).catch(() => { clearInterval(ping); this.subs.delete(w); }), 15_000);
    req.signal?.addEventListener?.('abort', () => { clearInterval(ping); this.subs.delete(w); w.close().catch(() => {}); });
    return new Response(readable, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', ...CORS },
    });
  }

  // ----- router -----

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    try {
      if (m === 'POST' && ['/api/hello', '/api/beat', '/api/lease', '/api/result', '/api/bye'].includes(p)) {
        const v = await this.verifySigned(req, p === '/api/hello');
        if (v.err) return v.err;
        if (p === '/api/hello') return this.hello(v);
        if (p === '/api/beat') return this.beat(v);
        if (p === '/api/lease') return this.lease(v);
        if (p === '/api/result') return this.result(v);
        return this.bye(v);
      }
      if (m === 'GET' && p === '/api/state') return pub(this.state());
      if (m === 'GET' && p === '/api/events') return this.events(req);
      if (m === 'POST' && p === '/api/signup') return await this.signup(req);
      if (m === 'GET' && p === '/api/signups/count') return pub(this.signupCount());
      if (p.startsWith('/api/admin/')) {
        if (!this.isAdmin(req)) return json({ error: 'unauthorized' }, 401);
        if (m === 'POST' && p === '/api/admin/units') return await this.adminUnits(req);
        if (m === 'GET' && p === '/api/admin/signups') {
          const rows = this.signupRows();
          if (url.searchParams.get('format') === 'csv') {
            return new Response(signupsCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="signups.csv"' } });
          }
          return json({ total: rows.length, signups: rows });
        }
        if (m === 'DELETE' && p === '/api/admin/signups') {
          const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
          if (!email) return json({ error: 'email_required' }, 400);
          const n = this.sql.exec('DELETE FROM signups WHERE email = ? RETURNING id', email).toArray().length;
          return json({ ok: true, deleted: n });
        }
      }
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: 'internal', detail: String(e?.message || e).slice(0, 200) }, 500);
    }
  }
}

function unitOut(u) {
  return {
    id: u.id, track: u.track, kind: u.kind, ref: u.ref, page: u.page,
    deps: parseJ(u.deps, []), needs: parseJ(u.needs, {}), attempts: u.attempts, state: u.state,
  };
}

const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

function validateSignup(b) {
  // Essentials only (PROTOCOL.md "Signup"). Any other field is ignored and never stored.
  if (!b || typeof b !== 'object') return { error: 'bad_body' };
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL_RE.test(email)) return { error: 'bad_email' };
  const m = b.machine && typeof b.machine === 'object' ? b.machine : null;
  const kind = pick(m?.kind, SIGNUP_MACHINE_KINDS);
  if (!kind) return { error: 'bad_machine_kind' };
  const ram = num(m.ram_gb, 1, 65536);
  if (ram == null) return { error: 'bad_ram_gb' };
  const cores = m.cores == null || m.cores === '' ? null : int(m.cores, 1, 4096);
  if (m.cores != null && m.cores !== '' && cores == null) return { error: 'bad_cores' };
  const claude = pick(b.claude, CLAUDE_PLANS);
  if (!claude) return { error: 'bad_claude' };
  const codex = pick(b.codex, CODEX_PLANS);
  if (!codex) return { error: 'bad_codex' };
  let expert = null;
  if (b.expert != null && b.expert !== '') {
    expert = pick(b.expert, SIGNUP_EXPERT);
    if (!expert) return { error: 'bad_expert' };
  }
  const proofs = cleanProofs(b.proofs);
  if (!proofs) return { error: 'bad_proofs' };
  return { signup: { email, machine: { kind, ram_gb: ram, cores }, claude, codex, expert, proofs } };
}

function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function signupsCsv(rows) {
  const cols = ['id', 'email', 'machine_kind', 'ram_gb', 'cores', 'claude', 'codex', 'expert', 'proofs', 'created_at', 'updated_at'];
  const lines = [cols.join(',')];
  for (const r of rows) {
    const flat = {
      id: r.id, email: r.email, machine_kind: r.machine?.kind, ram_gb: r.machine?.ram_gb, cores: r.machine?.cores,
      claude: r.claude, codex: r.codex, expert: r.expert, proofs: (r.proofs || PROOFS).join(';'),
      created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
      updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    };
    lines.push(cols.map((c) => csvCell(flat[c])).join(','));
  }
  return lines.join('\n') + '\n';
}
