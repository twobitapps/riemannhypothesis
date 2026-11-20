'use client';

import { useCallback, useEffect, useState } from 'react';
import { FIXTURE, RH_API, fmt } from '@/lib/rh';

const RAMS = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512];
const CLAUDE = [['none', 'None'], ['pro', 'Pro'], ['max5', 'Max 5×'], ['max20', 'Max 20×'], ['team', 'Team']];
const CODEX = [['none', 'None'], ['plus', 'Plus'], ['pro', 'Pro'], ['team', 'Team']];
const PROOF = [['alpoge', 'Alpöge'], ['masullo', 'Masullo'], ['both', 'Both']];

function useCount() {
  const [c, setC] = useState(null);
  const load = useCallback(() => {
    fetch(`${FIXTURE ? '/api/rh' : RH_API}/signups/count`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setC)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);
  return { c, load };
}

function Live({ c }) {
  if (!c || !(c.total > 0)) return null;
  const cells = [
    [c.total, 'people'],
    [(c.macs || 0) + (c.big_machines || 0), 'machines'],
    [c.cores, 'cores'],
    [c.claude, 'Claude agents'],
    [c.codex, 'Codex agents'],
  ];
  return (
    <div className="live">
      {cells.map(([v, l]) => (
        <div key={l}><span className="mono">{fmt(v)}</span><span>{l}</span></div>
      ))}
    </div>
  );
}

function Choice({ options, value, onChange, label }) {
  return (
    <span className="choice" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button type="button" key={v} role="radio" aria-checked={value === v}
          className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>
      ))}
    </span>
  );
}

async function postSignup(body) {
  const send = (url) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const r = await send(`${FIXTURE ? '/api/rh' : RH_API}/signup`);
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok || !j?.ok) {
    const e = j?.error;
    throw new Error(
      r.status === 429 ? 'Too many attempts. Please try again in an hour.'
        : e === 'bad_email' ? 'Please check the email address.'
          : e === 'bad_ram_gb' ? 'Please give the memory in GB.'
            : e === 'bad_cores' ? 'Please give the number of cores.'
              : 'Something went wrong. Please try again.',
    );
  }
  return j;
}

export default function Join() {
  const { c, load } = useCount();
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState('mac');
  const [ram, setRam] = useState('36');
  const [bram, setBram] = useState('');
  const [cores, setCores] = useState('');
  const [claude, setClaude] = useState('none');
  const [codex, setCodex] = useState('none');
  const [proof, setProof] = useState('both');
  const [expert, setExpert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pos, setPos] = useState(null);

  useEffect(() => {
    try { const s = JSON.parse(localStorage.getItem('rh_signup') || 'null'); if (s?.position) setPos(s.position); } catch {}
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr('Please check the email address.');
    const ramGb = Number(kind === 'mac' ? ram : bram);
    if (!ramGb) return setErr('Please give the memory in GB.');
    const machine = { kind, ram_gb: ramGb };
    if (kind === 'big') {
      if (!Number(cores)) return setErr('Please give the number of cores.');
      machine.cores = Number(cores);
    }
    const body = {
      email: email.trim(), machine, claude, codex,
      proofs: proof === 'both' ? ['alpoge', 'masullo'] : [proof],
      ...(expert ? { expert: 'lean' } : {}),
    };
    setBusy(true);
    try {
      const j = await postSignup(body);
      setPos(j.position);
      try { localStorage.setItem('rh_signup', JSON.stringify({ position: j.position, at: Date.now() })); } catch {}
      setTimeout(load, 1200);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Live c={c} />
      {pos ? (
        <p className="joined">You&rsquo;re in. Number <span className="mono">{fmt(pos)}</span>.</p>
      ) : (
        <form className="jform" onSubmit={submit} noValidate>
          <label className="fld">
            <span className="lbl">Email</span>
            <input type="email" autoComplete="email" inputMode="email" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <div className="fld">
            <span className="lbl">Machine</span>
            <div className="fld-row">
              <Choice label="Machine" options={[['mac', 'Mac'], ['big', 'Big machine']]} value={kind} onChange={setKind} />
              {kind === 'mac' ? (
                <label className="sub">
                  <span>RAM</span>
                  <select value={ram} onChange={(e) => setRam(e.target.value)}>
                    {RAMS.map((r) => <option key={r} value={r}>{r} GB</option>)}
                  </select>
                </label>
              ) : (
                <>
                  <label className="sub"><span>RAM (GB)</span>
                    <input inputMode="numeric" value={bram} onChange={(e) => setBram(e.target.value.replace(/\D/g, '').slice(0, 5))} />
                  </label>
                  <label className="sub"><span>Cores</span>
                    <input inputMode="numeric" value={cores} onChange={(e) => setCores(e.target.value.replace(/\D/g, '').slice(0, 4))} />
                  </label>
                </>
              )}
            </div>
          </div>
          <div className="fld">
            <span className="lbl">Claude plan</span>
            <Choice label="Claude plan" options={CLAUDE} value={claude} onChange={setClaude} />
          </div>
          <div className="fld">
            <span className="lbl">Codex plan</span>
            <Choice label="Codex plan" options={CODEX} value={codex} onChange={setCodex} />
          </div>
          <div className="fld">
            <span className="lbl">Which proof</span>
            <Choice label="Which proof" options={PROOF} value={proof} onChange={setProof} />
          </div>
          <label className="check">
            <input type="checkbox" checked={expert} onChange={(e) => setExpert(e.target.checked)} />
            <span>I know Lean or number theory</span>
          </label>
          <div className="act">
            <button className="go" disabled={busy}>Join</button>
            {err ? <span className="err" role="alert">{err}</span> : null}
          </div>
        </form>
      )}
    </>
  );
}
