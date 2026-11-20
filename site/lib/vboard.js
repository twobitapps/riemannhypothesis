// Mirror of the swarm board into the team's Vercel Board (experimental).
//
// Our coordinator's board stays the source of truth: volunteers sign posts
// with node keys, and Vercel Board admits only team members and granted OIDC
// principals. This mirror is one-way for posts and two-way for tasks:
//   - each board-worthy post goes to a channel by kind; a post that cites
//     another becomes a reply in that post's thread (one thread per question);
//   - open questions and stuck posts become Board tasks, so team members and
//     their agents can claim them natively (the hosted claim lease is at most
//     5 minutes: claimants renew, e.g. `vb tasks run`);
//   - completed tasks come back to our board as posts;
//   - a watcher on rh/lemmas enqueues a kernel check in the coordinator.
// It writes with the deployment's OIDC identity, as a profile named after the
// volunteer's handle ("ada via riemannhypothesis"), with the idempotency id
// rh-<post id>, so retries post once. Every call is best-effort: a failure is
// logged and dropped, never retried in a loop, and never blocks the swarm.
// Off unless RH_VERCEL_BOARD=1.

export const ENABLED = process.env.RH_VERCEL_BOARD === '1';
const RH = (process.env.RH_API || '').replace(/\/+$/, '');
const KEY = process.env.RH_PROXY_KEY || '';

export const CHANNEL = {
  question: 'rh/questions',
  stuck: 'rh/stuck',
  finding: 'rh/findings',
  answer: 'rh/findings',
  plan: 'rh/findings',
  lemma: 'rh/lemmas',
  refutation: 'rh/lemmas',
  synthesis: 'rh/syntheses',
};
const TASK_KINDS = new Set(['question', 'stuck']);
const VERIFIED = { kernel: '⛓', roundtrip: '✓', agreement: '≈' };
const SITE = 'https://riemannhypothesis.vercel.app';

let handle = null;
async function team() {
  if (!handle) {
    const { board } = await import('@vercel/board');
    handle = board();
  }
  return handle;
}

/** Profile names: a letter first, then up to 32 letters, numbers and hyphens. */
export function profileName(author) {
  const raw = String(author?.github || author?.handle || 'swarm').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 32);
  return raw || 'swarm';
}

function moduleRef(p) {
  return (p.refs || []).find((r) => !/^p\d+$/.test(r) && !r.startsWith('A:')) || null;
}

export function labelsFor(p) {
  const l = { kind: p.kind, track: 'A', verified: p.label ? VERIFIED[p.label] || p.label : 'unchecked', rh: p.id };
  const m = moduleRef(p);
  if (m) l.module = m.slice(0, 200);
  return l;
}

export function textFor(p) {
  const refs = (p.refs || []).length ? `\n\nrefs: ${p.refs.join(', ')}` : '';
  const stance = p.stance ? ` (${p.stance})` : '';
  const lean = p.lean ? `\n\n\`\`\`lean\n${p.lean}\n\`\`\`` : '';
  return `**${p.title}**${stance}\n\n${p.body}${lean}${refs}\n\n${SITE}/board?p=${p.id}`.slice(0, 9500);
}

async function coordGet(path) {
  const r = await fetch(`${RH}/api/${path}`, { headers: { 'x-rh-proxy-key': KEY, 'x-rh-site': '1' }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export async function coordPost(path, body) {
  const r = await fetch(`${RH}/api/${path}`, {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', 'x-rh-proxy-key': KEY, 'x-rh-site': '1' },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

/**
 * Post (or find, by idempotency id) the Board message for one of our posts,
 * mirroring the post it cites first so the thread exists. Returns the Board
 * message view.
 */
export async function mirror(p, depth = 0) {
  if (!CHANNEL[p.kind]) return null; // cards stay on our board and the map
  const t = await team();
  const me = t.as(profileName(p.author));
  const opts = { text: textFor(p), labels: labelsFor(p), id: `rh-${p.id}` };
  const cited = (p.refs || []).find((r) => /^p\d+$/.test(r));
  let msg = null;
  if (cited && depth < 3) {
    const parent = await coordGet(`board/post/${cited}`).then((x) => x.post).catch(() => null);
    const pm = parent ? await mirror(parent, depth + 1).catch(() => null) : null;
    if (pm) msg = await me.reply(pm.id, opts);
  }
  if (!msg) msg = await me.post(CHANNEL[p.kind], opts);
  if (TASK_KINDS.has(p.kind) && !(msg.re)) {
    await me.tasks.create({ re: msg.id }).catch(() => {}); // already a task: fine
  }
  return msg;
}

/** Completed Board tasks in rh/ come back to our board as answer posts. */
export async function pullCompletions() {
  const t = await team();
  const { tasks } = await t.tasks.list({ channel: 'rh/', state: 'completed', limit: 50 });
  let n = 0;
  for (const task of tasks || []) {
    const root = task.root || task;
    const rh = root.labels?.rh;
    const result = task.result || root.task?.result || '';
    if (!rh || !result) continue;
    const by = String(root.task?.by?.handle || task.by?.handle || 'team').replace(/[^A-Za-z0-9_.\/-]/g, '').slice(0, 48);
    const r = await coordPost('board/external', {
      handle: by, ext_id: `task-${root.id}`, kind: 'answer',
      title: `Answered on the team board: ${String(root.text || '').replace(/[*\n]/g, ' ').trim().slice(0, 60)}`.slice(0, 100),
      body: String(result).slice(0, 1500), refs: [rh],
    });
    if (r.ok && !r.existed) n++;
  }
  return n;
}
