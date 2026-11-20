import { NextResponse } from 'next/server';

// The live wall stays private until launch: RH_LAUNCHED=1 opens it; otherwise
// a visitor needs cookie rh_key === RH_SITE_KEY (set by visiting /swarm?k=<key>).

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function middleware(req) {
  if (process.env.RH_LAUNCHED === '1') return NextResponse.next();
  const key = process.env.RH_SITE_KEY || '';
  const url = req.nextUrl;
  const given = url.searchParams.get('k');

  if (given != null && url.pathname === '/swarm') {
    if (key && same(given, key)) {
      const clean = url.clone();
      clean.searchParams.delete('k');
      const res = NextResponse.redirect(clean);
      res.cookies.set('rh_key', key, { httpOnly: true, secure: url.protocol === 'https:', sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 90 });
      return res;
    }
  }

  if (key && same(req.cookies.get('rh_key')?.value || '', key)) return NextResponse.next();

  if (url.pathname.startsWith('/api/')) {
    return new NextResponse(JSON.stringify({ error: 'private' }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
  const home = url.clone();
  home.pathname = '/';
  home.search = '';
  return NextResponse.redirect(home);
}

export const config = { matcher: ['/swarm', '/swarm/:path*', '/api/rh/state', '/api/rh/events'] };
