'use client';

import { useMemo } from 'react';
import { ACTIVE, ROLE_ORDER, TRACKS, fmt, fmtRam, laneList, primaryRole } from '@/lib/rh';
import { derive, useSwarm } from './use-swarm';

const VERDICT = { ok: 'checked', fail: 'failed', gap: 'gap', skip: 'handed back' };
const MAX_ROWS = 400;
const nodeProofs = (n) => (Array.isArray(n.proofs) && n.proofs.length ? n.proofs : ['alpoge', 'masullo']);
const proofText = (n) => { const p = nodeProofs(n); return p.length > 1 ? 'both' : p[0]; };
const proofShort = (n) => { const p = nodeProofs(n); return p.length > 1 ? 'A+M' : p[0] === 'alpoge' ? 'A' : 'M'; };

const hhmmss = (ms) => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
};

function bar(done, leased, units, w = 24) {
  if (!units) return '.'.repeat(w);
  const d = Math.round((Math.min(done, units) / units) * w);
  const l = Math.min(w - d, Math.round((leased / units) * w));
  return '#'.repeat(d) + '+'.repeat(l) + '.'.repeat(w - d - l);
}

function eventLine(e, nodes) {
  const h = e.handle || nodes.get(e.node_id)?.handle || (e.node_id ? String(e.node_id).slice(0, 8) : '?');
  const unit = e.unit_id || '';
  switch (e.type) {
    case 'node': {
      const n = e.node || nodes.get(e.node_id) || {};
      return [h, 'joined', [n.place, n.machine?.chip].filter(Boolean).join(' · ')];
    }
    case 'beat': return [h, e.status || 'beat', e.activity?.unit_id || ''];
    case 'lease': return [h, 'took', unit];
    case 'result': return [h, VERDICT[e.verdict] || e.verdict || 'result', unit];
    case 'bye': return [h, 'left', ''];
    default: return [h, e.type, ''];
  }
}

function lanesText(n) {
  const l = laneList(n.lanes);
  if (!l.length) return '-';
  const live = ACTIVE.has(n.status) ? n.activity?.lane || l[0] : null;
  const seen = new Set();
  return l.filter((x) => (seen.has(x) ? false : seen.add(x))).map((x) => {
    const k = x === 'local' ? `local${l.filter((y) => y === 'local').length > 1 ? `×${l.filter((y) => y === 'local').length}` : ''}` : x;
    return x === live ? `${k}*` : k;
  }).join(' ');
}

export default function Wall() {
  const { store, ver, conn } = useSwarm();
  const s = store.current;
  const { now, online, t } = useMemo(() => derive(s), [ver, s]); // eslint-disable-line react-hooks/exhaustive-deps
  const ram = fmtRam(t.ram);
  const byProof = { alpoge: 0, masullo: 0 };
  for (const n of online) for (const p of nodeProofs(n)) if (p in byProof) byProof[p]++;
  const roles = ROLE_ORDER.filter((r) => t.roles[r]).map((r) => [r, t.roles[r]]);
  const rows = online.slice(-MAX_ROWS);
  const log = s.events.filter((e) => ['node', 'beat', 'lease', 'result', 'bye'].includes(e.type)).slice(-14);
  const live = conn === 'live';

  return (
    <main className="term">
      <header className="prompt">
        <a href="/">riemann-swarm</a> <span className="dim">~ $</span> rh watch
        <span className="right">{live ? <><span className="inv">LIVE</span><span className="cursor" /></> : <span className="dim">{conn === 'polling' ? 'reconnecting' : 'connecting'}</span>}</span>
      </header>

      <pre className="rule" aria-hidden="true" />

      <section className="kv totals" aria-label="Totals">
        <div><span>online</span><b>{fmt(t.online)}</b></div>
        <div><span>cores</span><b>{fmt(t.cores)}</b></div>
        <div><span>ram</span><b>{ram.v} {ram.u}</b></div>
        <div><span>claude</span><b>{fmt(t.claude)}</b></div>
        <div><span>codex</span><b>{fmt(t.codex)}</b></div>
        <div><span>local</span><b>{fmt(t.local)}</b></div>
        <div><span>working</span><b>{fmt(t.active)}</b></div>
        <div><span>ever</span><b>{fmt(s.totals?.nodes_ever || 0)}</b></div>
      </section>

      <section className="roles" aria-label="By role">
        <span className="dim">roles</span>
        {roles.length ? roles.map(([r, n]) => <span key={r}>{r} <b>{n}</b></span>) : <span className="dim">-</span>}
      </section>

      <section className="roles" aria-label="By proof">
        <span className="dim">proofs</span>
        <span>alpoge <b>{fmt(byProof.alpoge)}</b></span>
        <span>masullo <b>{fmt(byProof.masullo)}</b></span>
      </section>

      <section className="tracks" aria-label="Tracks">
        {TRACKS.map(({ key, name }) => {
          const T = s.tracks?.[key] || {};
          const units = Number(T.units) || 0;
          return (
            <div key={key} className="trk">
              <span>{key} {name.toLowerCase().padEnd(9, ' ')}</span>
              <span className="bar">[{bar(Number(T.done) || 0, Number(T.leased) || 0, units)}]</span>
              <span>{units ? `${fmt(T.done)}/${fmt(units)}` : 'no units yet'}</span>
              {Number(T.gap) ? <span className="dim">gap {fmt(T.gap)}</span> : null}
            </div>
          );
        })}
      </section>

      <pre className="rule" aria-hidden="true" />

      <section className="nodes" aria-label="Machines">
        <table>
          <thead>
            <tr>
              <th>handle</th><th className="c-place">place</th><th className="c-chip">chip</th>
              <th className="n c-cores">cores</th><th className="n c-ram">ram</th><th className="c-role">role</th><th>proof</th><th>status</th><th className="c-lanes">lanes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => {
              const fresh = now - (s.born.get(n.node_id) || 0) < 6000;
              const active = ACTIVE.has(n.status);
              return (
                <tr key={n.node_id} className={fresh ? 'fresh' : ''}>
                  <td>{n.handle || String(n.node_id).slice(0, 8)}</td>
                  <td className="c-place">{n.place || '-'}</td>
                  <td className="c-chip">{(n.machine?.chip || '-').replace(/^Apple /, '')}</td>
                  <td className="n c-cores">{n.machine?.cores ?? '-'}</td>
                  <td className="n c-ram">{n.machine?.ram_gb ? `${n.machine.ram_gb}G` : '-'}</td>
                  <td className="c-role">{primaryRole(n)}</td>
                  <td><span className="pf-long">{proofText(n)}</span><span className="pf-short">{proofShort(n)}</span></td>
                  <td className={active ? '' : 'dim'}>{n.status || 'idle'}{active && n.activity?.unit_id ? <span className="dim c-unit"> {n.activity.unit_id}</span> : null}</td>
                  <td className="c-lanes">{lanesText(n)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {online.length > MAX_ROWS ? <div className="dim more">… {fmt(online.length - MAX_ROWS)} more</div> : null}
        {s.loaded && !online.length ? (
          <div className="empty">
            <div>no machines online. waiting for the first<span className="cursor" /></div>
            <div className="dim">point your agent at AGENTS.md</div>
          </div>
        ) : null}
        {!s.loaded ? <div className="dim empty">loading<span className="cursor" /></div> : null}
      </section>

      <pre className="rule" aria-hidden="true" />

      <section className="log" aria-label="Events" aria-live="polite">
        <div className="dim">$ tail -f events</div>
        {log.map((e, i) => {
          const [h, v, o] = eventLine(e, s.nodes);
          return (
            <div key={`${e.id ?? i}-${e.at}`} className="ln">
              <span className="dim">{hhmmss(e.at || now)}</span> <span>{h}</span> <span>{v}</span>{o ? <span className="dim"> {o}</span> : null}
            </div>
          );
        })}
        <div className="ln"><span className="cursor" /></div>
      </section>

      <footer className="foot dim">
        <span>* running now · # done + leased · A alpoge · M masullo</span>
      </footer>
    </main>
  );
}
