/**
 * The pre-launch interest list, in D1 (database "riemann-signups"), apart
 * from the swarm's Durable Object, so signups never compete with swarm load.
 * Same API as before: POST /api/signup, GET /api/signups/count, and the admin
 * JSON / CSV / DELETE routes. Rate limit: 5 per hour per client IP (the IP the
 * site proxy forwards). Count is cached in memory for 30 s.
 */
const LIMIT_PER_HOUR = 5;
const COUNT_TTL_MS = 30_000;
let countCache = null; // { at, body }
let schemaReady = false;
let migrateTried = 0;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS signups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, data TEXT NOT NULL,
      created_at INTEGER, updated_at INTEGER)`),
    db.prepare('CREATE TABLE IF NOT EXISTS ratelimit (k TEXT, hour INTEGER, n INTEGER, PRIMARY KEY (k, hour))'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)'),
  ]);
  schemaReady = true;
}

/** Copy rows from the Durable Object's old signups table once (best-effort, retried at most every 5 min). */
async function migrateOnce(env, db) {
  if (Date.now() - migrateTried < 5 * 60_000) return;
  migrateTried = Date.now();
  const done = await db.prepare("SELECT v FROM meta WHERE k = 'migrated'").first();
  if (done) { migrateTried = Infinity; return; }
  try {
    const stub = env.SWARM.get(env.SWARM.idFromName('swarm'));
    const r = await stub.fetch(new Request('https://swarm/api/admin/signups', { headers: { authorization: `Bearer ${env.RH_ADMIN_TOKEN}` } }));
    if (!r.ok) return;
    const { signups } = await r.json();
    const stmts = (signups || []).map((s) => {
      const { id, email, created_at, updated_at, ...data } = s;
      return db.prepare('INSERT INTO signups (email, data, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
        .bind(String(email).toLowerCase(), JSON.stringify(data), created_at || Date.now(), updated_at || Date.now());
    });
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    await db.prepare("INSERT INTO meta (k, v) VALUES ('migrated', ?) ON CONFLICT(k) DO NOTHING").bind(String(stmts.length)).run();
    migrateTried = Infinity;
    countCache = null;
  } catch { /* quota or network: try again later */ }
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleSignups(req, env, ctx, { ip, admin, json, pub, validateSignup, signupsCsv, PROOFS }) {
  const db = env.SIGNUPS;
  if (!db) return null;
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const isRoute = (m === 'POST' && p === '/api/signup') || (m === 'GET' && p === '/api/signups/count') || p === '/api/admin/signups';
  if (!isRoute) return null;
  await ensureSchema(db);
  ctx.waitUntil(migrateOnce(env, db));

  if (m === 'POST' && p === '/api/signup') {
    const k = (await sha256Hex(`rh-signup:${ip}`)).slice(0, 32);
    const hour = Math.floor(Date.now() / 3600_000);
    const used = (await db.prepare('SELECT n FROM ratelimit WHERE k = ? AND hour = ?').bind(k, hour).first())?.n ?? 0;
    if (used >= LIMIT_PER_HOUR) return pub({ error: 'rate_limited' }, 429);
    await db.batch([
      db.prepare('DELETE FROM ratelimit WHERE hour < ?').bind(hour - 1),
      db.prepare('INSERT INTO ratelimit (k, hour, n) VALUES (?, ?, 1) ON CONFLICT(k, hour) DO UPDATE SET n = n + 1').bind(k, hour),
    ]);
    if (Number(req.headers.get('content-length') || 0) > 16_384) return pub({ error: 'too_large' }, 413);
    let b;
    try { b = await req.json(); } catch { return pub({ error: 'bad_json' }, 400); }
    const res = validateSignup(b);
    if (res.error) return pub({ error: res.error }, 400);
    const s = res.signup;
    const now = Date.now();
    const prev = await db.prepare('SELECT id FROM signups WHERE email = ?').bind(s.email).first();
    let id;
    if (prev) {
      await db.prepare('UPDATE signups SET data = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(s), now, prev.id).run();
      id = prev.id;
    } else {
      id = (await db.prepare('INSERT INTO signups (email, data, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id').bind(s.email, JSON.stringify(s), now, now).first()).id;
    }
    // Position by first signup time, so rows copied later from the old store keep their place.
    const position = (await db.prepare('SELECT COUNT(*) AS n FROM signups WHERE created_at <= (SELECT created_at FROM signups WHERE id = ?)').bind(id).first()).n;
    countCache = null;
    return pub({ ok: true, position, updated: !!prev });
  }

  if (m === 'GET' && p === '/api/signups/count') {
    if (countCache && Date.now() - countCache.at < COUNT_TTL_MS) return pub(countCache.body);
    const t = { total: 0, macs: 0, big_machines: 0, claude: 0, codex: 0, cores: 0, ram_gb: 0, by_proof: Object.fromEntries(PROOFS.map((x) => [x, 0])) };
    const { results } = await db.prepare('SELECT data FROM signups').all();
    for (const r of results || []) {
      let s; try { s = JSON.parse(r.data); } catch { continue; }
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
    countCache = { at: Date.now(), body: t };
    return pub(t);
  }

  // admin
  if (!admin) return json({ error: 'unauthorized' }, 401);
  if (m === 'GET') {
    const { results } = await db.prepare('SELECT id, email, data, created_at, updated_at FROM signups ORDER BY created_at ASC, id ASC').all();
    const rows = (results || []).map((r) => { let d = {}; try { d = JSON.parse(r.data); } catch {} return { id: r.id, ...d, email: r.email, created_at: r.created_at, updated_at: r.updated_at }; });
    if (url.searchParams.get('format') === 'csv') {
      return new Response(signupsCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="signups.csv"' } });
    }
    return json({ total: rows.length, signups: rows });
  }
  if (m === 'DELETE') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    if (!email) return json({ error: 'email_required' }, 400);
    const r = await db.prepare('DELETE FROM signups WHERE email = ? RETURNING id').bind(email).all();
    countCache = null;
    return json({ ok: true, deleted: (r.results || []).length });
  }
  return json({ error: 'not_found' }, 404);
}
