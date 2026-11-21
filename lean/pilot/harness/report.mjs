#!/usr/bin/env node
// Summarize pilot logs into markdown tables (stdout).
//   node report.mjs <logs-dir> <lean-checks.jsonl>
import fs from 'node:fs';
import path from 'node:path';

const [, , LOGS, CHECKS] = process.argv;
const read = (f) => { const p = path.join(LOGS, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const lastBy = (rows, key) => { const m = new Map(); for (const r of rows) m.set(r[key], r); return [...m.values()]; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : NaN; };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');

function unitTable(title, rows, linesKey) {
  console.log(`\n### ${title}\n`);
  console.log('| unit | item | kind | lane | wall min | attempts | accepted | Lean lines | failure reason |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const reason = (r.reason || '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 140);
    console.log(`| ${r.theorem ? r.theorem.replace(/^Pilot\./, '') : r.unit} | ${r.item} | ${r.kind} | ${r.vendor}${r.slot ? ' (' + r.slot + ')' : ''} | ${f1(r.wall_min)} | ${r.attempts} | ${r.accepted ? 'y' : 'n'} | ${r.accepted ? r[linesKey] : '-'} | ${r.accepted ? '' : reason} |`);
  }
}

function totals(title, rows, linesKey) {
  console.log(`\n### ${title}\n`);
  console.log('| group | units | accepted | lane-hours | accepted lines | accepted lines / lane-hour | median wall min (accepted) |');
  console.log('|---|---|---|---|---|---|---|');
  const groups = new Map();
  const add = (g, r) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); };
  for (const r of rows) { add('all', r); add('lane: ' + r.vendor + (r.slot ? ' ' + r.slot : ''), r); add('kind: ' + r.kind, r); }
  for (const [g, rs] of groups) {
    const acc = rs.filter((r) => r.accepted);
    const hours = sum(rs.map((r) => r.wall_min)) / 60;
    const lines = sum(acc.map((r) => r[linesKey] || 0));
    console.log(`| ${g} | ${rs.length} | ${acc.length} | ${hours.toFixed(2)} | ${lines} | ${hours ? (lines / hours).toFixed(0) : '-'} | ${f1(med(acc.map((r) => r.wall_min)))} |`);
  }
}

const skel = lastBy(read('skel-units.jsonl'), 'item');
const proof = lastBy(read('proof-units.jsonl'), 'theorem');
const rt = lastBy(read('rt-units.jsonl'), 'item');
const att = [...read('skel-attempts.jsonl'), ...read('proof-attempts.jsonl'), ...read('rt-attempts.jsonl')];

if (skel.length) { unitTable('Skeleton units (definitions and statements)', skel, 'lean_lines'); totals('Skeleton totals', skel, 'lean_lines'); }
if (proof.length) { unitTable('Proof units', proof, 'lean_lines_added'); totals('Proof totals', proof, 'lean_lines_added'); }
if (rt.length) {
  console.log('\n### Round trips\n');
  console.log('| item | X (Lean author) | Y (checker) | English ok | back-translation compiled | equivalence proved | wall min | note |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rt) console.log(`| ${r.item} | ${r.X} | ${r.Y} | ${r.steps?.en?.ok ? 'y' : 'n'} | ${r.steps?.lean?.accepted ? 'y' : 'n'} | ${r.steps?.eq?.accepted ? 'y' : 'n'} | ${f1(r.wall_min)} | ${(r.reason || '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160)} |`);
  console.log(`\nRound-trip success: ${rt.filter((r) => r.ok).length}/${rt.length}`);
}

// lane call stats
if (att.length) {
  console.log('\n### Lane calls\n');
  for (const v of ['claude', 'codex']) {
    const all = att.filter((x) => x.vendor === v);
    // calls that returned in < 10 s with no usage are refusals (e.g. a usage limit), not work
    const refused = all.filter((x) => x.lane_wall_s < 10 && !Object.keys(x.usage || {}).length);
    const a = all.filter((x) => !refused.includes(x));
    if (refused.length) console.log(`- ${v}: ${refused.length} calls refused by the vendor (usage limit), excluded below`);
    if (!a.length) continue;
    const w = a.map((x) => x.lane_wall_s);
    console.log(`- ${v}: ${a.length} calls, median ${f1(med(w) / 60)} min, p90 ${f1(pct(w, 0.9) / 60)} min, timeouts ${a.filter((x) => x.timed_out).length}` +
      (v === 'claude' ? `, cost reported $${sum(a.map((x) => x.usage?.cost_usd || 0)).toFixed(2)}` : `, tokens reported ${sum(a.map((x) => x.usage?.tokens || 0)).toLocaleString('en-US')}`));
  }
}

if (CHECKS && fs.existsSync(CHECKS)) {
  const c = fs.readFileSync(CHECKS, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.mode === 'check' && !/^(selftest|checktest|audit)/.test(x.tag));
  const w = c.map((x) => x.wall_s), r = c.map((x) => x.rss / 2 ** 30);
  const lane = c.filter((x) => /:lane$/.test(x.tag)), drv = c.filter((x) => /:driver$/.test(x.tag));
  console.log('\n### Lean checks on the anchor (M2 Ultra, shared, `import Mathlib`)\n');
  console.log(`- ${c.length} checks (${lane.length} by lanes, ${drv.length} by the driver); wall median ${f1(med(w))} s, p90 ${f1(pct(w, 0.9))} s, max ${f1(Math.max(...w))} s`);
  console.log(`- peak RSS median ${med(r).toFixed(2)} GiB, max ${Math.max(...r).toFixed(2)} GiB; memory-guard waits ${sum(c.map((x) => x.mem_wait_s))} s total`);
  console.log(`- non-zero exits ${c.filter((x) => x.exit !== 0).length}`);
}
