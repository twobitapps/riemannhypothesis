/**
 * riemann-swarm — coordinator for the Riemann swarm (docs/PROTOCOL.md v1).
 *
 * The Worker routes every /api/* call to ONE SQLite Durable Object ("Swarm"),
 * which holds nodes, units, leases, results, cards, the board and the
 * signup list. Heartbeats, nonces and the event log live in memory (write budget). Node calls (hello/beat/lease/result/bye) are Ed25519-signed over
 * the exact request body bytes. Public reads (state, events, signups/count)
 * never carry emails, IPs, tokens or public keys.
 *
 * SSE uses Last-Event-ID replay; onboarding text is bundled at deploy time.
 */
import JOIN_SH from '../../client/join.sh';
import AGENTS_MD from '../../AGENTS.md';
import * as atlas from './atlas.js';
import * as board from './board.js';
import * as recall from './recall.js';
import * as replay from './replay.js';
import { handleSignups } from './signups.js';
import { searchModules } from './search.js';
import * as trust from './trust.js';
import * as ledger from './ledger.js';

const DEFAULT_BEAT_MS = 20_000;
const TS_WINDOW_MS = 5 * 60_000;
const NONCE_WINDOW_MS = 10 * 60_000;
const EVENTS_KEEP = 1000;
const STATE_EVENTS = 200;
const LEASE_MS = 30 * 60_000;
const MAX_BODY = 256 * 1024;
const MAX_LEASES_PER_NODE = 3;
const SIGNUP_LIMIT_PER_HOUR = 5;
const MAX_ATTEMPTS = 6;
const NODES_LISTED_MS = 7 * 24 * 3600_000;
// Write budget: heartbeats, online status, nonces and the event log live in
// memory. Node rows are flushed at most once per node per FLUSH_MS (and on
// hello/bye); leases, results, cards and posts are rows. See PROTOCOL.md.
const FLUSH_MS = 10 * 60_000;
const SCHEMA_VERSION = 9;

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
const GITHUB_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const CORS = { 'access-control-allow-origin': '*' };
const TEXT = (type) => ({ 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', ...CORS });

export default {
  async fetch(req, env, ctx) {
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
      // The site's own server code (never the public pass-through, which does
      // not forward this header) marks its calls with x-rh-site: 1.
      const site = viaProxy && req.headers.get('x-rh-site') === '1';
      h.delete('x-rh-site');
      h.delete('x-rh-trusted');
      if (site) h.set('x-rh-trusted', '1');
      const ip = (viaProxy ? (req.headers.get('x-rh-client-ip') || '').split(',')[0].trim() : '') || req.headers.get('cf-connecting-ip') || 'unknown';
      h.set('x-rh-ip', ip.slice(0, 64));
      // Signups live in D1, apart from the swarm's Durable Object.
      const tok = env.RH_ADMIN_TOKEN || '';
      const isAdm = admin && tok.length >= 16 && timingSafeEqual((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), tok);
      const sr = await handleSignups(req, env, ctx, { ip: ip.slice(0, 64), admin: isAdm, json, pub, validateSignup, signupsCsv, PROOFS });
      if (sr) return sr;
      if (req.method === 'GET' && p === '/api/search') return pub(await searchModules(env, url.searchParams.get('q'), 20));
      const stub = env.SWARM.get(env.SWARM.idFromName('swarm'));
      return stub.fetch(new Request(req, { headers: h }));
    }
    if (p === '/join.sh') return new Response(JOIN_SH.replaceAll('__RH_COORDINATOR__', api), { headers: TEXT('text/x-shellscript') });
    if (p === '/agent.md') return new Response(agentDoc(api), { headers: TEXT('text/markdown') });
    if (p === '/llms.txt' || p === '/') return new Response(llmsTxt(api), { headers: TEXT('text/plain') });
    return json({ error: 'not_found' }, 404);
  },

  /** Hourly: export the signed record to the ledger branches (no-op without GITHUB_LEDGER_TOKEN). */
  async scheduled(event, env, ctx) {
    if (env.LEDGER_HOURLY !== '1') return;
    const stub = env.SWARM.get(env.SWARM.idFromName('swarm'));
    ctx.waitUntil(stub.fetch(new Request('https://swarm/api/admin/ledger', { method: 'POST', headers: { authorization: `Bearer ${env.RH_ADMIN_TOKEN}` } })));
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
    this.live = new Map();    // node_id -> { status, activity, load, last_beat, flushed_at, left? }
    this.nonces = new Map();  // node_id -> Map(nonce -> ts)
    this.pubkeys = new Map(); // node_id -> pubkey (read-through cache)
    this.ring = [];           // last EVENTS_KEEP events, in memory only
    this.startedAt = Date.now();
    this.seq = this.startedAt; // event ids keep increasing across restarts
    try { this.migrate(); } catch (e) { this.initError = String(e?.message || e); }
  }

  /** Schema setup runs only when the stored version is older: a normal start writes nothing. */
  migrate() {
    let v = 0;
    try { v = Number(this.sql.exec("SELECT v FROM schema_meta WHERE k = 'version'").toArray()[0]?.v) || 0; } catch { v = 0; }
    if (v >= SCHEMA_VERSION) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, handle TEXT, place TEXT,
        machine TEXT, lanes TEXT, roles TEXT, client TEXT,
        status TEXT DEFAULT 'idle', activity TEXT, load TEXT,
        joined_at INTEGER, last_beat INTEGER, left_at INTEGER);
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
      DROP TABLE IF EXISTS nonces;
      DROP TABLE IF EXISTS events;
    `);
    const cols = this.sql.exec('PRAGMA table_info(nodes)').toArray().map((c) => c.name);
    if (!cols.includes('proofs')) this.sql.exec('ALTER TABLE nodes ADD COLUMN proofs TEXT');
    if (!cols.includes('github')) this.sql.exec('ALTER TABLE nodes ADD COLUMN github TEXT');
    this.sql.exec('CREATE INDEX IF NOT EXISTS leases_unit ON leases (unit_id)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS leases_node ON leases (node_id, closed_at)');
    atlas.initAtlas(this.sql);
    board.initBoard(this.sql);
    replay.initReplay(this.sql);
    this.sql.exec('CREATE TABLE IF NOT EXISTS blobs (name TEXT, part INTEGER, parts INTEGER, data BLOB, PRIMARY KEY (name, part))');
    this.sql.exec('CREATE INDEX IF NOT EXISTS leases_open ON leases (closed_at, expires_at)');
    if (v < 6) {
      trust.initTrust(this.sql);
      this.reevaluate();
    }
    if (v < 9) ledger.initLedger(this.sql);
    if (v < 7) {
      const nc = this.sql.exec('PRAGMA table_info(nodes)').toArray().map((c) => c.name);
      if (!nc.includes('counters')) this.sql.exec('ALTER TABLE nodes ADD COLUMN counters TEXT');
    }
    this.sql.exec("INSERT INTO schema_meta (k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(SCHEMA_VERSION));
  }

  // ----- events -----

  emit(type, payload) {
    const at = Date.now();
    const seq = this.seq = Math.max(this.seq + 1, at);
    const rec = { id: seq, type, at, ...payload };
    this.ring.push(rec);
    if (this.ring.length > EVENTS_KEEP) this.ring.splice(0, this.ring.length - EVENTS_KEEP);
    this.broadcast(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(rec)}\n\n`);
    return seq;
  }

  broadcast(text) {
    const bytes = new TextEncoder().encode(text);
    for (const w of this.subs) w.write(bytes).catch(() => this.subs.delete(w));
  }

  eventsSince(seq, limit) {
    return this.ring.filter((e) => e.id > seq).slice(0, limit);
  }

  lastSeq() {
    return this.ring.length ? this.ring[this.ring.length - 1].id : 0;
  }

  /** A node's row with its in-memory heartbeat state laid over it. */
  withLive(r) {
    const l = this.live.get(r.node_id);
    if (!l || r.left_at) return r;
    return { ...r, status: l.status, activity: l.activity ? JSON.stringify(l.activity) : null, last_beat: l.last_beat };
  }

  // ----- snapshot -----

  publicNode(r, now) {
    const m = parseJ(r.machine, {});
    return {
      node_id: r.node_id,
      handle: r.handle,
      github: r.github || null,
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
    const rows = this.sql.exec('SELECT * FROM nodes WHERE last_beat >= ? ORDER BY last_beat DESC LIMIT 2000', now - NODES_LISTED_MS).toArray()
      .map((r) => this.withLive(r)).sort((a, b) => (b.last_beat || 0) - (a.last_beat || 0));
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
    for (const r of this.cached('unit_counts', 60_000, () => this.sql.exec('SELECT track, state, COUNT(*) AS n FROM units GROUP BY track, state').toArray())) {
      const t = tracks[r.track];
      if (!t) continue;
      t.units += r.n;
      if (r.state === 'done') t.done += r.n;
      if (r.state === 'gap') t.gap += r.n;
      if (r.state === 'leased') t.leased += r.n;
    }
    tracks.A.leased += this.sql.exec("SELECT COUNT(*) AS n FROM leases l JOIN units u ON u.id = l.unit_id WHERE u.kind = 'card' AND l.closed_at IS NULL AND l.expires_at >= ?", now).one().n;
    tracks.A.cards = this.sql.exec('SELECT COUNT(DISTINCT module) AS n FROM cards').one().n;
    tracks.A.posts = this.sql.exec('SELECT COUNT(*) AS n FROM posts').one().n;
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
      pubB64 = this.pubkeys.get(nodeId);
      if (!pubB64) {
        const row = this.sql.exec('SELECT pubkey FROM nodes WHERE node_id = ?', nodeId).toArray()[0];
        if (!row) return { err: json({ error: 'unknown_node' }, 401) };
        pubB64 = row.pubkey;
        this.pubkeys.set(nodeId, pubB64);
      }
    }
    let ok = false;
    try {
      const key = await crypto.subtle.importKey('raw', b64ToBytes(pubB64), { name: 'Ed25519' }, false, ['verify']);
      ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64ToBytes(sigB64), bytes);
    } catch { ok = false; }
    if (!ok) return { err: json({ error: 'bad_signature' }, 401) };

    // Replay protection in memory: nonces seen in the last NONCE_WINDOW_MS per
    // node. After a restart the map is empty, so anything signed before this
    // object started is refused (the ts window already bounds the rest).
    if (ts < this.startedAt - 1000) return { err: json({ error: 'bad_ts', retry: true }, 401) };
    let seen = this.nonces.get(nodeId);
    if (!seen) this.nonces.set(nodeId, (seen = new Map()));
    for (const [n, t] of seen) if (t < now - NONCE_WINDOW_MS) seen.delete(n);
    if (seen.has(nonce)) return { err: json({ error: 'replay' }, 401) };
    seen.set(nonce, now);
    return { body, nodeId, pubB64, now, raw: new TextDecoder().decode(bytes), sig: sigB64, ip: req.headers.get('x-rh-ip') || null };
  }

  /**
   * Once, when the independence rules arrived: acceptances whose nodes were
   * not independent (runs recorded before client networks were) go back to
   * pending, and their board labels are cleared.
   */
  reevaluate() {
    const now = Date.now();
    for (const u of this.sql.exec("SELECT DISTINCT unit_id FROM card_runs WHERE status = 'agreed' AND (ip24 IS NULL OR ip24 = 'unknown')").toArray()) {
      atlas.reopenUnit(this, u.unit_id, now, 'reevaluate');
    }
    for (const u of this.sql.exec("SELECT DISTINCT unit_id FROM receipts WHERE status = 'agreed' AND (ip24 IS NULL OR ip24 = 'unknown')").toArray()) {
      this.sql.exec("UPDATE receipts SET status = 'pending' WHERE unit_id = ? AND status = 'agreed'", u.unit_id);
      this.sql.exec("UPDATE units SET state = 'open', updated_at = ? WHERE id = ?", now, u.unit_id);
    }
    this.sql.exec("UPDATE posts SET fixed_label = NULL WHERE fixed_label = 'kernel' AND refs LIKE '%R:pk:%'");
  }

  /** Who did this work: client network and GitHub account, for independence checks. */
  ident(v) {
    const n = this.sql.exec('SELECT gh_login, gh_created_at FROM nodes WHERE node_id = ?', v.nodeId).toArray()[0];
    return { ip24: trust.ip24(v.ip), gh: n?.gh_login || null };
  }

  async hello(v) {
    const { body, nodeId, pubB64, now } = v;
    const machine = cleanMachine(body.machine);
    const lanes = cleanLanes(body.lanes);
    const roles = pickList(body.roles, ROLES);
    const proofs = cleanProofs(body.proofs);
    if (!proofs) return json({ error: 'bad_proofs' }, 400);
    const c = body.client && typeof body.client === 'object' ? body.client : {};
    const client = { name: str(c.name, 32), version: str(c.version, 16), platform: str(c.platform, 16) };
    const prev = this.sql.exec('SELECT handle, joined_at FROM nodes WHERE node_id = ?', nodeId).toArray()[0];
    const net = trust.ip24(v.ip);
    if (!prev) {
      // Permissionless, with a cost: proof of work once per key, and per-network caps.
      if (!(await trust.powOk(pubB64, body.pow_nonce))) return json({ error: 'pow_required', bits: trust.POW_BITS }, 400);
      const day = Math.floor(now / 86_400_000);
      const made = this.sql.exec('SELECT n FROM ip_new WHERE ip24 = ? AND day = ?', net, day).toArray()[0]?.n ?? 0;
      if (made >= trust.NEW_PER_IP_DAY) return json({ error: 'too_many_new_nodes_from_network', max: trust.NEW_PER_IP_DAY }, 429);
      this.sql.exec('INSERT INTO ip_new (ip24, day, n) VALUES (?, ?, 1) ON CONFLICT(ip24, day) DO UPDATE SET n = n + 1', net, day);
    }
    let activeHere = 0;
    for (const [id, l] of this.live) if (id !== nodeId && !l.left && l.ip24 === net && now - l.last_beat <= 3 * this.beatMs) activeHere++;
    if (activeHere >= trust.ACTIVE_PER_IP) return json({ error: 'too_many_active_nodes_from_network', max: trust.ACTIVE_PER_IP }, 429);
    const handle = str(body.handle, 24, /[^A-Za-z0-9 _.\-]/g) || prev?.handle || genHandle(nodeId);
    const place = str(body.place, 40, /[^\p{L}\p{N} ,.'\-]/gu);
    let github = null;
    if (body.github != null && body.github !== '') {
      github = typeof body.github === 'string' ? body.github.trim().replace(/^@/, '') : '';
      if (!GITHUB_RE.test(github) || github.includes('--')) return json({ error: 'bad_github' }, 400);
    }
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
    this.sql.exec('UPDATE nodes SET github = ?, ip24 = ? WHERE node_id = ?', github, net, nodeId);
    this.pubkeys.set(nodeId, pubB64);
    this.live.set(nodeId, { status: 'idle', activity: null, load: null, last_beat: now, flushed_at: now, ip24: net });
    const row = this.sql.exec('SELECT * FROM nodes WHERE node_id = ?', nodeId).one();
    this.emit('node', { node_id: nodeId, node: this.publicNode(row, now) });
    return json({ node_id: nodeId, handle, github, roles: finalRoles, proofs, suggested_roles: suggested, beat_ms: this.beatMs });
  }

  beat(v) {
    const { body, nodeId, now } = v;
    const status = pick(body.status, STATUSES) || 'idle';
    const activity = cleanActivity(body.activity);
    let load = null;
    if (body.load && typeof body.load === 'object') {
      load = { cpu: num(body.load.cpu, 0, 1e4), mem_used_gb: num(body.load.mem_used_gb, 0, 65536) };
    }
    const prev = this.live.get(nodeId);
    // Self-reported lane counters (calls, tokens, API-equivalent cost): published as totals, never trusted for anything else.
    let counters = prev?.counters || null;
    if (body.counters && typeof body.counters === 'object') {
      counters = {};
      for (const k of ['calls', 'failed_calls', 'cost_usd', 'input_tokens', 'output_tokens', 'cache_tokens', 'cycles', 'discarded']) {
        const n = num(body.counters[k], 0, 1e12);
        if (n != null) counters[k] = n;
      }
    }
    const wasLeft = prev ? !!prev.left : !!this.sql.exec('SELECT left_at FROM nodes WHERE node_id = ?', nodeId).one().left_at;
    const flush = wasLeft || !prev || now - prev.flushed_at >= FLUSH_MS;
    this.live.set(nodeId, { status, activity, load, last_beat: now, flushed_at: flush ? now : prev.flushed_at, ip24: prev?.ip24 || trust.ip24(v.ip), counters });
    if (flush) {
      this.sql.exec('UPDATE nodes SET status = ?, activity = ?, load = ?, last_beat = ?, left_at = NULL, counters = ? WHERE node_id = ?',
        status, activity ? JSON.stringify(activity) : null, load ? JSON.stringify(load) : null, now, counters ? JSON.stringify(counters) : null, nodeId);
    }
    if (wasLeft) {
      const row = this.sql.exec('SELECT * FROM nodes WHERE node_id = ?', nodeId).one();
      this.emit('node', { node_id: nodeId, node: this.publicNode(row, now) });
    }
    this.emit('beat', { node_id: nodeId, status, activity });
    return json({ ok: true });
  }

  expireLeases(now) {
    if (this.lastExpire && now - this.lastExpire < 60_000) return;
    this.lastExpire = now;
    const stale = this.sql.exec('SELECT lease_id, unit_id FROM leases WHERE closed_at IS NULL AND expires_at < ?', now).toArray();
    for (const l of stale) {
      this.sql.exec('UPDATE leases SET closed_at = ? WHERE lease_id = ?', now, l.lease_id);
      this.sql.exec(`UPDATE units SET state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'open' END, attempts = attempts + 1, updated_at = ?
                     WHERE id = ? AND state = 'leased'`, MAX_ATTEMPTS, now, l.unit_id);
    }
  }

  async lease(v) {
    const { body, nodeId, now } = v;
    const node = this.sql.exec('SELECT roles, proofs, machine FROM nodes WHERE node_id = ?', nodeId).one();
    const tracks = new Set((parseJ(node.proofs, null) || PROOFS).flatMap((x) => PROOF_TRACKS[x] || []));
    const role = pick(body.role, ROLES);
    if (!role) return json({ error: 'bad_role' }, 400);
    if (!parseJ(node.roles, []).includes(role)) return json({ error: 'role_not_offered' }, 403);
    this.expireLeases(now);
    const held = this.sql.exec('SELECT COUNT(*) AS n FROM leases WHERE node_id = ? AND closed_at IS NULL AND expires_at >= ?', nodeId, now).one().n;
    if (held >= MAX_LEASES_PER_NODE) return json({ error: 'lease_cap', held, max: MAX_LEASES_PER_NODE }, 429);
    const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k) => UNIT_KINDS.includes(k)) : null;
    const tier = trust.tierOf(this.sql, nodeId);
    if (tier === 'quarantined') return json({ error: 'quarantined' }, 403);
    if (tracks.has('A') && role === 'thinker' && (!kinds || kinds.includes('card'))) {
      const pick = await atlas.pickCardUnit(this.sql, nodeId, now, tier);
      if (pick) {
        const leaseId = crypto.randomUUID();
        const expires = now + LEASE_MS;
        this.sql.exec('INSERT INTO leases (lease_id, unit_id, node_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', leaseId, pick.unit.id, nodeId, role, now, expires);
        this.emit('lease', { node_id: nodeId, unit_id: pick.unit.id, track: 'A', role });
        return json({ unit: unitOut(pick.unit), payload: pick.payload, lease_id: leaseId, expires_at: expires });
      }
      if (kinds && !kinds.includes('rebuild')) return json({});
    }
    if (tracks.has('R') && (role === 'verifier' || role === 'anchor') && kinds && kinds.includes('rebuild')) {
      const pick = replay.pickRebuildUnit(this.sql, nodeId, now);
      if (pick) {
        const leaseId = crypto.randomUUID();
        const expires = now + LEASE_MS * 4; // a packet build can take a while
        this.sql.exec('INSERT INTO leases (lease_id, unit_id, node_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', leaseId, pick.unit.id, nodeId, role, now, expires);
        this.emit('lease', { node_id: nodeId, unit_id: pick.unit.id, track: 'R', role });
        return json({ unit: unitOut(pick.unit), payload: pick.payload, lease_id: leaseId, expires_at: expires });
      }
      return json({});
    }
    const vendor = typeof body.vendor === 'string' ? body.vendor : null;
    const ram = num(parseJ(node.machine, {}).ram_gb) ?? 0;
    const tl = [...tracks];
    if (!tl.length) return json({});
    const candidates = this.sql.exec(`SELECT * FROM units WHERE state = 'open' AND kind NOT IN ('card', 'rebuild') AND track IN (${tl.map(() => '?').join(',')}) ORDER BY attempts ASC, id ASC LIMIT 500`, ...tl).toArray();
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

  async result(v) {
    const { body, nodeId, now } = v;
    const l = this.sql.exec('SELECT * FROM leases WHERE lease_id = ?', String(body.lease_id || '')).toArray()[0];
    if (!l || l.node_id !== nodeId || l.unit_id !== body.unit_id) return json({ error: 'unknown_lease' }, 404);
    if (l.closed_at) return json({ error: 'lease_closed' }, 409);
    const unitRow = this.sql.exec('SELECT * FROM units WHERE id = ?', l.unit_id).toArray()[0];
    if (unitRow?.kind === 'rebuild' && unitRow.track === 'R' && body.verdict !== 'skip') {
      this.sql.exec('UPDATE leases SET closed_at = ? WHERE lease_id = ?', now, l.lease_id);
      const r = await replay.rebuildResult(this, { lease: l, unit: unitRow, nodeId, body, now, ident: this.ident(v) });
      this.sql.exec('UPDATE receipts SET raw = ?, sig = ? WHERE lease_id = ?', v.raw, v.sig, l.lease_id);
      this.emit('result', { node_id: nodeId, unit_id: l.unit_id, track: 'R', verdict: r.verdict });
      return json({ ok: true, ...r });
    }
    if (unitRow?.kind === 'card' && unitRow.track === 'A' && body.verdict !== 'skip') {
      this.sql.exec('UPDATE leases SET closed_at = ? WHERE lease_id = ?', now, l.lease_id);
      const r = atlas.cardResult(this, { lease: l, unit: unitRow, nodeId, body, now, ident: this.ident(v) });
      this.sql.exec('UPDATE card_runs SET raw = ?, sig = ? WHERE lease_id = ?', v.raw, v.sig, l.lease_id);
      this.emit('result', { node_id: nodeId, unit_id: l.unit_id, track: 'A', verdict: r.verdict });
      if (r.accepted) this.postAcceptedCards(unitRow.id);
      return json({ ok: true, ...r });
    }
    const verdict = pick(body.verdict, VERDICTS);
    if (!verdict) return json({ error: 'bad_verdict' }, 400);
    const sha = typeof body.artifact_sha256 === 'string' && /^[0-9a-f]{64}$/.test(body.artifact_sha256) ? body.artifact_sha256 : null;
    this.sql.exec('UPDATE leases SET closed_at = ? WHERE lease_id = ?', now, l.lease_id);
    this.sql.exec(`INSERT INTO results (lease_id, unit_id, node_id, verdict, artifact_sha256, summary, vendor, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      l.lease_id, l.unit_id, nodeId, verdict, sha, str(body.summary, 2000), str(body.vendor, 32), str(body.model, 64), now);
    if (verdict === 'ok') this.sql.exec("UPDATE units SET state = 'done', updated_at = ? WHERE id = ?", now, l.unit_id);
    else if (verdict === 'gap') this.sql.exec("UPDATE units SET state = 'gap', updated_at = ? WHERE id = ?", now, l.unit_id);
    else if (verdict === 'skip') this.sql.exec("UPDATE units SET state = 'open', updated_at = ? WHERE id = ? AND state = 'leased'", now, l.unit_id);
    else this.sql.exec(`UPDATE units SET attempts = attempts + 1, state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'open' END, updated_at = ? WHERE id = ?`, MAX_ATTEMPTS, now, l.unit_id);
    const track = this.sql.exec('SELECT track FROM units WHERE id = ?', l.unit_id).toArray()[0]?.track ?? null;
    this.emit('result', { node_id: nodeId, unit_id: l.unit_id, track, verdict });
    return json({ ok: true });
  }

  bye(v) {
    const { nodeId, now } = v;
    this.sql.exec("UPDATE nodes SET left_at = ?, activity = NULL, status = 'idle' WHERE node_id = ?", now, nodeId);
    this.live.set(nodeId, { status: 'idle', activity: null, load: null, last_beat: now, flushed_at: now, left: true });
    const open = this.sql.exec('SELECT lease_id, unit_id FROM leases WHERE node_id = ? AND closed_at IS NULL', nodeId).toArray();
    for (const l of open) {
      this.sql.exec('UPDATE leases SET closed_at = ? WHERE lease_id = ?', now, l.lease_id);
      this.sql.exec("UPDATE units SET state = 'open', updated_at = ? WHERE id = ? AND state = 'leased'", now, l.unit_id);
    }
    this.emit('bye', { node_id: nodeId });
    return json({ ok: true });
  }

  /** Best-effort follow-ups of a new post: semantic index, and the optional Vercel Board mirror. */
  afterPost(post) {
    if (!post) return;
    this.bg(recall.indexPost(this.env, post));
    const url = this.env.RH_MIRROR_URL, key = this.env.RH_PROXY_KEY;
    if (url && key && key.length >= 16) {
      this.bg(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rh-proxy-key': key }, body: JSON.stringify({ post }), signal: AbortSignal.timeout(15_000) }));
    }
  }

  /** Swarm-wide lane totals (self-reported by clients): calls, tokens, API-equivalent cost; per node and overall. */
  laneTotals() {
    const keys = ['calls', 'failed_calls', 'cost_usd', 'input_tokens', 'output_tokens', 'cache_tokens'];
    const total = Object.fromEntries(keys.map((k) => [k, 0]));
    const per = [];
    for (const r of this.sql.exec('SELECT node_id, handle, github, counters FROM nodes WHERE counters IS NOT NULL').toArray()) {
      const c = this.live.get(r.node_id)?.counters || parseJ(r.counters, {});
      for (const k of keys) total[k] += Number(c[k]) || 0;
      per.push({ handle: r.handle, github: r.github || null, ...Object.fromEntries(keys.map((k) => [k, Number(c[k]) || 0])) });
    }
    total.cost_usd = Math.round(total.cost_usd * 100) / 100;
    return { note: 'self-reported by each client; cost is the API-equivalent price, billed to subscriptions, not paid', total, nodes: per.sort((a, b) => b.calls - a.calls).slice(0, 100) };
  }

  /** Recall hits agents may read: posts from new contributors wait for review. */
  agentSafe(hits) {
    const ids = (hits || []).filter((h) => h.type === 'post').map((h) => h.ref);
    const ok = new Set(ids.length ? board.getPosts(this.sql, { ids, limit: 50 }).filter((p) => p.for_agents).map((p) => p.id) : []);
    return (hits || []).filter((h) => h.type !== 'post' || ok.has(h.ref));
  }

  /** Small in-memory cache for read-heavy public views (rows-read budget). */
  cached(key, ttl, fn) {
    this.cache ||= new Map();
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < ttl) return c.v;
    const v = fn();
    this.cache.set(key, { at: Date.now(), v });
    return v;
  }

  bg(promise) {
    const p = Promise.resolve(promise).catch(() => {});
    try { this.ctx.waitUntil(p); } catch { /* best-effort */ }
  }

  /** Accepted cards become board posts (kind card), authored by the first run's node. */
  postAcceptedCards(unitId) {
    for (const c of this.sql.exec('SELECT key, module, card, nodes FROM cards WHERE unit_id = ?', unitId).toArray()) {
      const card = parseJ(c.card, {});
      const nodes = parseJ(c.nodes, []);
      this.bg(recall.indexCard(this.env, c.key, c.module, card));
      const short = c.module.split('.').slice(-2).join('.');
      const r = board.createPost(this, {
        body: { kind: 'card', title: `Card: ${short}${c.key !== c.module ? ' ' + c.key.slice(c.module.length) : ''}`.slice(0, 100), body: String(card.summary || '').slice(0, 1500), refs: [c.module, unitId] },
        nodeId: nodes[0], now: Date.now(),
      }, { seed: false, derived: true });
      if (r.post) this.afterPost(r.post);
    }
  }

  /** A lemma or refutation on the board becomes a verify unit for sandboxed verifiers. */
  enqueueCheck(b) {
    const id = typeof b.post_id === 'string' && /^p\d{1,9}$/.test(b.post_id) ? b.post_id : null;
    const p = id && this.sql.exec('SELECT kind, lean FROM posts WHERE id = ?', id).toArray()[0];
    if (!p) return { error: 'unknown_post', status: 404 };
    if (!p.lean) return { error: 'no_lean', status: 400 };
    const uid = `A:verify:${id}`;
    const now = Date.now();
    this.sql.exec(`INSERT INTO units (id, track, kind, ref, deps, needs, attempts, state, updated_at) VALUES (?, 'A', 'verify', ?, '[]', ?, 0, 'open', ?)
                   ON CONFLICT(id) DO NOTHING`, uid, id, JSON.stringify({ role: 'verifier' }), now);
    return { ok: true, unit_id: uid };
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
      const extra = atlas.cardUnitExtras(u) || replay.rebuildUnitExtras(u);
      if (((kind === 'card' && track === 'A') || (kind === 'rebuild' && track === 'R')) && !extra) { rejected.push(id); continue; }
      this.sql.exec(
        `INSERT INTO units (id, track, kind, ref, page, deps, needs, attempts, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET track = excluded.track, kind = excluded.kind, ref = excluded.ref, page = excluded.page,
           deps = excluded.deps, needs = excluded.needs, attempts = excluded.attempts, state = excluded.state, updated_at = excluded.updated_at`,
        id, track, kind, str(u.ref, 256), int(u.page, 0, 1e6), JSON.stringify(deps), JSON.stringify(needs), int(u.attempts, 0, 1e6) ?? 0, state, now,
      );
      if (extra) this.sql.exec('UPDATE units SET depth = ?, area = ?, payload = ? WHERE id = ?', extra.depth, extra.area, extra.payload, id);
      if (extra && kind === 'card') atlas.indexUnitModules(this.sql, id, extra.payload);
      this.sql.exec('UPDATE units SET rk = ? WHERE id = ? AND rk IS NULL', Math.random(), id);
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
    const oldest = this.ring.length ? this.ring[0].id : 0;
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
    if (this.initError) { try { this.migrate(); this.initError = null; } catch (e) { this.initError = String(e?.message || e); } }
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    try {
      if (m === 'POST' && ['/api/hello', '/api/beat', '/api/lease', '/api/result', '/api/bye', '/api/board', '/api/board/check', '/api/github/link'].includes(p)) {
        const v = await this.verifySigned(req, p === '/api/hello');
        if (v.err) return v.err;
        if (p === '/api/hello') return await this.hello(v);
        if (p === '/api/github/link') {
          const r = await trust.verifyGithub(this.env, { nodeId: v.nodeId, pubB64: v.pubB64, login: String(v.body.login || ''), gistId: String(v.body.gist_id || '') }).catch((e) => ({ error: String(e?.message || e).slice(0, 80) }));
          if (r.error) return json({ error: r.error }, 400);
          const taken = this.sql.exec('SELECT COUNT(*) AS n FROM nodes WHERE lower(gh_login) = lower(?) AND node_id != ?', r.login, v.nodeId).one().n;
          this.sql.exec('UPDATE nodes SET gh_login = ?, gh_created_at = ?, github = ? WHERE node_id = ?', r.login, r.created_at, r.login, v.nodeId);
          const old = r.created_at && Date.now() - r.created_at >= trust.GITHUB_MIN_AGE_DAYS * 86_400_000;
          return json({ ok: true, login: r.login, created_at: r.created_at, bonus: !!old, other_nodes_same_account: taken });
        }
        if (p === '/api/beat') return this.beat(v);
        if (p === '/api/lease') return await this.lease(v);
        if (p === '/api/board' || p === '/api/board/check') {
          const r = p === '/api/board' ? board.createPost(this, v) : board.checkPost(this, { ...v, ident: this.ident(v) });
          if (r.error) return json({ error: r.error }, r.status || 400);
          if (p === '/api/board') this.afterPost(r.post);
          return json(r);
        }
        if (p === '/api/result') return await this.result(v);
        return this.bye(v);
      }
      if (m === 'GET' && p === '/api/state') return pub(this.state());
      if (m === 'GET') {
        const sp = url.searchParams;
        if (p === '/api/map') return pub(this.cached('map', 60_000, () => ({ ...atlas.mapView(this.sql), replay: replay.replayLevels(this.sql, Date.now()) })));
        if (p.startsWith('/api/index/')) {
          const name = p.slice('/api/index/'.length);
          if (!/^(modules|decls)$/.test(name)) return pub({ error: 'not_found' }, 404);
          const one = sp.get('part');
          if (one != null) {
            const r = this.sql.exec('SELECT part, parts, data FROM blobs WHERE name = ? AND part = ?', name, Number(one) | 0).toArray()[0];
            if (!r) return pub({ error: 'not_found' }, 404);
            return new Response(r.data, { headers: { 'content-type': 'application/octet-stream', 'x-rh-parts': String(r.parts), 'cache-control': 'public, max-age=3600', ...CORS } });
          }
          const rows = this.sql.exec('SELECT part, parts, data FROM blobs WHERE name = ? ORDER BY part', name).toArray();
          if (!rows.length || rows.length !== rows[0].parts) return pub({ error: 'not_loaded' }, 404);
          const total = rows.reduce((n, r) => n + r.data.byteLength, 0);
          const out = new Uint8Array(total);
          let o = 0;
          for (const r of rows) { out.set(new Uint8Array(r.data), o); o += r.data.byteLength; }
          return new Response(out, { headers: { 'content-type': 'application/gzip', 'cache-control': 'public, max-age=3600', ...CORS } });
        }
        if (p === '/api/receipts') {
          const unit = String(sp.get('unit') || '').slice(0, 300);
          return pub({ unit, receipts: replay.receiptsFor(this.sql, unit) });
        }
        if (p.startsWith('/api/cards/')) {
          const name = decodeURIComponent(p.slice('/api/cards/'.length));
          const v = atlas.moduleView(this.sql, name);
          return v ? pub(v) : pub({ error: 'unknown_module' }, 404);
        }
        if (p.startsWith('/api/source/')) {
          const gz = atlas.sourceBySha(this.sql, p.slice('/api/source/'.length));
          return gz ? new Response(gz, { headers: { 'content-type': 'application/gzip', 'cache-control': 'public, max-age=31536000, immutable', ...CORS } }) : pub({ error: 'unknown_source' }, 404);
        }
        if (p === '/api/contributors') return pub(this.cached('contributors', 60_000, () => ({ contributors: atlas.contributors(this.sql), authors: board.authors(this.sql) })));
        if (p === '/api/board') {
          const kind = sp.get('kind');
          if (kind && !board.POST_KINDS.includes(kind)) return pub({ error: 'bad_kind' }, 400);
          const posts = board.getPosts(this.sql, { topic: sp.get('topic') || undefined, kind: kind || undefined, since: sp.get('since') || undefined, q: sp.get('q') || undefined, limit: sp.get('limit') || 50, rank: sp.get('rank') === '1' });
          return pub({ seq: this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM posts').one().s, posts });
        }
        if (p === '/api/board/digest') {
          const d = board.digest(this.sql, sp.get('focus'));
          const q = sp.get('q') || sp.get('focus');
          if (q) {
            const r = await recall.recall(this.env, this.sql, q, 8).catch(() => ({ method: 'error', hits: [] }));
            d.recall = this.agentSafe(r.hits); d.recall_method = r.method;
          }
          return pub(d);
        }
        if (p === '/api/recall') {
          const r = await recall.recall(this.env, this.sql, sp.get('q'), Math.min(20, Number(sp.get('k')) || 8));
          return pub({ ...r, hits: this.agentSafe(r.hits) });
        }
        if (p === '/api/trust') return pub(this.cached('trust', 60_000, () => ({ ...trust.trustView(this.sql), lanes: this.laneTotals() })));
        if (p === '/api/board/topics') return pub({ topics: board.topics(this.sql) });
        if (p.startsWith('/api/board/post/')) {
          const t = board.thread(this.sql, p.slice('/api/board/post/'.length));
          return t ? pub(t) : pub({ error: 'unknown_post' }, 404);
        }
      }
      if (m === 'GET' && p === '/api/events') return this.events(req);
      if (m === 'POST' && p === '/api/signup') return await this.signup(req);
      if (m === 'POST' && (p === '/api/board/external' || p === '/api/board/enqueue-check')) {
        if (req.headers.get('x-rh-trusted') !== '1') return json({ error: 'not_found' }, 404);
        const b = await req.json().catch(() => null);
        if (!b) return json({ error: 'bad_json' }, 400);
        const r = p === '/api/board/external' ? board.externalPost(this, b) : this.enqueueCheck(b);
        if (r.error) return json({ error: r.error }, r.status || 400);
        if (r.post && !r.existed) this.afterPost(r.post);
        return json(r);
      }
      if (m === 'GET' && p === '/api/signups/count') return pub(this.signupCount());
      if (p.startsWith('/api/admin/')) {
        if (!this.isAdmin(req)) return json({ error: 'unauthorized' }, 401);
        if (m === 'POST' && p === '/api/admin/units') return await this.adminUnits(req);
        if (m === 'POST' && p === '/api/admin/blob') {
          const name = url.searchParams.get('name'), part = Number(url.searchParams.get('part')), parts = Number(url.searchParams.get('parts'));
          if (!/^(modules|decls)$/.test(name || '') || !Number.isInteger(part) || !Number.isInteger(parts) || part < 0 || part >= parts || parts > 20) return json({ error: 'bad_blob' }, 400);
          const buf = new Uint8Array(await req.arrayBuffer());
          if (!buf.length || buf.length > 1_900_000) return json({ error: 'bad_size' }, 413);
          this.sql.exec('INSERT INTO blobs (name, part, parts, data) VALUES (?, ?, ?, ?) ON CONFLICT(name, part) DO UPDATE SET parts = excluded.parts, data = excluded.data', name, part, parts, buf);
          return json({ ok: true, name, part, parts, bytes: buf.length });
        }
        if (m === 'POST' && (p === '/api/admin/pack' || p === '/api/admin/modules' || p === '/api/admin/atlas')) {
          const r = p === '/api/admin/pack' ? await atlas.adminPack(this.sql, req, url) : p === '/api/admin/modules' ? await atlas.adminModules(this.sql, req) : await atlas.adminAtlas(this.sql, req);
          return r.error ? json({ error: r.error }, r.status || 400) : json(r);
        }
        if (m === 'GET' && p === '/api/admin/health') {
          return json({ init_error: this.initError || null, schema: this.sql.exec("SELECT v FROM schema_meta WHERE k = 'version'").toArray()[0]?.v ?? null });
        }
        if (m === 'POST' && p === '/api/admin/ledger') {
          const r = await ledger.exportLedger(this, { dryRun: url.searchParams.get('dry') === '1', only: url.searchParams.get('only') || null })
            .catch((e) => ({ error: String(e?.message || e).slice(0, 200) }));
          return json(r, r.error ? 500 : 200);
        }
        if (m === 'POST' && p === '/api/admin/nodes/tier') {
          const b = await req.json().catch(() => null);
          const tier = ['new', 'established', 'trusted'].includes(b?.tier) ? b.tier : null;
          if (!tier || typeof b?.node_id !== 'string') return json({ error: 'node_id_and_tier_required' }, 400);
          const r = this.sql.exec('UPDATE nodes SET tier = ?, quarantined_at = CASE WHEN ? THEN NULL ELSE quarantined_at END WHERE node_id = ? RETURNING node_id, tier', tier, b.unquarantine ? 1 : 0, b.node_id).toArray();
          this.cache?.delete('trust');
          return json({ ok: true, updated: r });
        }
        if (m === 'DELETE' && p === '/api/admin/units') {
          const id = String(url.searchParams.get('id') || '');
          if (!id) return json({ error: 'id_required' }, 400);
          this.sql.exec('DELETE FROM cards WHERE unit_id = ?', id);
          this.sql.exec('DELETE FROM unit_modules WHERE unit_id = ?', id);
          const n = this.sql.exec('DELETE FROM units WHERE id = ? RETURNING id', id).toArray().length;
          return json({ ok: true, deleted: n });
        }
        if (m === 'DELETE' && p === '/api/admin/nodes') {
          const handle = String(url.searchParams.get('handle') || '').trim();
          const id = String(url.searchParams.get('node_id') || '').trim();
          if (!handle && !id) return json({ error: 'handle_or_node_id_required' }, 400);
          const rows = this.sql.exec('SELECT node_id FROM nodes WHERE handle = ? OR node_id = ?', handle || '\u0000', id || '\u0000').toArray();
          for (const r of rows) {
            this.sql.exec('UPDATE leases SET closed_at = ? WHERE node_id = ? AND closed_at IS NULL', Date.now(), r.node_id);
            this.sql.exec('INSERT OR IGNORE INTO retired_keys (node_id, pubkey) SELECT node_id, pubkey FROM nodes WHERE node_id = ?', r.node_id);
            this.sql.exec('DELETE FROM nodes WHERE node_id = ?', r.node_id);
            this.live.delete(r.node_id); this.pubkeys.delete(r.node_id); this.nonces.delete(r.node_id);
            this.emit('bye', { node_id: r.node_id });
          }
          return json({ ok: true, deleted: rows.map((r) => r.node_id) });
        }
        if (m === 'POST' && p === '/api/admin/board/seed') {
          const b = await req.json().catch(() => null);
          if (!Array.isArray(b?.questions)) return json({ error: 'questions_required' }, 400);
          const posts = board.seedQuestions(this, b.questions);
          for (const x of posts) if (x.id && !x.existed) this.bg(recall.indexPost(this.env, board.getPosts(this.sql, { ids: [x.id] })[0]));
          return json({ ok: true, posts });
        }
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
