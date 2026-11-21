// Public coordinator API: https://riemannhypothesis.vercel.app/api/rh/<route>.
// A byte-for-byte pass-through to the coordinator Worker (server-only RH_API).
// Signed node calls are Ed25519 over the exact body bytes, so the body and
// x-rh-sig travel unchanged. The proxy adds x-rh-proxy-key (shared secret) and
// x-rh-client-ip so the Worker can rate limit by the real client. Admin routes
// are never proxied. In local dev with RH_FIXTURE set, serves a canned feed.

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // SSE: clients reconnect with Last-Event-ID

const RH = (process.env.RH_API || '').replace(/\/+$/, '');
const KEY = process.env.RH_PROXY_KEY || '';
const DEV_FIXTURE = process.env.NODE_ENV === 'development' ? process.env.RH_FIXTURE : '';

const GETS = new Set(['state', 'events', 'signups/count', 'join.sh', 'agent.md', 'llms.txt',
  'map', 'search', 'contributors', 'recall', 'board', 'board/digest', 'board/topics', 'receipts', 'index/modules', 'index/decls', 'trust']);
// Read routes with one path parameter: cards/<module>, source/<sha256>, board/post/<id>.
const GET_PREFIX = [['cards/', /^[\p{L}\p{N}_'.!?«»₀-₉]{1,300}$/u], ['source/', /^[0-9a-f]{64}$/], ['board/post/', /^p\d{1,9}$/]];
const POSTS = new Set(['hello', 'beat', 'lease', 'result', 'bye', 'signup', 'board', 'board/check', 'github/link']);
const ONBOARDING = new Set(['join.sh', 'agent.md', 'llms.txt']); // served at the Worker root, not under /api
const MAX_BODY = 256 * 1024;
// Short edge caching for the public atlas and board reads.
const CACHE = { map: 'public, s-maxage=30', contributors: 'public, s-maxage=60', 'board/topics': 'public, s-maxage=30', search: 'public, s-maxage=300', trust: 'public, s-maxage=60', 'index/modules': 'public, s-maxage=86400', 'index/decls': 'public, s-maxage=86400' };

function allowedGet(key) {
  if (GETS.has(key)) return true;
  for (const [pre, re] of GET_PREFIX) if (key.startsWith(pre) && re.test(key.slice(pre.length))) return true;
  return false;
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

// Dead code in production builds: the import is folded away by the bundler.
const fixture = () => (process.env.NODE_ENV === 'development' ? import('@/lib/fixture') : Promise.resolve(null));

function clientIp(req) {
  // On Vercel, x-forwarded-for is set by the edge to the connecting client.
  return (req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '').split(',')[0].trim();
}

function upstreamHeaders(req, extra = {}) {
  const h = { 'x-rh-proxy-key': KEY, 'x-rh-client-ip': clientIp(req), ...extra };
  for (const k of ['content-type', 'x-rh-sig', 'last-event-id', 'user-agent']) {
    const v = req.headers.get(k);
    if (v) h[k] = v;
  }
  return h;
}

const PASS = ['content-type', 'cache-control', 'retry-after', 'x-rh-parts'];
function passResponse(r, cache) {
  const h = new Headers();
  for (const k of PASS) { const v = r.headers.get(k); if (v) h.set(k, v); }
  if (cache) h.set('cache-control', cache);
  return new Response(r.body, { status: r.status, headers: h });
}

async function fixtureGet(key) {
  const f = await fixture();
  const mode = process.env.RH_FIXTURE;
  if (key === 'state') return json(f.fixtureState(mode));
  if (key === 'signups/count') return json(f.fixtureCount(mode));
  if (key !== 'events') return null;
  const enc = new TextEncoder();
  let timer;
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`event: snapshot\ndata: ${JSON.stringify(f.fixtureState(mode))}\n\n`));
      if (mode === 'empty') return;
      const tick = () => {
        const ev = f.fixtureEvent();
        try { ctrl.enqueue(enc.encode(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)); } catch { return; }
        timer = setTimeout(tick, 1400 + Math.random() * 2600);
      };
      timer = setTimeout(tick, 1500);
    },
    cancel() { clearTimeout(timer); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
}

export async function GET(req, { params }) {
  const key = (await params).path.join('/');
  if (DEV_FIXTURE) { const r = await fixtureGet(key); if (r) return r; }
  if (!allowedGet(key)) return json({ error: 'not_found' }, 404);
  if (!RH) return json({ error: 'unconfigured' }, 503);
  const path = key.startsWith('cards/') ? `cards/${encodeURIComponent(key.slice(6))}` : key;
  const target = ONBOARDING.has(key) ? `${RH}/${key}` : `${RH}/api/${path}${new URL(req.url).search}`;
  try {
    if (key === 'events') {
      const r = await fetch(target, { cache: 'no-store', headers: upstreamHeaders(req, { accept: 'text/event-stream' }), signal: req.signal });
      const h = new Headers({ 'content-type': r.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
      return new Response(r.body, { status: r.status, headers: h });
    }
    const r = await fetch(target, { cache: 'no-store', headers: upstreamHeaders(req), signal: AbortSignal.timeout(10_000) });
    const cache = !r.ok ? 'no-store' : key === 'signups/count' ? 'public, s-maxage=5' : key.startsWith('source/') ? 'public, max-age=31536000, immutable' : CACHE[key] || 'no-store';
    return passResponse(r, cache);
  } catch {
    return json({ error: 'unreachable' }, 503);
  }
}

export async function POST(req, { params }) {
  const key = (await params).path.join('/');
  if (!POSTS.has(key)) return json({ error: 'not_found' }, 404);
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return json({ error: 'too_large' }, 413);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_BODY) return json({ error: 'too_large' }, 413);
  if (DEV_FIXTURE && key === 'signup') {
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: 'bad_json' }, 400); }
    return json((await fixture()).fixtureSignup(body));
  }
  if (!RH) return json({ error: 'unconfigured' }, 503);
  try {
    const r = await fetch(`${RH}/api/${key}`, {
      method: 'POST',
      cache: 'no-store',
      headers: upstreamHeaders(req),
      body: bytes,
      signal: AbortSignal.timeout(20_000),
    });
    return passResponse(r, 'no-store');
  } catch {
    return json({ error: 'unreachable' }, 503);
  }
}
