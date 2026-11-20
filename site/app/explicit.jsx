'use client';

import { useEffect, useRef, useState } from 'react';

/*
 * Riemann's explicit formula, drawn as ψ(x) − x on 2 ≤ x ≤ 100 (same maths as og-src/og2.py).
 *
 *   ψ(x)   = Σ_{n ≤ x} Λ(n)                                   (Chebyshev; grey sawtooth once x is subtracted)
 *   ψ_N(x) = x − Σ_{k≤N} 2·Re(x^{ρ_k}/ρ_k) − log(2π) − ½·log(1 − x^{−2}),   ρ_k = ½ + iγ_k
 *
 * With x^ρ = √x·e^{iγ log x}:  Re(x^ρ/ρ) = √x·(½·cos(γL) + γ·sin(γL)) / (¼ + γ²),  L = log x.
 *
 * Numerical check, run against /data/zeta-zeros-1000.json (first 1,000 ordinates, 14.1347… to 1419.42…):
 *   ψ(30)       = log(2^4·3^3·5^2·7·11·13·17·19·23·29) = 28.4765
 *   ψ_1000(30)  = 28.4518        |difference| = 0.025  (tolerance ~1)
 *   og2.py reports the same: 28.45 against 28.48.
 * Ranges on [2, 100]: ψ(x) − x ∈ [−7.52, 2.10];  ψ_1000(x) − x ∈ [−7.77, 2.30].
 */

const XA = 2;
const XB = 100;
const NMAX = 1000;
const ANIM_MS = 6000;
const GHOSTS = [[3, 0.2], [10, 0.27], [30, 0.36], [100, 0.5]];
const YLO = -9.5;
const YHI = 4;
const LOG2PI = Math.log(2 * Math.PI);

function vonMangoldt(n) {
  for (let p = 2; p <= n; p++) {
    if (n % p === 0) {
      let m = n;
      while (m % p === 0) m /= p;
      return m === 1 ? Math.log(p) : 0;
    }
  }
  return 0;
}

export default function Explicit() {
  const ref = useRef(null);
  const st = useRef({ zeros: null, n: 0, W: 0, H: 0, dpr: 1, ghosts: new Map() });
  const [n, setN] = useState(0);
  const [ready, setReady] = useState(false);
  const [userN, setUserN] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('/data/zeta-zeros-1000.json', { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((z) => {
        if (!alive || !Array.isArray(z) || !z.length) return;
        st.current.zeros = Float64Array.from(z.slice(0, NMAX).map(Number));
        setReady(true);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const c = ref.current;
    const ctx = c.getContext('2d');
    const s = st.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0, t0 = 0, visible = true;

    // ψ(n) for integers 2..XB
    const psiInt = new Float64Array(XB + 2);
    for (let k = 2; k <= XB + 1; k++) psiInt[k] = psiInt[k - 1] + vonMangoldt(k);

    const sample = () => {
      const cols = Math.min(2400, Math.max(600, Math.round(s.W * 1.5)));
      s.xs = new Float64Array(cols);
      s.L = new Float64Array(cols);
      s.R = new Float64Array(cols);
      s.base = new Float64Array(cols); // ψ_0(x) − x
      for (let i = 0; i < cols; i++) {
        const x = XA + 0.02 + ((XB - XA - 0.02) * i) / (cols - 1);
        s.xs[i] = x; s.L[i] = Math.log(x); s.R[i] = Math.sqrt(x);
        s.base[i] = -LOG2PI - 0.5 * Math.log(1 - 1 / (x * x));
      }
      s.acc = new Float64Array(cols);
      s.n = 0;
      s.ghosts = new Map();
    };
    const addTo = (target) => {
      const z = s.zeros;
      if (!z || !s.acc) return;
      target = Math.min(target, z.length);
      if (target < s.n) { s.acc.fill(0); s.n = 0; }
      const cols = s.xs.length;
      for (let k = s.n; k < target; k++) {
        const g = z[k], d = 0.25 + g * g;
        for (let i = 0; i < cols; i++) {
          const a = g * s.L[i];
          s.acc[i] += (2 * s.R[i] * (0.5 * Math.cos(a) + g * Math.sin(a))) / d;
        }
        const kk = k + 1;
        if (!s.ghosts.has(kk) && GHOSTS.some(([g2]) => g2 === kk)) s.ghosts.set(kk, Float64Array.from(s.acc));
      }
      s.n = target;
    };

    const draw = () => {
      const { W, H, dpr } = s;
      if (!W) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const pad = W < 600 ? 16 : Math.max(32, (W - 1200) / 2);
      const padT = 12, padB = 30;
      const X = (x) => pad + ((x - XA) / (XB - XA)) * (W - 2 * pad);
      const Y = (v) => padT + ((YHI - Math.max(YLO - 1, Math.min(YHI + 1, v))) / (YHI - YLO)) * (H - padT - padB);

      // zero line
      ctx.strokeStyle = '#1f1f1f';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(XA), Math.round(Y(0)) + 0.5); ctx.lineTo(X(XB), Math.round(Y(0)) + 0.5); ctx.stroke();

      // x ticks
      ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.fillStyle = '#5a5a5a';
      ctx.textAlign = 'center';
      const step = W < 600 ? 20 : 10;
      for (let x = step; x <= XB; x += step) ctx.fillText(String(x), X(x), H - 9);

      // ψ(x) − x: grey sawtooth, falling with slope −1 between prime powers
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let k = 2; k < XB; k++) {
        ctx.moveTo(X(k), Y(psiInt[k] - k));
        ctx.lineTo(X(k + 1), Y(psiInt[k] - k - 1));
      }
      ctx.stroke();

      const curve = (acc, alpha, width) => {
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let i = 0; i < s.xs.length; i++) {
          const v = s.base[i] - acc[i];
          if (i === 0) ctx.moveTo(X(s.xs[i]), Y(v)); else ctx.lineTo(X(s.xs[i]), Y(v));
        }
        ctx.stroke();
      };
      if (s.zeros && s.n > 0) {
        for (const [k, a] of GHOSTS) if (k < s.n && s.ghosts.has(k)) curve(s.ghosts.get(k), a, 1);
        curve(s.acc, 1, 1.5);
      }
    };

    const resize = () => {
      const r = c.getBoundingClientRect();
      s.dpr = Math.min(2, window.devicePixelRatio || 1);
      s.W = r.width; s.H = r.height;
      c.width = Math.round(s.W * s.dpr); c.height = Math.round(s.H * s.dpr);
      const keep = s.n;
      sample();
      // Rebuild ghosts too: re-accumulate through 100 even if the user is below it.
      addTo(Math.max(keep, s.animating === false ? Math.min(100, s.zeros?.length || 0) : keep));
      if (s.n !== keep) { const g = s.ghosts; addTo(keep); s.ghosts = g; }
      draw();
    };
    s.draw = draw;
    s.addTo = addTo;

    const ro = new ResizeObserver(resize);
    ro.observe(c);
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    io.observe(c);

    const loop = (now) => {
      if (s.zeros && s.animating !== false) {
        if (!t0) t0 = now;
        const k = reduced ? 1 : Math.min(1, (now - t0) / ANIM_MS);
        // Ease out: the first zeros change the picture most, so they get the time.
        const e = 1 - (1 - k) ** 2.4;
        const nn = Math.max(1, Math.round(1 + e * (NMAX - 1)));
        if (visible || k >= 1) { addTo(nn); draw(); setN(s.n); }
        if (k >= 1) s.animating = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); };
  }, []);

  useEffect(() => {
    if (userN == null) return;
    const s = st.current;
    s.animating = false;
    const g = s.ghosts;
    s.addTo?.(userN);
    s.ghosts = g;
    s.draw?.();
    setN(s.n);
  }, [userN]);

  return (
    <figure className="explicit">
      <canvas ref={ref} className="explicit-canvas" role="img"
        aria-label="psi(x) minus x for x from 2 to 100, and its reconstruction from the first N zeros of the zeta function." />
      <figcaption className="explicit-cap">
        <span className="cap-text">ψ(x) − x: the primes, rebuilt from the first N zeros of ζ. Riemann&rsquo;s explicit formula, 1859.</span>
        <span className="cap-n">
          <span className="mono">N = {ready ? n.toLocaleString('en-US') : '—'}</span>
          <input type="range" min="1" max={NMAX} step="1" value={Math.max(1, n)} disabled={!ready}
            onChange={(e) => setUserN(Number(e.target.value))} aria-label="Number of zeros N" />
        </span>
      </figcaption>
    </figure>
  );
}
