'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { RH_API, fmt } from '@/lib/rh';
import { getJSON, since, toMs, LABELS } from '@/lib/board';
import { Tex } from '@/lib/tex';

const MAP_POLL_MS = 30_000;
const mapHref = (m) => `/map?m=${encodeURIComponent(m)}`;
const pct = (a, b) => (b > 0 ? (100 * a) / b : 0);
const pctText = (a, b) => {
  const p = pct(a, b);
  if (p === 0) return '0%';
  if (p < 0.1) return '<0.1%';
  return (p < 10 ? p.toFixed(1) : p.toFixed(0)) + '%';
};

export default function Atlas() {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get('m') || '';
  const [map, setMap] = useState(null);
  const [err, setErr] = useState('');
  const [people, setPeople] = useState(null);

  useEffect(() => {
    let alive = true;
    const ctl = new AbortController();
    const load = () =>
      getJSON(`${RH_API}/map`, ctl.signal)
        .then((d) => { if (alive) { setMap(d); setErr(''); } })
        .catch((e) => { if (alive && e.name !== 'AbortError') setErr('The map is not reachable right now.'); });
    load();
    const t = setInterval(load, MAP_POLL_MS);
    getJSON(`${RH_API}/contributors`, ctl.signal).then((d) => alive && setPeople(d)).catch(() => {});
    return () => { alive = false; ctl.abort(); clearInterval(t); };
  }, []);

  const choose = useCallback((m) => {
    router.push(m ? mapHref(m) : '/map', { scroll: false });
  }, [router]);

  const t = map?.totals;

  return (
    <main className="pub at">
      <section className="at-head">
        <div className="col">
          <p className="at-crumb"><Link href="/">The Riemann Hypothesis</Link></p>
          <h1>The map</h1>
          <p className="at-lede">Each Lean module of the proof, read into English by two independent runs.</p>
        </div>
      </section>

      <section className="col">
        {err && !map && <p className="err">{err}</p>}
        {!map && !err && <p className="at-quiet">Loading.</p>}
        {t && (
          <>
            <p className="at-big">
              <span className="mono">{fmt(t.cards)}</span> of <span className="mono">{fmt(t.modules)}</span> modules have a card
              <span className="at-pct mono">{pctText(t.cards, t.modules)}</span>
            </p>
            <p className="at-label" title="two independent runs agree on the reading"><span className="at-mark">≈</span> {map.label || 'two-run agreement'}</p>
            <div className="live at-live">
              <div><span className="mono">{fmt(t.lines)}</span><span>lines</span></div>
              <div><span className="mono">{fmt((t.max_depth ?? 0) + 1)}</span><span>import levels</span></div>
              <div><span className="mono">{fmt(t.units_loaded)}</span><span>modules loaded</span></div>
              <div><span className="mono">{fmt(t.runs_valid)}</span><span>valid runs of {fmt(t.runs)}</span></div>
              {t.lane_hours != null && <div><span className="mono">{fmt(t.lane_hours)}</span><span>agent hours</span></div>}
            </div>
          </>
        )}
      </section>

      {map?.levels?.length > 0 && <Levels levels={map.levels} />}

      <section className="col at-sec" id="read">
        <h2>Read a module</h2>
        <Search onChoose={choose} />
        {selected && <CardView key={selected} module={selected} />}
      </section>

      {map?.recent?.length > 0 && (
        <section className="col at-sec">
          <h2>Recent cards</h2>
          <ol className="at-list">
            {map.recent.slice(0, 12).map((r) => (
              <li key={r.key || r.module + r.at}>
                <Link className="mono at-mod" href={mapHref(r.module)} scroll={false}>{r.module}</Link>
                <span className="at-meta">depth <span className="mono">{r.depth}</span> · {since(r.at)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {map?.areas?.length > 0 && <Areas areas={map.areas} />}

      <Replay replay={map?.replay} />

      <Trust />

      {people?.contributors?.length > 0 && (
        <section className="col at-sec">
          <h2>Readers</h2>
          <ol className="at-roster">
            {[...people.contributors]
              .sort((a, b) => (b.cards_accepted ?? 0) - (a.cards_accepted ?? 0) || (b.runs ?? 0) - (a.runs ?? 0))
              .slice(0, 24)
              .map((c) => (
                <li key={c.handle + (c.github || '')}>
                  <Who handle={c.handle} github={c.github} />
                  <span className="mono at-n">{fmt(c.cards_accepted)}</span>
                  <span className="at-meta">cards · <span className="mono">{fmt(c.runs)}</span> runs</span>
                </li>
              ))}
          </ol>
        </section>
      )}

      <footer className="pfoot">
        <div className="sources at-legend">
          <span>Labels</span>
          {LABELS.map((l) => (
            <span key={l.key} className="at-leg" title={l.note}><span className="at-mark">{l.mark}</span> {l.name}</span>
          ))}
        </div>
        <div className="sources">
          <Link href="/board">The board</Link>
          <Link href="/">Home</Link>
        </div>
      </footer>
    </main>
  );
}

function Who({ handle, github }) {
  if (github) {
    return <a href={`https://github.com/${encodeURIComponent(github)}`} target="_blank" rel="noopener noreferrer">@{github}</a>;
  }
  return <span>{handle || 'anonymous'}</span>;
}

/* ── levels: one thin column per import depth ─────────────────────── */

function Levels({ levels }) {
  const lv = useMemo(() => [...levels].sort((a, b) => a.depth - b.depth), [levels]);
  const n = lv.length;
  const maxM = useMemo(() => Math.max(1, ...lv.map((l) => l.modules || 0)), [lv]);
  const [hover, setHover] = useState(null);
  const [pin, setPin] = useState(null);
  const wrap = useRef(null);
  const H = 100;

  const idxAt = (clientX) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    return Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)));
  };

  const shown = hover ?? pin;
  const cur = shown != null ? lv[shown] : null;

  const onKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    setPin((p) => {
      const base = p ?? 0;
      if (e.key === 'Home') return 0;
      if (e.key === 'End') return n - 1;
      return Math.max(0, Math.min(n - 1, base + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1)));
    });
  };

  const ticks = [0, 50, 100, 150].filter((d) => d < n - 12);

  return (
    <section className="at-levels">
      <div className="col">
        <h2>By import level</h2>
        <p className="at-quiet">Leaves on the left import nothing from the project; Main is at the top of the tree, on the right. Height shows modules, on a square-root scale.</p>
      </div>
      <div className="at-chart">
        <div
          className="at-plot"
          ref={wrap}
          tabIndex={0}
          role="slider"
          aria-label="Import level"
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={shown ?? 0}
          aria-valuetext={cur ? `depth ${cur.depth}, ${cur.modules} modules, ${cur.cards} cards` : 'none'}
          onKeyDown={onKey}
          onPointerMove={(e) => { if (e.pointerType === 'mouse') setHover(idxAt(e.clientX)); }}
          onPointerLeave={() => setHover(null)}
          onPointerDown={(e) => { const i = idxAt(e.clientX); setPin((p) => (p === i && e.pointerType !== 'mouse' ? null : i)); }}
        >
          <svg viewBox={`0 0 ${n} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {lv.map((l, i) => {
              const m = l.modules || 0;
              if (!m) return null;
              const h = Math.max(1.2, Math.sqrt(m / maxM) * H);
              const fl = Math.min(1, (l.units_loaded || 0) / m) * h;
              const fc = Math.min(1, (l.cards || 0) / m) * h;
              const on = i === shown;
              return (
                <g key={l.depth}>
                  <rect x={i + 0.14} width={0.72} y={H - h} height={h} className={on ? 'lv-bg on' : 'lv-bg'} />
                  {fl > 0 && <rect x={i + 0.14} width={0.72} y={H - fl} height={fl} className="lv-ld" />}
                  {fc > 0 && <rect x={i + 0.14} width={0.72} y={H - Math.max(fc, 0.6)} height={Math.max(fc, 0.6)} className="lv-cd" />}
                </g>
              );
            })}
          </svg>
          {shown != null && <span className="at-cursor" style={{ left: `${((shown + 0.5) / n) * 100}%` }} />}
        </div>
        <div className="at-axis">
          {ticks.map((d) => (
            <span key={d} className="mono" style={{ left: `${((d + 0.5) / n) * 100}%` }}>{d}</span>
          ))}
          <span className="mono at-axis-end">{lv[n - 1]?.depth}</span>
        </div>
        <div className="at-axis-words"><span>leaves</span><span>Main</span></div>
        <div className="at-readout" aria-live="polite">
          {cur ? (
            <>
              <span>depth <span className="mono">{cur.depth}</span>{cur.depth === 0 ? ' · leaves' : cur.depth === lv[n - 1].depth ? ' · Main' : ''}</span>
              <span><span className="mono">{fmt(cur.modules)}</span> modules</span>
              <span><span className="mono">{fmt(cur.lines)}</span> lines</span>
              <span><span className="mono">{fmt(cur.cards)}</span> cards</span>
              <span><span className="mono">{fmt(cur.units_loaded)}</span> loaded</span>
              {cur.units_one_run > 0 && <span><span className="mono">{fmt(cur.units_one_run)}</span> one run</span>}
              {cur.units_gap > 0 && <span><span className="mono">{fmt(cur.units_gap)}</span> gaps</span>}
            </>
          ) : (
            <span className="at-quiet">Point at a level, or tap it.</span>
          )}
        </div>
        <div className="at-key">
          <span><i className="k-cd" />carded</span>
          <span><i className="k-ld" />loaded</span>
          <span><i className="k-bg" />not yet loaded</span>
        </div>
      </div>
    </section>
  );
}

/* ── areas ─────────────────────────────────────────────────────────── */

function Areas({ areas }) {
  const top = useMemo(() => [...areas].sort((a, b) => (b.modules || 0) - (a.modules || 0)).slice(0, 12), [areas]);
  return (
    <section className="col at-sec">
      <h2>Largest areas</h2>
      <table className="at-table">
        <thead>
          <tr><th>area</th><th className="n">modules</th><th className="n">cards</th></tr>
        </thead>
        <tbody>
          {top.map((a) => (
            <tr key={a.area}>
              <td className="mono at-area">{a.area}</td>
              <td className="n mono">{fmt(a.modules)}</td>
              <td className="n mono">{fmt(a.cards)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {areas.length > 12 && <p className="at-quiet">{fmt(areas.length)} areas in all.</p>}
    </section>
  );
}

/* ── search ────────────────────────────────────────────────────────── */

function Search({ onChoose }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setRes(null); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      getJSON(`${RH_API}/search?q=${encodeURIComponent(s)}`, ctl.signal)
        .then((d) => { setRes(d.modules || []); setBusy(false); })
        .catch((e) => { if (e.name !== 'AbortError') { setRes([]); setBusy(false); } });
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);

  return (
    <div className="at-search">
      <label className="fld">
        <span className="lbl">Module name, or part of one</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ZetaFunction"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Enter' && res?.[0]) { onChoose(res[0].name); setQ(''); } }}
        />
      </label>
      {busy && !res && <p className="at-quiet">Searching.</p>}
      {res && res.length === 0 && !busy && <p className="at-quiet">No module matches.</p>}
      {res && res.length > 0 && (
        <ul className="at-results">
          {res.map((m) => (
            <li key={m.name}>
              <button type="button" onClick={() => { onChoose(m.name); setQ(''); }}>
                <span className="mono at-mod">{m.name}</span>
                <span className="at-meta">
                  depth <span className="mono">{m.depth}</span> · <span className="mono">{fmt(m.lines)}</span> lines
                  {m.cards > 0 && <> · <span title="has a card">≈</span></>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── one module's card ─────────────────────────────────────────────── */

function CardView({ module }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const ctl = new AbortController();
    setD(null); setErr('');
    getJSON(`${RH_API}/cards/${encodeURIComponent(module)}`, ctl.signal)
      .then(setD)
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setErr(e.status === 404 ? 'No module by that name.' : 'The card is not reachable right now.');
      });
    return () => ctl.abort();
  }, [module]);

  useEffect(() => {
    if (d && ref.current) {
      const r = ref.current.getBoundingClientRect();
      if (r.top < 0 || r.top > window.innerHeight * 0.6) ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [d]);

  return (
    <article className="at-card" ref={ref}>
      <h3 className="mono at-name">{module}</h3>
      {err && <p className="err">{err}</p>}
      {!d && !err && <p className="at-quiet">Loading.</p>}
      {d && (
        <>
          <dl className="at-facts">
            <div><dt>depth</dt><dd className="mono">{d.depth}</dd></div>
            <div><dt>area</dt><dd className="mono">{d.area}</dd></div>
            <div><dt>lines</dt><dd className="mono">{fmt(d.lines)}</dd></div>
            {d.theorems != null && <div><dt>theorems</dt><dd className="mono">{fmt(d.theorems)}</dd></div>}
            {d.declarations != null && <div><dt>declarations</dt><dd className="mono">{fmt(d.declarations)}</dd></div>}
            <div><dt>status</dt><dd>{d.status}{d.unit?.valid_runs != null && d.status !== 'accepted' ? <> · <span className="mono">{d.unit.valid_runs}</span> valid runs</> : null}</dd></div>
          </dl>

          {d.cards?.length > 0 ? (
            d.cards.map((c) => <Reading key={c.key} c={c} />)
          ) : (
            <p className="at-quiet">No card yet.</p>
          )}

          {d.imports?.length > 0 && (
            <div className="at-imports">
              <h4>Imports <span className="mono">{d.imports.length}</span></h4>
              <ul>
                {d.imports.map((im) => (
                  <li key={im.module}>
                    <Link href={mapHref(im.module)} scroll={false} className="mono">{im.module}</Link>
                    {im.card && <span className="at-has" title="has a card"> ≈</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.sha256 && <p className="at-sha mono" title="sha256 of the Lean source">{d.sha256}</p>}
        </>
      )}
    </article>
  );
}

function Reading({ c }) {
  const p = c.part;
  return (
    <section className="at-reading">
      <p className="at-rhead">
        <span className="at-mark" title="agreement: two independent runs agree">≈</span>
        <span>{c.label || 'agreement'}</span>
        {p && p.n > 1 && <span>part <span className="mono">{p.i}</span> of <span className="mono">{p.n}</span>{p.from_line != null && <>, lines <span className="mono">{p.from_line}–{p.to_line}</span></>}</span>}
        {c.at && toMs(c.at) > 0 && <span>{since(c.at)}</span>}
      </p>
      {c.trust && <p className="at-trust">{c.trust}</p>}
      <CardBody card={c.card} />
      {c.readers?.length > 0 && (
        <p className="at-readers">
          Read by{' '}
          {c.readers.map((r, i) => (
            <span key={(r.github || r.handle) + i}>{i > 0 && (i === c.readers.length - 1 ? ' and ' : ', ')}<Who handle={r.handle} github={r.github} /></span>
          ))}
        </p>
      )}
      {c.second && (
        <details className="at-second">
          <summary>second reading</summary>
          <CardBody card={c.second} />
        </details>
      )}
    </section>
  );
}

function CardBody({ card }) {
  if (!card) return null;
  return (
    <div className="at-body">
      {card.summary && <p className="at-summary">{card.summary}</p>}
      {card.role_in_proof && <p className="at-role">{card.role_in_proof}</p>}
      {card.statements?.length > 0 && (
        <ol className="at-stmts">
          {card.statements.map((s, i) => (
            <li key={(s.lean_name || '') + i}>
              {s.lean_name && <div className="mono at-lean">{s.lean_name}</div>}
              {s.latex && <Tex src={s.latex} display className="at-tex" />}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Replay({ replay }) {
  const rows = Array.isArray(replay) ? replay : [];
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  return (
    <section className="col at-sec">
      <h2>Rebuilt from source</h2>
      <p className="at-quiet">
        Track R rebuilds the published archive packet by packet with the pinned toolchain. A packet counts when two
        machines produce byte-identical compiled files and Lean&rsquo;s kernel replays them: <span className="at-mark">⛓</span>.
      </p>
      {rows.length ? (
        <>
          <div className="live at-live">
            <div><span className="mono">{fmt(sum('accepted'))}</span><span>accepted</span></div>
            <div><span className="mono">{fmt(sum('in_flight'))}</span><span>in flight</span></div>
            <div><span className="mono">{fmt(sum('mismatched'))}</span><span>mismatched</span></div>
            <div><span className="mono">{fmt(sum('packets'))}</span><span>packets loaded</span></div>
          </div>
          <ol className="at-list">
            {rows.map((r) => (
              <li key={r.depth}>
                <span className="at-meta">depth <span className="mono">{r.depth}</span></span>
                <span className="at-meta"><span className="mono">{fmt(r.accepted)}</span> accepted · <span className="mono">{fmt(r.in_flight)}</span> in flight · <span className="mono">{fmt(r.mismatched)}</span> mismatched · <span className="mono">{fmt(r.packets)}</span> packets</span>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="at-quiet">No packets yet.</p>
      )}
      <p className="at-quiet">
        A sibling effort replays the same archive through public GitHub claims:{' '}
        <a href="https://github.com/rohanarun/alpoge-rh-replay" target="_blank" rel="noopener noreferrer">alpoge-rh-replay</a>.
      </p>
    </section>
  );
}

function Trust() {
  const [t, setT] = useState(null);
  useEffect(() => {
    let live = true;
    fetch('/api/rh/trust', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live) setT(d); }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!t?.tiers) return null;
  const pct = (x) => `${(Number(x || 0) * 100).toFixed(x && x < 0.01 ? 1 : 0)}%`;
  return (
    <section className="col at-sec" id="trust">
      <h2>Trust</h2>
      <p className="at-quiet">
        Anyone can join. Trust is earned: a machine becomes established by agreeing with independent machines,
        and loses it by disagreeing. Agreement counts only between different keys, networks and GitHub accounts.
      </p>
      <div className="live at-live">
        <div><span className="mono">{fmt(t.tiers.new)}</span><span>new</span></div>
        <div><span className="mono">{fmt(t.tiers.established)}</span><span>established</span></div>
        <div><span className="mono">{fmt(t.tiers.trusted)}</span><span>trusted</span></div>
        <div><span className="mono">{fmt(t.tiers.quarantined)}</span><span>quarantined</span></div>
      </div>
      <div className="live at-live">
        <div><span className="mono">{pct(t.audits?.target_rate)}</span><span>of accepted work re-checked, and all work accepted only by new machines</span></div>
        <div><span className="mono">{fmt(t.audits?.passed)} / {fmt(t.audits?.failed)}</span><span>audits passed / failed</span></div>
        <div><span className="mono">{pct(t.results?.disagreement_rate)}</span><span>disagreement</span></div>
      </div>
      {t.instruments?.card_runs?.total > 0 && (
        <p className="at-quiet">
          Every attempt counts, not only successes: <span className="mono">{fmt(t.instruments.card_runs.total)}</span> card runs,
          {' '}<span className="mono">{fmt(t.instruments.card_runs.by_status?.invalid || 0)}</span> rejected
          {' '}(<span className="mono">{fmt(t.instruments.card_runs.discarded_by_clients || 0)}</span> discarded by the clients' own screens).
          {t.lanes?.total?.calls > 0 && <> Lanes so far: <span className="mono">{fmt(t.lanes.total.calls)}</span> calls, <span className="mono">${t.lanes.total.cost_usd}</span> API-equivalent (billed to subscriptions).</>}
        </p>
      )}
      {t.instruments?.arms && Object.keys(t.instruments.arms).length > 0 && (
        <>
          <p className="at-quiet">Does reading the board help? Some research cycles run as controls: alone (no board), with a random action, or on the least-touched areas.</p>
          <ol className="at-list">
            {Object.entries(t.instruments.arms).map(([arm, a]) => (
              <li key={arm}>
                <span className="at-meta"><i>{arm}</i></span>
                <span className="at-meta"><span className="mono">{fmt(a.posts)}</span> posts · <span className="mono">{fmt(a.cited)}</span> cited · <span className="mono">{fmt(a.supported)}</span> supported · <span className="mono">{fmt(a.artifacts_reproduced)}</span> with a reproduced fact</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
