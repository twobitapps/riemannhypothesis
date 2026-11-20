// Vercel Board watchers for the swarm (RH_VERCEL_BOARD=1 only). Vercel's API
// wakes this route when an event matches a tail. A new message in rh/lemmas
// that mirrors one of our posts enqueues a kernel check in the coordinator,
// so the Board is the event-driven trigger for verification.
import { ENABLED, coordPost } from '@/lib/vboard';

export const dynamic = 'force-dynamic';

let fetchHandler = null;
async function handler() {
  if (!fetchHandler) {
    const { board } = await import('@vercel/board');
    const team = board({
      basePath: '/api/vboard/watch',
      watch: {
        lemmas: {
          tail: 'rh/lemmas',
          run: async ({ event }) => {
            if (event.type !== 'message.posted') return;
            const rh = event.message?.labels?.rh;
            if (typeof rh === 'string' && /^p\d+$/.test(rh)) await coordPost('board/enqueue-check', { post_id: rh }).catch(() => {});
          },
        },
      },
    });
    fetchHandler = team.fetch;
  }
  return fetchHandler;
}

const off = () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
export async function GET(req) { return ENABLED ? (await handler())(req) : off(); }
export async function POST(req) { return ENABLED ? (await handler())(req) : off(); }
