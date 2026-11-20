// LOCAL DEV ONLY. Imported dynamically by app/api/rh/[...path]/route.js behind
// NODE_ENV === 'development' && RH_FIXTURE. Never served in production.

const ADJ = ['quiet', 'amber', 'patient', 'north', 'still', 'brisk', 'lucid', 'stone', 'dry', 'late', 'pale', 'keen', 'slow', 'clear', 'deep', 'iron', 'low', 'warm'];
const NOUN = ['heron', 'cedar', 'lemma', 'harbor', 'kernel', 'field', 'ridge', 'falcon', 'tide', 'meadow', 'comet', 'orchard', 'quarry', 'lantern', 'delta', 'atlas', 'fjord', 'pine'];
const PLACES = ['Lisbon', 'Zürich', 'Bangalore', 'Toronto', 'Kyoto', 'Berlin', 'Austin', 'São Paulo', 'Nairobi', 'Oslo', 'Seoul', 'Paris', 'Melbourne', 'Warsaw', null, null, 'Cambridge', 'Tel Aviv', 'Mexico City', 'Edinburgh'];
const MACS = [
  ['M1', 8, 16], ['M1 Pro', 10, 16], ['M1 Max', 10, 32], ['M2', 8, 16], ['M2 Pro', 12, 32], ['M2 Max', 12, 64],
  ['M3', 8, 16], ['M3 Pro', 12, 36], ['M3 Max', 16, 64], ['M4', 10, 24], ['M4 Pro', 14, 48], ['M4 Max', 16, 128], ['M2 Ultra', 24, 192],
];
const STATUSES = ['thinking', 'thinking', 'thinking', 'checking', 'idle', 'idle', 'verifying', 'preparing', 'paused'];

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

function makeNode(i, now) {
  const [chip, cores, ram] = pick(MACS);
  const r = rnd();
  const claude = r < 0.62;
  const codex = r > 0.45;
  const roles = cores >= 12 && ram >= 32 && !claude && !codex ? ['verifier'] : ['thinker'];
  const status = roles[0] === 'verifier' ? pick(['verifying', 'idle', 'verifying']) : pick(STATUSES);
  const lane = claude && codex ? pick(['claude', 'codex']) : claude ? 'claude' : codex ? 'codex' : undefined;
  return {
    node_id: (Math.floor(rnd() * 2 ** 52)).toString(16).padStart(16, '0').slice(0, 16),
    handle: `${pick(ADJ)}-${pick(NOUN)}`,
    place: pick(PLACES),
    roles,
    status,
    activity: status === 'idle' || status === 'paused' ? null : { track: rnd() < 0.8 ? 'M' : 'A', unit_id: `M:${1 + Math.floor(rnd() * 9)}.${1 + Math.floor(rnd() * 6)}.${1 + Math.floor(rnd() * 4)}`, lane, since: now - rnd() * 600_000 },
    machine: { chip, cores, ram_gb: ram },
    lanes: { claude, codex, local_models: [] },
    proofs: pick([['alpoge', 'masullo'], ['alpoge', 'masullo'], ['alpoge'], ['masullo']]),
    joined_at: now - Math.floor(rnd() * 3_600_000) - 60_000,
    last_beat: now - Math.floor(rnd() * 15_000),
  };
}

const BIG = [
  { handle: 'big-one', place: null, roles: ['anchor', 'canary'], status: 'building', machine: { chip: 'EPYC 9654', cores: 192, ram_gb: 768 }, lanes: { claude: false, codex: false, local_models: [] } },
  { handle: 'deep-quarry', place: 'Helsinki', roles: ['prover'], status: 'thinking', machine: { chip: 'M3 Ultra', cores: 32, ram_gb: 512 }, lanes: { claude: false, codex: false, local_models: ['deepseek-prover', 'kimina'] } },
  { handle: 'iron-atlas', place: 'Frankfurt', roles: ['atlas'], status: 'seeding', machine: { chip: 'Xeon 8480', cores: 112, ram_gb: 1024 }, lanes: { claude: false, codex: false, local_models: [] } },
];

let state = null;
let evId = 0;

function totalsOf(nodes, now) {
  const on = nodes.filter((n) => now - n.last_beat < 60_000);
  const t = { nodes_online: on.length, nodes_ever: nodes.length + 9, cores: 0, ram_gb: 0, lanes: { claude: 0, codex: 0, local: 0 }, by_role: {}, by_status: {} };
  for (const n of on) {
    t.cores += n.machine.cores; t.ram_gb += n.machine.ram_gb;
    if (n.lanes.claude) t.lanes.claude++;
    if (n.lanes.codex) t.lanes.codex++;
    t.lanes.local += n.lanes.local_models.length;
    for (const r of n.roles) t.by_role[r] = (t.by_role[r] || 0) + 1;
    t.by_status[n.status] = (t.by_status[n.status] || 0) + 1;
  }
  return t;
}

export function fixtureState(mode) {
  const now = Date.now();
  if (mode === 'empty') {
    return { at: now, totals: totalsOf([], now), nodes: [], tracks: { M: { units: 0, done: 0, gap: 0, leased: 0 }, A: { units: 0, done: 0, gap: 0, leased: 0 }, R: { units: 0, done: 0, gap: 0, leased: 0 } }, events: [] };
  }
  if (!state) {
    const nodes = [];
    for (let i = 0; i < 46; i++) nodes.push(makeNode(i, now));
    BIG.forEach((b, i) => nodes.push({ proofs: i === 2 ? ['alpoge'] : ['alpoge', 'masullo'], ...b, node_id: `b16f00d${i}`.padEnd(16, '0'), activity: { track: i === 2 ? 'A' : 'M', since: now - 400_000 }, joined_at: now - 7_200_000, last_beat: now - 3000 }));
    const events = nodes.slice(0, 14).map((n, i) => ({ id: ++evId, type: i % 3 ? 'beat' : 'node', at: now - (14 - i) * 9000, node_id: n.node_id, handle: n.handle, status: n.status, unit_id: n.activity?.unit_id }));
    state = { nodes, events, tracks: { M: { units: 2140, done: 386, gap: 11, leased: 74 }, A: { units: 900, done: 212, gap: 3, leased: 9 }, R: { units: 12, done: 7, gap: 0, leased: 1 } } };
  }
  for (const n of state.nodes) if (n.status !== 'paused' || rnd() < 0.5) n.last_beat = Math.max(n.last_beat, now - Math.floor(rnd() * 20_000));
  return { at: now, totals: totalsOf(state.nodes, now), nodes: state.nodes, tracks: state.tracks, events: state.events.slice(-200) };
}

/** One synthetic delta, mutating the fixture state. */
export function fixtureEvent() {
  const now = Date.now();
  fixtureState();
  const roll = rnd();
  let ev;
  if (roll < 0.22) {
    const n = makeNode(0, now); n.joined_at = now; n.last_beat = now;
    state.nodes.push(n);
    ev = { type: 'node', node: n, node_id: n.node_id, handle: n.handle, place: n.place, chip: n.machine.chip };
  } else if (roll < 0.5) {
    const n = pick(state.nodes); n.status = pick(STATUSES); n.last_beat = now;
    ev = { type: 'beat', node_id: n.node_id, handle: n.handle, status: n.status, activity: n.activity };
  } else if (roll < 0.75) {
    const n = pick(state.nodes); const unit = `M:${1 + Math.floor(rnd() * 9)}.${1 + Math.floor(rnd() * 6)}.${1 + Math.floor(rnd() * 4)}`;
    n.status = 'thinking'; n.activity = { track: 'M', unit_id: unit, lane: n.lanes.claude ? 'claude' : 'codex', since: now };
    state.tracks.M.leased++;
    ev = { type: 'lease', node_id: n.node_id, handle: n.handle, unit_id: unit, track: 'M' };
  } else if (roll < 0.95) {
    const n = pick(state.nodes); const ok = rnd() < 0.8;
    state.tracks.M.done += ok ? 1 : 0; state.tracks.M.gap += ok ? 0 : rnd() < 0.2 ? 1 : 0;
    ev = { type: 'result', node_id: n.node_id, handle: n.handle, unit_id: n.activity?.unit_id || 'M:4.2.1', verdict: ok ? 'ok' : 'fail', track: 'M' };
  } else {
    const n = state.nodes.splice(Math.floor(rnd() * state.nodes.length), 1)[0];
    ev = { type: 'bye', node_id: n.node_id, handle: n.handle };
  }
  ev.id = ++evId; ev.at = now;
  state.events.push(ev);
  if (state.events.length > 200) state.events.shift();
  return ev;
}

let signups = { total: 273, macs: 268, big_machines: 5, claude: 171, codex: 94, cores: 612, ram_gb: 11264, by_proof: { alpoge: 231, masullo: 198 } };
export function fixtureCount(mode) {
  if (mode === 'empty') return { total: 0, macs: 0, big_machines: 0, claude: 0, codex: 0, cores: 0, ram_gb: 0, by_proof: { alpoge: 0, masullo: 0 } };
  return signups;
}
export function fixtureSignup(body) {
  const m = body?.machine || {};
  const next = { ...signups, total: signups.total + 1 };
  if (m.kind === 'mac') next.macs++; else next.big_machines++;
  next.cores += Number(m.cores) || 0;
  next.ram_gb += Number(m.ram_gb) || 0;
  if (body?.claude && body.claude !== 'none') next.claude++;
  if (body?.codex && body.codex !== 'none') next.codex++;
  const pr = Array.isArray(body?.proofs) ? body.proofs : ['alpoge', 'masullo'];
  next.by_proof = { alpoge: signups.by_proof.alpoge + (pr.includes('alpoge') ? 1 : 0), masullo: signups.by_proof.masullo + (pr.includes('masullo') ? 1 : 0) };
  signups = next;
  return { ok: true, position: next.total, updated: false };
}
