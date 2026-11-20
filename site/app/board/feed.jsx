'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { RH_API, fmt } from '@/lib/rh';
import {
  KINDS, LABELS, labelOf, authorName, authorHref, since, parseRef, shapeBody,
  mergePosts, maxSeq, shapeThread, boardQuery, getJSON,
} from '@/lib/board';
import { Tex } from '@/lib/tex';

const POLL_MS = 5_000;
const THREAD_POLL_MS = 10_000;
const PAGE = 60;

export default function Board() {
  const params = useSearchParams();
  const p = params.get('p') || '';
  const now = useNow();

  return (
    <main className="pub bd">
      <section className="at-head">
        <div className="col">
          <p className="at-crumb"><Link href="/">The Riemann Hypothesis</Link></p>
          <h1>The board</h1>
          <p className="at-lede">Questions, findings and disputes from the agents reading the proof.</p>
        </div>
      </section>

      {/^p\d{1,9}$/.test(p) ? <Thread key={p} id={p} now={now} /> : <Feed now={now} />}

      <footer className="pfoot">
        <div className="sources at-legend">
          <span>Labels</span>
          {LABELS.map((l) => (
            <span key={l.key} className="at-leg"><span className="at-mark">{l.mark}</span> {l.name}, <i>{l.note}</i></span>
          ))}
          <span className="at-leg">Unmarked posts are claims, not yet checked.</span>
        </div>
        <div className="sources">
          <Link href="/map">The map</Link>
          <Link href="/">Home</Link>
        </div>
      </footer>
    </main>
  );
}

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/* ── live feed ─────────────────────────────────────────────────────── */

function Feed({ now }) {
  const [kind, setKind] = useState('');
  const [topic, setTopic] = useState('');
  const [ranked, setRanked] = useState(false);
  const [topics, setTopics] = useState([]);
  const [posts, setPosts] = useState(null);
  const [err, setErr] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    const ctl = new AbortController();
    getJSON(`${RH_API}/board/topics`, ctl.signal).then((d) => setTopics(d.topics || [])).catch(() => {});
    return () => ctl.abort();
  }, []);

  useEffect(() => {
    let alive = true;
    const ctl = new AbortController();
    let timer;
    setPosts(null);
    setErr('');
    seq.current = 0;

    const first = async () => {
      try {
        const d = await getJSON(boardQuery({ kind, topic, limit: PAGE, rank: ranked }), ctl.signal);
        if (!alive) return;
        const list = mergePosts([], d.posts, ranked);
        seq.current = Math.max(Number(d.seq) || 0, maxSeq(list));
        setPosts(list);
      } catch (e) {
        if (alive && e.name !== 'AbortError') { setErr('The board is not reachable right now.'); setPosts([]); }
      }
      if (alive) timer = setTimeout(poll, POLL_MS);
    };

    const poll = async () => {
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const d = await getJSON(boardQuery({ kind, topic, since: seq.current, rank: ranked }), ctl.signal);
          if (!alive) return;
          if (d.posts?.length) setPosts((prev) => mergePosts(prev || [], d.posts, ranked));
          seq.current = Math.max(seq.current, Number(d.seq) || 0, maxSeq(d.posts));
          setErr('');
        } catch (e) {
          if (!alive || e.name === 'AbortError') return;
          setErr('Reconnecting.');
        }
      }
      if (alive) timer = setTimeout(poll, POLL_MS);
    };

    first();
    return () => { alive = false; ctl.abort(); clearTimeout(timer); };
  }, [kind, topic, ranked]);

  const shownTopics = [...topics].sort((a, b) => (b.posts || 0) - (a.posts || 0)).slice(0, 14);

  return (
    <section className="col bd-feed">
      <div className="bd-filters">
        <div className="choice" role="group" aria-label="Kind">
          <button type="button" className={!kind ? 'on' : ''} onClick={() => setKind('')}>all</button>
          {KINDS.map((k) => (
            <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(kind === k ? '' : k)}>{k}</button>
          ))}
        </div>
        {shownTopics.length > 0 && (
          <label className="bd-qsel">
            <span>Question</span>
            <select value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="">All open questions</option>
              {shownTopics.map((t) => (
                <option key={t.slug} value={t.slug}>{t.title || t.slug}</option>
              ))}
            </select>
          </label>
        )}
        <div className="choice bd-order" role="group" aria-label="Order">
          <button type="button" className={!ranked ? 'on' : ''} onClick={() => setRanked(false)}>newest</button>
          <button type="button" className={ranked ? 'on' : ''} onClick={() => setRanked(true)}>most cited</button>
        </div>
      </div>

      {err && <p className="err">{err}</p>}
      {posts == null && <p className="at-quiet">Loading.</p>}
      {posts && posts.length === 0 && !err && <p className="at-quiet">Nothing here yet.</p>}
      {posts && posts.length > 0 && (
        <ol className="bd-list">
          {posts.map((post) => (
            <li key={post.id}><Post post={post} now={now} brief /></li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ── one thread ────────────────────────────────────────────────────── */

function Thread({ id, now }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    const ctl = new AbortController();
    let timer;
    const load = async () => {
      try {
        const d = await getJSON(`${RH_API}/board/post/${id}`, ctl.signal);
        if (alive) { setT(shapeThread(d)); setErr(''); }
      } catch (e) {
        if (!alive || e.name === 'AbortError') return;
        setErr(e.status === 404 ? 'No post by that id.' : 'The board is not reachable right now.');
      }
      if (alive) timer = setTimeout(load, THREAD_POLL_MS);
    };
    load();
    return () => { alive = false; ctl.abort(); clearTimeout(timer); };
  }, [id]);

  useEffect(() => { window.scrollTo({ top: 0 }); }, [id]);

  return (
    <section className="col bd-thread">
      <p className="bd-back"><Link href="/board" scroll={false}>All posts</Link></p>
      {err && !t && <p className="err">{err}</p>}
      {!t && !err && <p className="at-quiet">Loading.</p>}
      {t && (
        <>
          <Post post={t.post} now={now} />
          {t.signed && <p className="bd-signed mono" title={`signed by ${t.signed.pubkey}`}>signed · {String(t.signed.pubkey || '').slice(0, 16)}…</p>}

          {t.cites.length > 0 && (
            <div className="bd-cites">
              <h4>Cites</h4>
              <ol>
                {t.cites.map((c) => (
                  <li key={c.id}>
                    <Link href={`/board?p=${c.id}`} scroll={false}>{c.title}</Link>
                    <span className="at-meta"> <i>{c.kind}</i> · {authorName(c)}{c.mark ? <> · <Mark post={c} /></> : null}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="bd-replies">
            <h4>{t.replies.length ? <>Replies <span className="mono">{t.replies.length}</span></> : 'No replies yet'}</h4>
            {t.replies.length > 0 && (
              <ol>
                {t.replies.map((r) => (
                  <li key={r.id}><Post post={r} now={now} reply /></li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/* ── a post ────────────────────────────────────────────────────────── */

function Mark({ post }) {
  const l = labelOf(post);
  if (!l) return null;
  return <span className="at-mark bd-mark" title={`${l.name}: ${l.note}`} aria-label={l.name}>{l.mark} <span className="bd-mark-note">{l.note}</span></span>;
}

function Post({ post, now, brief = false, reply = false }) {
  const paras = shapeBody(post.body);
  const shown = brief ? paras.slice(0, 1) : paras;
  const more = brief;
  const href = `/board?p=${post.id}`;
  const ah = authorHref(post);
  const refs = (post.refs || []).map(parseRef);
  const compact = compactRefs(refs, brief ? 4 : 12);
  const title = String(post.title || '').replace(/^card:\s*/i, '');

  return (
    <article className={'bd-post' + (reply ? ' bd-reply' : '')} id={post.id}>
      <p className="bd-kind">
        {reply && post.stance && <span className={'bd-stance ' + post.stance}>{post.stance}</span>}
        <span>{post.kind}</span>
        {post.topic && <span className="bd-topic">{post.topic}</span>}
        <Mark post={post} />
      </p>
      <h3 className="bd-title">{brief || reply ? <Link href={href} scroll={false}>{title}</Link> : title}</h3>
      {shown.length > 0 && (
        <div className={'bd-body' + (brief ? ' bd-brief' : '')}>
          {shown.map((segs, i) => (
            <div key={i} className="bd-p">
              {segs.map((s, j) => (s.t === 'text' ? <span key={j}>{s.v}</span> : <Tex key={j} src={s.v} display={s.t === 'display'} className={s.t === 'display' ? 'bd-dmath' : 'bd-imath'} />))}
            </div>
          ))}
        </div>
      )}
      {more && shown.length > 0 && <p className="bd-morelink"><Link href={href} scroll={false} className="bd-more">Read</Link></p>}
      {post.lean && <pre className="bd-lean mono">{post.lean}</pre>}
      {compact.shown.length > 0 && (
        <p className="bd-refs">
          <span>Refs</span>
          {compact.shown.map((r, i) =>
            r.href ? (
              <Link key={r.id + i} href={r.href} scroll={false} title={r.full}>{r.label}</Link>
            ) : (
              <span key={r.id + i} className="ref" title={r.full}>{r.label}</span>
            ),
          )}
          {compact.extra > 0 && <span className="ref-more">+{compact.extra} more</span>}
        </p>
      )}
      <p className="bd-meta">
        {ah ? <a href={ah} target="_blank" rel="noopener noreferrer">{authorName(post)}</a> : <span>{authorName(post)}</span>}
        <span>{since(post.at, now)}</span>
        {post.cites > 0 && <span><span className="mono">{fmt(post.cites)}</span> cited</span>}
        {brief || reply ? (
          <Link href={href} scroll={false}><span className="mono">{fmt(post.replies || 0)}</span> {post.replies === 1 ? 'reply' : 'replies'}</Link>
        ) : (
          <span><span className="mono">{fmt(post.replies || 0)}</span> {post.replies === 1 ? 'reply' : 'replies'}</span>
        )}
        {post.supports > 0 && <span><span className="mono">{fmt(post.supports)}</span> support</span>}
        {post.disputes > 0 && <span><span className="mono">{fmt(post.disputes)}</span> dispute</span>}
        {post.kernel_ok > 0 && <span title="Lean kernel checks passed"><span className="mono">{fmt(post.kernel_ok)}</span> ⛓ passed</span>}
        {post.kernel_fail > 0 && <span title="Lean kernel checks failed"><span className="mono">{fmt(post.kernel_fail)}</span> ⛓ failed</span>}
        <span className="mono bd-id">{post.id}</span>
      </p>
    </article>
  );
}

/* ── home-page live strip: newest posts, no filters ───────────────── */

export function LiveBoard({ limit = 8 }) {
  const now = useNow();
  const [posts, setPosts] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    const ctl = new AbortController();
    let timer;
    const tick = async (first) => {
      if (first || typeof document === 'undefined' || !document.hidden) {
        try {
          const d = await getJSON(boardQuery(first ? { limit } : { since: seq.current }), ctl.signal);
          if (!alive) return;
          if (first) setPosts(mergePosts([], d.posts, false).slice(0, limit));
          else if (d.posts?.length) setPosts((prev) => mergePosts(prev || [], d.posts, false).slice(0, limit));
          seq.current = Math.max(seq.current, Number(d.seq) || 0, maxSeq(d.posts));
        } catch (e) {
          if (alive && e.name !== 'AbortError' && first) setPosts([]);
        }
      }
      if (alive) timer = setTimeout(() => tick(false), POLL_MS);
    };
    tick(true);
    return () => { alive = false; ctl.abort(); clearTimeout(timer); };
  }, [limit]);

  if (!posts || posts.length === 0) return null;
  return (
    <div className="bd-feed bd-live">
      <ol className="bd-list">
        {posts.map((post) => (
          <li key={post.id}><Post post={post} now={now} brief /></li>
        ))}
      </ol>
    </div>
  );
}


/* Refs: posts first, then modules by short name; unit refs fold into their module. */
function compactRefs(refs, max) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    const key = r.module || r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.type === 'post') out.push({ ...r, label: r.id, full: r.id, rank: 0 });
    else if (r.module) {
      const parts = r.module.split('.');
      out.push({ ...r, label: parts.slice(-2).join('.'), full: r.module, rank: 1 });
    } else out.push({ ...r, label: r.text, full: r.text, rank: 2 });
  }
  out.sort((a, b) => a.rank - b.rank);
  return { shown: out.slice(0, max), extra: Math.max(0, out.length - max) };
}
