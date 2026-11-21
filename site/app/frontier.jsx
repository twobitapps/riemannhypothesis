'use client';

// The frontier strip: each track's one number, a sparkline, and the last new
// best with its author. Real values only; a track still at 0 is not shown.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fmt } from '@/lib/rh';

function Spark({ series }) {
  if (!series || series.length < 2) return null;
  const xs = series.map((p) => p[0]), ys = series.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y1 = Math.max(...ys) || 1;
  const W = 120, H = 28;
  const pts = series.map(([x, y]) => `${(((x - x0) / (x1 - x0 || 1)) * W).toFixed(1)},${(H - (y / y1) * H).toFixed(1)}`).join(' ');
  return (
    <svg className="fr-spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export default function Frontier() {
  const [f, setF] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/rh/frontier', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live && d) setF(d); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const tracks = f ? Object.entries(f.tracks).filter(([, t]) => Number(t.value) > 0) : [];
  if (!tracks.length) return null;
  return (
    <div className="frontier" aria-label="Frontier">
      {tracks.map(([k, t]) => (
        <div key={k} className="fr-track">
          <span className="fr-value mono">{fmt(t.value)}</span>
          <span className="fr-name">{t.mark ? <span className="fr-mark">{t.mark}</span> : null} {t.name}</span>
          <Spark series={t.series} />
          {t.last_best && (
            <span className="fr-best">
              new best {t.last_best.by?.length ? <>by {t.last_best.by.join(', ')}</> : null}
              {t.last_best.post ? <> · <Link href={`/board?p=${t.last_best.post}`}>{t.last_best.post}</Link></> : null}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
