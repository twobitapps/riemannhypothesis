'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ACTIVE, FIXTURE, ONLINE_MS, RH_API } from '@/lib/rh';

// ── data ────────────────────────────────────────────────────────────────────

export function useSwarm() {
  const store = useRef({ nodes: new Map(), tracks: null, totals: null, events: [], skew: 0, born: new Map(), loaded: false });
  const [ver, setVer] = useState(0);
  const [conn, setConn] = useState('connecting');
  const bump = useRef(0);

  const touch = useCallback(() => {
    if (bump.current) return;
    bump.current = setTimeout(() => { bump.current = 0; setVer((v) => v + 1); }, 250);
  }, []);

  const applySnapshot = useCallback((snap) => {
    if (!snap || typeof snap !== 'object') return;
    const s = store.current;
    if (snap.at) s.skew = snap.at - Date.now();
    const next = new Map();
    for (const n of snap.nodes || []) if (n?.node_id) next.set(n.node_id, { ...s.nodes.get(n.node_id), ...n });
    s.nodes = next;
    s.tracks = snap.tracks || s.tracks;
    s.totals = snap.totals || s.totals;
    if (Array.isArray(snap.events)) s.events = snap.events.slice(-200).map((e) => ({ ...e, at: e.at || snap.at }));
    s.loaded = true;
    touch();
  }, [touch]);

  const load = useCallback(() =>
    fetch(`${FIXTURE ? '/api/rh' : RH_API}/state`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(applySnapshot)
      .catch(() => { store.current.loaded = true; touch(); }), [applySnapshot, touch]);

  useEffect(() => {
    load();
    const s = store.current;
    let es, poll, reloadT;
    const soon = () => { if (!reloadT) reloadT = setTimeout(() => { reloadT = 0; load(); }, 8000); };
    const now = () => Date.now() + s.skew;
    const pushEvent = (ev) => {
      s.events.push(ev);
      if (s.events.length > 200) s.events.splice(0, s.events.length - 200);
    };
    const handle = (type) => (m) => {
      let d;
      try { d = JSON.parse(m.data); } catch { return; }
      if (type === 'snapshot') { applySnapshot(d); return; }
      const at = d.at || now();
      const id = d.node_id || d.node?.node_id;
      const cur = id ? s.nodes.get(id) : null;
      if (type === 'node') {
        const n = d.node || d;
        if (!n.node_id) return;
        if (!cur) s.born.set(n.node_id, Date.now());
                s.nodes.set(n.node_id, { ...cur, ...n, online: true, last_beat: n.last_beat || at, joined_at: n.joined_at || cur?.joined_at || at });
        pushEvent({ ...d, type, at, node_id: n.node_id, handle: n.handle, place: n.place });
        if (cur) { touch(); return; }
      } else if (type === 'beat') {
        if (!cur) { soon(); return; }
        const changed = d.status && d.status !== cur.status;
        s.nodes.set(id, { ...cur, online: true, status: d.status || cur.status, activity: d.activity !== undefined ? d.activity : cur.activity, last_beat: at });
        if (changed) pushEvent({ ...d, type, at, handle: cur.handle });
      } else if (type === 'lease') {
        if (cur) {
          const unit = d.unit_id || d.unit?.id || d.unit?.ref;
          const track = d.track || d.unit?.track || cur.activity?.track;
          s.nodes.set(id, { ...cur, activity: { ...(cur.activity || {}), track, unit_id: unit, since: at }, last_beat: at });
        }
        pushEvent({ ...d, type, at, handle: d.handle || cur?.handle });
        soon();
      } else if (type === 'result') {
        pushEvent({ ...d, type, at, handle: d.handle || cur?.handle });
        soon();
      } else if (type === 'bye') {
        if (cur) { s.nodes.delete(id); }
        pushEvent({ ...d, type, at, handle: d.handle || cur?.handle });
      }
      touch();
    };
    const open = () => {
      try {
        es = new EventSource(`${FIXTURE ? '/api/rh' : RH_API}/events`);
      } catch { setConn('polling'); if (!poll) poll = setInterval(load, 5000); return; }
      es.onopen = () => { setConn('live'); if (poll) { clearInterval(poll); poll = 0; } };
      for (const t of ['snapshot', 'node', 'beat', 'lease', 'result', 'bye']) es.addEventListener(t, handle(t));
      es.onerror = () => {
        setConn('polling');
        if (!poll) poll = setInterval(load, 5000);
      };
    };
    open();
    const slow = setInterval(load, 45_000);
    const tick = setInterval(touch, 5000); // presence ages out even when quiet
    return () => { es?.close(); clearInterval(poll); clearInterval(slow); clearInterval(tick); clearTimeout(reloadT); };
  }, [load, applySnapshot, touch]);

  return { store, ver, conn };
}

export function derive(s) {
  const now = Date.now() + s.skew;
  const online = [];
  for (const n of s.nodes.values()) if (n.online !== false && n.last_beat && now - n.last_beat < ONLINE_MS) online.push(n);
  online.sort((a, b) => (a.joined_at || 0) - (b.joined_at || 0) || String(a.node_id).localeCompare(String(b.node_id)));
  const t = { online: online.length, cores: 0, ram: 0, claude: 0, codex: 0, local: 0, roles: {}, active: 0 };
  for (const n of online) {
    t.cores += Number(n.machine?.cores) || 0;
    t.ram += Number(n.machine?.ram_gb) || 0;
    if (n.lanes?.claude) t.claude++;
    if (n.lanes?.codex) t.codex++;
    t.local += Array.isArray(n.lanes?.local_models) ? n.lanes.local_models.length : 0;
    for (const r of n.roles || []) t.roles[r] = (t.roles[r] || 0) + 1;
    if (ACTIVE.has(n.status)) t.active++;
  }
  return { now, online, t };
}

