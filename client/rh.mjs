#!/usr/bin/env node
// rh.mjs — Riemann swarm client (docs/PROTOCOL.md v1). Zero npm dependencies.
//
//   node rh.mjs join   [--handle h] [--place p] [--roles thinker,verifier] [--cap N]
//                      [--proofs alpoge|masullo|both]   which claimed proof to help verify
//   node rh.mjs run    [--beats N]      heartbeat + lease loop (Ctrl-C to stop)
//   node rh.mjs status                  local identity + what the coordinator shows
//   node rh.mjs bye                     tell the coordinator this machine left
//   node rh.mjs leave --purge           bye, then delete ~/.riemann entirely
//
// Safety rules: docs/SAFETY.md. The coordinator sends data, never commands:
// any `directives` in a reply are ignored.
//
// Coordinator API base: $RH_COORDINATOR (default https://riemannhypothesis.vercel.app/api/rh)
// Identity:    ~/.riemann/identity.json (Ed25519, mode 0600). Never sent: the
// private key, tokens, emails, model logins. Lane detection only checks that
// `claude --version` / `codex --version` run.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const VERSION = '0.1.0';
const COORD = (process.env.RH_COORDINATOR || 'https://riemannhypothesis.vercel.app/api/rh').replace(/\/+$/, '');
const DIR = process.env.RH_HOME || path.join(os.homedir(), '.riemann');
const ID_FILE = path.join(DIR, 'identity.json');
const STATE_FILE = path.join(DIR, 'state.json');
const ROLES = ['thinker', 'verifier', 'anchor', 'canary', 'finisher', 'prover', 'atlas'];
const PROOFS = ['alpoge', 'masullo'];

function parseProofs(v) {
  const parts = String(v).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.includes('both')) return [...PROOFS];
  const bad = parts.filter((p) => !PROOFS.includes(p));
  if (bad.length) die(`--proofs must be alpoge, masullo or both (got ${bad.join(', ')})`);
  return PROOFS.filter((p) => parts.includes(p));
}
const proofLabel = (p) => (p && p.length === 1 ? p[0] : 'both');

const log = (...a) => console.log(`[rh ${new Date().toISOString().slice(11, 19)}]`, ...a);
const die = (msg) => { console.error(`rh: ${msg}`); process.exit(1); };

// ---------- args ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// ---------- identity ----------

function rawPub(publicKeyObj) {
  const spki = publicKeyObj.export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32);
}

function loadIdentity(create) {
  if (fs.existsSync(ID_FILE)) {
    const j = JSON.parse(fs.readFileSync(ID_FILE, 'utf8'));
    const priv = crypto.createPrivateKey({ key: Buffer.from(j.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    return finishIdentity(j.publicKey, priv);
  }
  if (!create) die(`no identity at ${ID_FILE} — run: node rh.mjs join`);
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubB64 = rawPub(publicKey).toString('base64');
  const privB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  fs.writeFileSync(ID_FILE, JSON.stringify({ publicKey: pubB64, privateKey: privB64 }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(ID_FILE, 0o600);
  log(`created identity ${ID_FILE}`);
  return finishIdentity(pubB64, privateKey);
}

function finishIdentity(pubB64, priv) {
  const nodeId = crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 16);
  return { pubB64, priv, nodeId };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}

// ---------- signed calls ----------

async function signed(id, route, fields, withPubkey = false) {
  // One retry on network failure (fresh ts + nonce, so replay protection holds).
  try { return await signedOnce(id, route, fields, withPubkey); } catch (e) {
    if (e.status) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    return signedOnce(id, route, fields, withPubkey);
  }
}

async function signedOnce(id, route, fields, withPubkey) {
  const body = { ...fields, node_id: id.nodeId, ...(withPubkey ? { pubkey: id.pubB64 } : {}), ts: Date.now(), nonce: crypto.randomBytes(12).toString('hex') };
  const bytes = Buffer.from(JSON.stringify(body));
  const sig = crypto.sign(null, bytes, id.priv).toString('base64');
  const res = await fetch(`${COORD}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rh-sig': sig, 'user-agent': `rh.mjs/${VERSION}` },
    body: bytes,
    signal: AbortSignal.timeout(20_000),
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const err = new Error(`${route} → ${res.status} ${data.error || ''}`.trim());
    err.status = res.status; err.code = data.error;
    throw err;
  }
  return data;
}

// ---------- hardware probe ----------

function sh(cmd, args, timeout = 4000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function diskFreeGb() {
  const out = sh('df', ['-k', os.homedir()]);
  if (!out) return null;
  const line = out.split('\n').slice(1).join(' ').trim().split(/\s+/);
  const avail = Number(line[3]);
  return Number.isFinite(avail) ? Math.round((avail / 1024 / 1024) * 10) / 10 : null;
}

function probeMachine() {
  const plat = os.platform();
  const m = { chip: null, cores: os.cpus().length, perf_cores: null, ram_gb: Math.round(os.totalmem() / 2 ** 30), disk_free_gb: diskFreeGb(), os: plat, os_version: os.release(), arch: os.arch(), gpu: null };
  if (plat === 'darwin') {
    m.os = 'macos';
    const ncpu = Number(sh('sysctl', ['-n', 'hw.ncpu']));
    if (ncpu) m.cores = ncpu;
    const mem = Number(sh('sysctl', ['-n', 'hw.memsize']));
    if (mem) m.ram_gb = Math.round(mem / 2 ** 30);
    m.chip = sh('sysctl', ['-n', 'machdep.cpu.brand_string']);
    const perf = Number(sh('sysctl', ['-n', 'hw.perflevel0.physicalcpu']));
    if (perf) m.perf_cores = perf;
    m.os_version = sh('sw_vers', ['-productVersion']) || m.os_version;
    if (m.chip && /Apple/.test(m.chip)) m.gpu = m.chip;
  } else if (plat === 'linux') {
    m.os = 'linux';
    const n = Number(sh('nproc', []));
    if (n) m.cores = n;
    try {
      const ci = fs.readFileSync('/proc/cpuinfo', 'utf8');
      m.chip = (ci.match(/^model name\s*:\s*(.+)$/m) || ci.match(/^Hardware\s*:\s*(.+)$/m) || [])[1]?.trim() || null;
    } catch {}
    try {
      const mi = fs.readFileSync('/proc/meminfo', 'utf8');
      const kb = Number((mi.match(/^MemTotal:\s+(\d+)/m) || [])[1]);
      if (kb) m.ram_gb = Math.round(kb / 2 ** 20);
    } catch {}
    try {
      const r = fs.readFileSync('/etc/os-release', 'utf8');
      m.os_version = (r.match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || m.os_version;
    } catch {}
    const g = sh('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
    if (g) {
      const names = g.split('\n').map((s) => s.trim()).filter(Boolean);
      m.gpu = names.length > 1 ? `${names.length}x ${names[0]}` : names[0] || null;
    }
  }
  if (!m.chip) m.chip = os.cpus()[0]?.model || 'unknown';
  return m;
}

function probeLanes() {
  // Presence only: does the CLI run? Never reads tokens or config files.
  const has = (bin) => sh(bin, ['--version'], 8000) != null;
  return { claude: has('claude'), codex: has('codex'), local_models: [] };
}

// ---------- commands ----------

async function cmdJoin(args) {
  const id = loadIdentity(true);
  const prev = loadState();
  const roles = String(args.roles || (prev.roles || []).join(',') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const bad = roles.filter((r) => !ROLES.includes(r));
  if (bad.length) die(`unknown role(s): ${bad.join(', ')} (choose from ${ROLES.join(', ')})`);
  const cap = args.cap != null && args.cap !== true ? Number(args.cap) : prev.cap ?? null;
  if (cap != null && !(cap >= 0)) die('--cap must be a number (daily model-use cap for this machine)');
  const proofs = typeof args.proofs === 'string' ? parseProofs(args.proofs) : prev.proofs || [...PROOFS];
  const machine = probeMachine();
  const lanes = probeLanes();
  log(`machine: ${machine.chip} · ${machine.cores} cores · ${machine.ram_gb} GB RAM · ${machine.disk_free_gb ?? '?'} GB free · ${machine.os} ${machine.os_version} ${machine.arch}`);
  log(`lanes: claude ${lanes.claude ? 'present' : 'absent'} · codex ${lanes.codex ? 'present' : 'absent'}`);
  const fields = {
    handle: typeof args.handle === 'string' ? args.handle : prev.handle || undefined,
    place: typeof args.place === 'string' ? args.place : prev.place || undefined,
    machine, lanes, roles, proofs,
    client: { name: 'rh.mjs', version: VERSION, platform: os.platform() },
  };
  const r = await signed(id, '/hello', fields, true);
  if (r.node_id !== id.nodeId) die(`coordinator returned node_id ${r.node_id}, expected ${id.nodeId}`);
  saveState({ coordinator: COORD, node_id: r.node_id, handle: r.handle ?? fields.handle, place: fields.place ?? null, roles: r.roles ?? roles, proofs: r.proofs ?? proofs, cap, beat_ms: r.beat_ms, joined_at: Date.now() });
  log(`joined ${COORD} as ${r.node_id} (${r.handle ?? fields.handle ?? 'generated handle'})`);
  log(`proofs: ${proofLabel(r.proofs ?? proofs)} (alpoge → tracks A+R, masullo → track M)`);
  log(`roles: ${(r.roles ?? roles).join(', ')} · suggested: ${(r.suggested_roles || []).join(', ')} · beat every ${r.beat_ms} ms`);
  if (cap != null) log(`daily cap ${cap} stays on this machine; it is enforced locally once lanes run (phase 2).`);
  log('next: node client/rh.mjs run');
  return r;
}

async function cmdRun(args) {
  const id = loadIdentity(false);
  const st = loadState();
  if (!st.node_id) die('not joined yet — run: node rh.mjs join');
  const beatMs = Math.max(5000, Number(st.beat_ms) || 20000);
  const maxBeats = args.beats ? Number(args.beats) : Infinity;
  const roles = st.roles || [];
  const leaseEveryMs = Math.max(beatMs, 60_000);
  let beats = 0, lastLease = 0, stopping = false, warnedWork = false, wake = null;
  const stop = () => { stopping = true; log('stopping (no bye sent; run `node rh.mjs bye` to leave)'); wake?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log(`running as ${st.node_id} → ${COORD} · beat ${beatMs} ms · roles ${roles.join(', ') || 'none'}`);

  while (!stopping && beats < maxBeats) {
    try {
      await signed(id, '/beat', { status: 'idle', load: { cpu: os.loadavg()[0] } });
      beats++;
      log(`beat ${beats} ok (idle)`);
    } catch (e) {
      log(`beat failed: ${e.message}`);
      if (e.code === 'use_public_api') die('this coordinator only accepts calls through its public API; unset RH_COORDINATOR to use the default');
      if (e.code === 'unknown_node') { log('coordinator does not know this node — re-joining'); await cmdJoin({}).catch((x) => log(`re-join failed: ${x.message}`)); }
    }
    if (!stopping && Date.now() - lastLease >= leaseEveryMs) {
      lastLease = Date.now();
      for (const role of roles) {
        try {
          const r = await signed(id, '/lease', { role });
          if (!r.unit) { log(`lease ${role}: no units open — idle (work execution arrives in phase 2)`); continue; }
          // Phase 1: no executor yet. Hand the unit straight back so nobody waits on us.
          if (!warnedWork) { log('work execution arrives in phase 2; returning leased units untouched'); warnedWork = true; }
          await signed(id, '/result', { lease_id: r.lease_id, unit_id: r.unit.id, verdict: 'skip', summary: 'phase 1 client: no executor' });
          log(`lease ${role}: got ${r.unit.id}, returned it (skip)`);
        } catch (e) { log(`lease ${role} failed: ${e.message}`); }
      }
    }
    if (stopping || beats >= maxBeats) break;
    await new Promise((res) => { const t = setTimeout(res, beatMs); wake = () => { clearTimeout(t); res(); }; });
    wake = null;
  }
  log(`done after ${beats} beat(s)`);
}

async function cmdStatus() {
  const id = loadIdentity(false);
  const st = loadState();
  console.log(`identity   ${ID_FILE}`);
  console.log(`node_id    ${id.nodeId}`);
  console.log(`coordinator ${COORD}`);
  console.log(`handle     ${st.handle ?? '-'}   place ${st.place ?? '-'}   roles ${(st.roles || []).join(', ') || '-'}   cap ${st.cap ?? '-'}`);
  console.log(`proofs     ${proofLabel(st.proofs || PROOFS)}`);
  try {
    const res = await fetch(`${COORD}/state`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`state → ${res.status}${res.status === 403 ? ' (the live view opens at launch)' : ''}`);
    const s = await res.json();
    const me = (s.nodes || []).find((n) => n.node_id === id.nodeId);
    if (!me) console.log('coordinator: this node is not listed (never joined, or gone > 7 days)');
    else console.log(`coordinator: ${me.online ? 'ONLINE' : 'offline'} · proofs ${proofLabel(me.proofs)} · status ${me.status} · last beat ${me.last_beat ? new Date(me.last_beat).toISOString() : '-'} · ${me.machine.chip} ${me.machine.cores} cores ${me.machine.ram_gb} GB`);
    console.log(`swarm: ${s.totals.nodes_online} online / ${s.totals.nodes_ever} ever · ${s.totals.cores} cores · ${s.totals.ram_gb} GB`);
  } catch (e) { console.log(`coordinator unreachable: ${e.message}`); }
}

async function cmdBye() {
  const id = loadIdentity(false);
  await signed(id, '/bye', {});
  log(`bye sent for ${id.nodeId}; identity kept at ${ID_FILE} (delete it to forget this machine)`);
}

async function cmdLeave(args) {
  if (fs.existsSync(ID_FILE)) { try { await cmdBye(); } catch (e) { log(`bye failed (${e.message}); removing local files anyway`); } }
  if (args.purge !== true) { log('add --purge to delete everything under ' + DIR); return; }
  const resolved = path.resolve(DIR);
  if (resolved === path.resolve(os.homedir()) || resolved === '/' || !resolved.includes('riemann')) die(`refusing to delete ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
  log(`deleted ${resolved}`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'help';
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) die(`Node ${process.versions.node} is too old; need 20+`);
const cmds = { join: cmdJoin, run: cmdRun, status: cmdStatus, bye: cmdBye, leave: cmdLeave };
if (!cmds[cmd]) {
  console.log('usage: node rh.mjs join [--handle h] [--place p] [--roles thinker,verifier] [--cap N] [--proofs alpoge|masullo|both] | run [--beats N] | status | bye | leave --purge');
  process.exit(cmd === 'help' ? 0 : 2);
}
cmds[cmd](args).catch((e) => die(e.message));
