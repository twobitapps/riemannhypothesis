// POST /api/vboard — the coordinator announces a new board post; mirror it to
// the team's Vercel Board (RH_VERCEL_BOARD=1 only). Caller must hold the
// coordinator's shared key. Best-effort: always answers quickly, never retries.
import { ENABLED, mirror, pullCompletions } from '@/lib/vboard';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function POST(req) {
  const key = process.env.RH_PROXY_KEY || '';
  if (key.length < 16 || !same(req.headers.get('x-rh-proxy-key') || '', key)) return json({ error: 'not_found' }, 404);
  if (!ENABLED) return json({ ok: true, mirrored: false, reason: 'RH_VERCEL_BOARD is off' });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const out = { ok: true };
  try {
    const m = body?.post ? await mirror(body.post) : null;
    out.mirrored = !!m; out.board_id = m?.id ?? null;
  } catch (e) { out.mirrored = false; out.error = String(e?.code || e?.message || e).slice(0, 200); console.warn('vboard mirror failed', out.error); }
  try { out.completions = await pullCompletions(); } catch (e) { out.completions_error = String(e?.message || e).slice(0, 200); }
  return json(out);
}
