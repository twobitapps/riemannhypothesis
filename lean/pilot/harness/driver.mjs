#!/usr/bin/env node
// Pilot driver: runs Claude Code and Codex lanes over blueprint units, checks every result with
// Lean on the anchor Mac (over SSH), and logs per-attempt measurements.
//
//   node driver.mjs skel   [--only id,id]      statement skeleton (defs + theorem statements)
//   node driver.mjs rt     --ids id,id,...      statement round trips
//   node driver.mjs proof  [--only name,name]  fill every `sorry` theorem of the skeleton
//
// Lanes run on this machine (their logins); Lean runs on the anchor via bin/lean-sem
// (<= 3 concurrent Lean processes, memory guard). One lane per vendor at a time.
//
// Environment: PILOT_SCRATCH (lane work dirs and logs), MATHLIB_SRC (Mathlib/*.lean sources for
// grepping), PAPER_TXT (text of the paper), PILOT_ANCHOR_RUN (command prefix that runs a shell
// command on the anchor), PILOT_REMOTE_DIR (Lean project dir on the anchor, default riemann/pilot),
// PILOT_LANE_B (codex | claude), PILOT_REVIEW (JSON of reviewer rejections to feed back).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const PILOT = path.resolve(HERE, '..');                 // lean/pilot (sources mirror)
const UDIR = path.join(PILOT, 'Pilot/U');
const RTDIR = path.join(PILOT, 'Pilot/RT');
const BLUEPRINT = path.join(REPO, 'blueprint/pilot.json');
const LINT = path.join(REPO, 'client/lint-proof.mjs');
const SCRATCH = process.env.PILOT_SCRATCH;               // lane work dirs + logs
const MATHLIB_SRC = process.env.MATHLIB_SRC;             // local copy of Mathlib/*.lean for grepping
const PAPER_TXT = process.env.PAPER_TXT;                 // pdftotext of the paper
// Command prefix that runs a shell command on the anchor Mac, e.g. a remote-shell invocation.
// The command string is appended as the last argument; stdin is passed through.
const ANCHOR_RUN = (process.env.PILOT_ANCHOR_RUN || '').split(' ').filter(Boolean);
const REMOTE = process.env.PILOT_REMOTE_DIR || 'riemann/pilot'; // Lean project dir, relative to the anchor's $HOME
if (!SCRATCH || !MATHLIB_SRC || !ANCHOR_RUN.length) { console.error('set PILOT_SCRATCH, MATHLIB_SRC and PILOT_ANCHOR_RUN'); process.exit(2); }
const LANES = path.join(SCRATCH, 'lanes');
const LOGS = path.join(SCRATCH, 'logs');
fs.mkdirSync(LANES, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(UDIR, { recursive: true }); fs.mkdirSync(RTDIR, { recursive: true });

const now = () => Date.now() / 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const bp = JSON.parse(fs.readFileSync(BLUEPRINT, 'utf8'));
const byId = new Map(bp.items.map((i) => [i.id, i]));
const sid = (id) => id.replace(/^txt:/, 't').replace(/[^A-Za-z0-9]/g, '_');
const modName = (id) => (id.startsWith('txt:') ? 'T_' + sid(id).slice(1) : 'I_' + sid(id));
// Lane B normally runs Codex; PILOT_LANE_B=claude runs a second, independent Claude lane instead.
const LANE_B = process.env.PILOT_LANE_B || 'codex';
const laneVendor = (slot) => (slot === 'A' ? 'claude' : LANE_B);
const isDef = (it) => it.kind === 'definition' || it.kind === 'def-text';
// reviewer feedback for units re-run after a fidelity rejection: { id: text }
const REVIEW = process.env.PILOT_REVIEW && fs.existsSync(process.env.PILOT_REVIEW) ? JSON.parse(fs.readFileSync(process.env.PILOT_REVIEW, 'utf8')) : {};
function appendJsonl(file, obj) { fs.appendFileSync(path.join(LOGS, file), JSON.stringify(obj) + '\n'); }

// ---------- anchor helpers ----------
function anchor(cmd, input) {
  const r = spawnSync(ANCHOR_RUN[0], [...ANCHOR_RUN.slice(1), cmd],
    { input, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function leanCheck(tag, name, content) {
  const r = anchor(`mkdir -p ~/${REMOTE}/work/${tag} && cat > ~/${REMOTE}/work/${tag}/${name} && ~/${REMOTE}/bin/lean-sem check work/${tag}/${name} ${tag}:driver`, content);
  const m = r.out.match(/LEANCHECK exit=(\d+) wall_s=([\d.]+) rss_mb=(\d+)/);
  const body = r.out.replace(/LEANCHECK.*\n?/, '');
  const errors = body.split('\n').filter((l) => /: error[:(]/.test(l) || /^error:/.test(l));
  return { exit: m ? +m[1] : r.code, wall: m ? +m[2] : null, rss_mb: m ? +m[3] : null, out: body, errors };
}
function pushModule(dir, mod) {
  const local = path.join(PILOT, 'Pilot', dir, mod + '.lean');
  const r1 = anchor(`mkdir -p ~/${REMOTE}/Pilot/${dir} && cat > ~/${REMOTE}/Pilot/${dir}/${mod}.lean`, fs.readFileSync(local, 'utf8'));
  if (r1.code !== 0) return { ok: false, out: r1.out };
  const r = anchor(`~/${REMOTE}/bin/lean-sem build Pilot.${dir}.${mod} build:${mod}`);
  return { ok: /LEANCHECK exit=0/.test(r.out), out: r.out.slice(-3000) };
}
function lint(file, extra = []) {
  const r = spawnSync('node', [LINT, file, '--json', ...extra], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, violations: [{ reason: 'linter crashed: ' + r.stderr }] }; }
}
function leanLines(text) {
  // non-blank lines after stripping comments
  const code = text.replace(/\/-[\s\S]*?-\//g, '').split('\n').map((l) => l.replace(/--.*$/, ''));
  return code.filter((l) => l.trim().length).length;
}

// ---------- lanes ----------
function laneDir(unit) {
  const d = path.join(LANES, unit);
  fs.mkdirSync(d, { recursive: true });
  const lc = `#!/bin/bash
# ./lean-check <file.lean> : runs Lean 4 v4.36.0 + Mathlib + Pilot modules on the anchor Mac.
# Prints Lean's messages, then a LEANCHECK line. One check takes ~30-60 s. Run one at a time.
f="$1"; [ -f "$f" ] || { echo "usage: ./lean-check FILE.lean"; exit 2; }
n=$(basename "$f")
exec ${ANCHOR_RUN.join(' ')} "mkdir -p ~/${REMOTE}/work/${unit} && cat > ~/${REMOTE}/work/${unit}/lane_$n && ~/${REMOTE}/bin/lean-sem check work/${unit}/lane_$n ${unit}:lane" < "$f"
`;
  fs.writeFileSync(path.join(d, 'lean-check'), lc, { mode: 0o755 });
  return d;
}

function runLane(vendor, cwd, prompt, timeoutS, tag, addDirs) {
  return new Promise((resolve) => {
    const t0 = now();
    const outFile = path.join(LOGS, `lane-${tag}.log`);
    const out = fs.openSync(outFile, 'a');
    fs.writeSync(out, `\n===== ${new Date().toISOString()} ${vendor} ${tag}\n${prompt}\n----- output\n`);
    let cmd, args;
    if (vendor === 'claude') {
      cmd = 'claude';
      args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits',
        '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(./lean-check:*)',
        '--add-dir', ...(addDirs || [MATHLIB_SRC, path.join(SCRATCH, 'ctx')])];
    } else {
      cmd = 'codex';
      args = ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write',
        '-c', 'sandbox_workspace_write.network_access=true', '-C', cwd,
        '-o', path.join(cwd, '.codex-last.txt'), prompt];
    }
    const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', out, out] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    }, timeoutS * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      fs.closeSync(out);
      const txt = fs.readFileSync(outFile, 'utf8');
      const tail = txt.slice(txt.lastIndexOf('----- output'));
      let usage = {};
      if (vendor === 'claude') {
        const j = tail.match(/\{"type":"result"[\s\S]*\}\s*$/) || tail.match(/\{[\s\S]*"result"[\s\S]*\}\s*$/);
        if (j) { try { const d = JSON.parse(j[0]); usage = { cost_usd: d.total_cost_usd, turns: d.num_turns, out_tokens: d.usage?.output_tokens, is_error: d.is_error, model: Object.keys(d.modelUsage || {}).join(',') }; } catch {} }
      } else {
        const m = tail.match(/tokens used\s*\n?\s*([\d,]+)/);
        if (m) usage = { tokens: +m[1].replace(/,/g, '') };
      }
      resolve({ code, wall: now() - t0, timedOut, usage });
    });
  });
}

// ---------- prompts ----------
const COMMON = (unit) => `You are one lane of a Lean 4 formalization pilot for A. Masullo, "The Music of the Primes" (GRH for Hecke L-functions).
Environment: Lean 4 v4.36.0 with Mathlib (tag v4.36.0, Nov 2026 - newer than your training data, so look names up instead of guessing).
- Mathlib sources (read-only): ${MATHLIB_SRC}  (grep them for names and signatures).
- Pilot modules you may import (read them first): ${path.join(SCRATCH, 'ctx')}/Pilot/U/*.lean, imported as \`import Pilot.U.<FileName>\`.
- Paper text (pdftotext, formulas lossy): ${PAPER_TXT}
- Check a file with \`./lean-check <file>\` in this directory. It runs Lean remotely; each check takes 30-60 s; run one at a time. Lean's errors are what count.
Rules: only \`import Mathlib\` / \`import Pilot.…\`. Never use run_cmd, run_tac, #eval, initialize, elab, macro, syntax, notation, unsafe, implemented_by, extern, native_decide, axiom, opaque, or set_option (except maxHeartbeats <= 1000000). Put declarations in \`namespace Pilot\`. Only write the file(s) named below in this directory (${path.join(LANES, unit)}).`;

function itemBlock(it) {
  return `[${it.id}] ${it.kind}, p.${it.page}${it.title ? ' (' + it.title + ')' : ''}\n${it.statement}${it.notes ? '\nNotes: ' + it.notes : ''}`;
}
function usesClosure(id, seen = new Set()) {
  for (const u of byId.get(id)?.uses || []) if (!seen.has(u)) { seen.add(u); usesClosure(u, seen); }
  return seen;
}
function availableImports(id) {
  return [...usesClosure(id)].filter((u) => fs.existsSync(path.join(UDIR, modName(u) + '.lean'))).map((u) => `Pilot.U.${modName(u)}`);
}

function skelPrompt(it, feedback) {
  const imports = availableImports(it.id);
  const ctx = [...usesClosure(it.id)].map((u) => byId.get(u)).filter(Boolean).map(itemBlock).join('\n\n');
  const task = isDef(it)
    ? `TASK (definition unit ${it.id}): write Lean definitions for this blueprint item into Unit.lean.
- Definitions must be complete: no sorry anywhere in the file.
- Be faithful to the paper. If Mathlib already has the notion, reuse it (abbrev / thin wrapper) instead of redefining it.
- If a faithful definition is out of reach, write the closest honest definition and add a comment line \`-- FIDELITY: <how it differs>\`.
- First line of the file: \`-- exports: <the Lean names other units should use>\`.
- The definition must pin the notion down from the underlying data. Never take the defining structure as a parameter or field supplied by the user (e.g. do not pass in "the projective tensor topology" or "the topology of S(G)" as an argument, and do not leave it as an arbitrary instance); if Mathlib lacks a construction you need, build it (e.g. define the seminorms) or use an equivalent characterization stated in the item.`
    : `TASK (statement unit ${it.id}): write the Lean STATEMENT of this item into Unit.lean as
  theorem thm_${sid(it.id)} : <statement> := by sorry
inside \`namespace Pilot\` (if the item has several numbered parts you may instead write one theorem per part, named thm_${sid(it.id)}_p1, thm_${sid(it.id)}_p2, ..., each \`:= by sorry\`).
- State it faithfully, as written in the paper, even if you suspect it is false (then add \`-- SUSPECT: <reason>\`).
- Auxiliary definitions needed only by this statement (e.g. maps it names) go before the theorem, complete (no sorry in defs).
- Do not prove anything; the only sorry allowed is the proof of each thm_ theorem.`;
  return `${COMMON(sanit(it.id))}

${task}
Start the file with the imports: \`import Mathlib\`${imports.length ? ' and ' + imports.map((i) => '`import ' + i + '`').join(', ') : ''} (drop any you do not need).
Done when \`./lean-check Unit.lean\` reports no errors (warnings about sorry are fine for theorems).

ITEM:
${itemBlock(it)}
${ctx ? '\nCONTEXT (items it uses):\n' + ctx : ''}
${REVIEW[it.id] ? '\nA REVIEWER REJECTED AN EARLIER, LEAN-ACCEPTED VERSION OF THIS UNIT:\n' + REVIEW[it.id] + '\n' : ''}${feedback ? '\nPREVIOUS ATTEMPT FAILED THE DRIVER CHECK:\n' + feedback + '\nFix Unit.lean.' : ''}`;
}

function proofPrompt(u, feedback) {
  const it = byId.get(u.itemId);
  const ctx = [...usesClosure(u.itemId)].map((x) => byId.get(x)).filter(Boolean).map(itemBlock).join('\n\n');
  return `${COMMON(u.unit)}

TASK (proof unit ${u.name}): Proof.lean is a locked skeleton file. Replace the \`sorry\` in theorem \`${u.short}\` with a complete proof.
- Do not change its statement or any other declaration already in the file. You may add fully proved helper lemmas above it.
- Other \`sorry\` theorems (in this file or in imported Pilot modules) are locked statements owned by other units: you may use them as lemmas.
- If you become convinced the statement is false as stated, or needs foundations far beyond reach, stop and write one line \`GAP: <precise reason>\` to gap.txt (with a counterexample if false).
Done when \`./lean-check Proof.lean\` reports no errors and \`${u.short}\` no longer uses sorry.

ITEM (from the paper):
${itemBlock(it)}
${ctx ? '\nCONTEXT (items it uses):\n' + ctx : ''}
${feedback ? '\nPREVIOUS ATTEMPT FAILED THE DRIVER CHECK:\n' + feedback + '\nFix Proof.lean.' : ''}`;
}
const sanit = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');

// ---------- generic unit loop ----------
async function unitLoop({ unit, vendor, capS, maxAttempts, prompt, check, phase, addDirs }) {
  const t0 = now();
  let feedback = '', attempts = 0, last = null, gap = null;
  const dir = laneDir(unit);
  while (attempts < maxAttempts && now() - t0 < capS) {
    attempts++;
    const remaining = capS - (now() - t0);
    const call = await runLane(vendor, dir, prompt(feedback), Math.max(60, Math.min(remaining, 15 * 60)), `${phase}-${unit}-a${attempts}`, addDirs);
    const gapFile = path.join(dir, 'gap.txt');
    if (fs.existsSync(gapFile)) gap = fs.readFileSync(gapFile, 'utf8').trim().slice(0, 1000);
    const c = await check(dir);
    last = { attempt: attempts, lane_wall_s: +call.wall.toFixed(1), timed_out: call.timedOut, usage: call.usage, ...c.summary };
    appendJsonl(`${phase}-attempts.jsonl`, { unit, vendor, ...last, ts: now() });
    log(`${phase} ${unit} [${vendor}] attempt ${attempts}: ${c.ok ? 'ACCEPTED' : 'rejected'} (${call.wall.toFixed(0)} s lane${call.timedOut ? ', timed out' : ''})`);
    if (c.ok) return { unit, vendor, accepted: true, attempts, wall_min: +((now() - t0) / 60).toFixed(2), ...c.result };
    if (gap) return { unit, vendor, accepted: false, attempts, wall_min: +((now() - t0) / 60).toFixed(2), reason: 'GAP: ' + gap, ...c.result };
    feedback = c.feedback.slice(0, 6000);
  }
  return { unit, vendor, accepted: false, attempts, wall_min: +((now() - t0) / 60).toFixed(2), reason: last?.timed_out ? 'time cap' : (attempts >= maxAttempts ? 'attempt cap' : 'time cap'), last_feedback: feedback.slice(0, 1500) };
}

// ---------- phases ----------
function topoOrder(ids) {
  const out = [], seen = new Set();
  const visit = (id) => { if (seen.has(id)) return; seen.add(id); for (const u of byId.get(id)?.uses || []) if (ids.includes(u)) visit(u); out.push(id); };
  ids.forEach(visit);
  return out;
}

async function runQueues(units, worker) {
  // units: [{key, vendor, deps:[keys]}]; one worker per vendor; a unit starts when its deps are done.
  const done = new Map();
  const results = [];
  // one worker per lane slot (A/B); a slot's vendor is fixed for the run
  for (const u of units) u.slot = u.slot || (u.vendor === 'claude' ? 'A' : 'B');
  const slots = [...new Set(units.map((u) => u.slot))];
  await Promise.all(slots.map(async (v) => {
    const queue = units.filter((u) => u.slot === v);
    while (queue.length) {
      const i = queue.findIndex((u) => u.deps.every((d) => done.has(d) || !units.some((x) => x.key === d)));
      if (i < 0) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      const u = queue.splice(i, 1)[0];
      const r = await worker(u);
      results.push(r); done.set(u.key, r);
    }
  }));
  return results;
}

async function phaseSkel(only) {
  let ids = topoOrder(bp.items.map((i) => i.id));
  if (only) ids = ids.filter((i) => only.includes(i));
  // vendor alternates along the full topological order, so a unit keeps its vendor across reruns
  const fullOrder = topoOrder(bp.items.map((i) => i.id));
  ids = ids.filter((id) => only || !fs.existsSync(path.join(UDIR, modName(id) + '.lean')));
  const units = ids.map((id) => { const slot = fullOrder.indexOf(id) % 2 === 0 ? 'A' : 'B'; return { key: id, slot, vendor: laneVendor(slot), deps: byId.get(id).uses }; });
  const results = await runQueues(units, async (u) => {
    const it = byId.get(u.key);
    const unit = 'skel_' + sanit(u.key);
    syncCtx();
    const r = await unitLoop({
      unit, vendor: u.vendor, capS: 20 * 60, maxAttempts: 8, phase: 'skel',
      prompt: (fb) => skelPrompt(it, fb),
      check: async (dir) => checkSkel(it, dir, unit),
    });
    if (r.accepted) {
      fs.copyFileSync(path.join(LANES, unit, 'Unit.lean'), path.join(UDIR, modName(it.id) + '.lean'));
      const b = pushModule('U', modName(it.id));
      r.module_build_ok = b.ok;
      if (!b.ok) { r.accepted = false; r.reason = 'module build failed: ' + b.out.slice(-500); }
    }
    r.item = it.id; r.kind = it.kind; r.slot = u.slot;
    appendJsonl('skel-units.jsonl', r);
    log(`skel ${u.key}: ${r.accepted ? 'ACCEPTED' : 'FAILED ' + r.reason} in ${r.wall_min} min, ${r.attempts} attempts`);
    return r;
  });
  return results;
}

function checkSkel(it, dir, unit) {
  const f = path.join(dir, 'Unit.lean');
  if (!fs.existsSync(f)) return { ok: false, feedback: 'Unit.lean was not written.', summary: { lean_exit: null }, result: {} };
  const text = fs.readFileSync(f, 'utf8');
  const l = lint(f, ['--mode', 'statement']);
  const problems = [...l.violations.map((v) => `lint: line ${v.line}: ${v.token}: ${v.reason}`)];
  const thmRe = new RegExp(`\\btheorem\\s+(?:Pilot\\.)?thm_${sid(it.id)}(_p\\d+)?\\b`, 'g');
  const thms = text.match(thmRe) || [];
  if (!isDef(it) && thms.length === 0) problems.push(`no theorem named thm_${sid(it.id)} (or thm_${sid(it.id)}_p1, ...) found`);
  if (isDef(it) && /\bsorry\b/.test(text.replace(/--.*$/gm, ''))) problems.push('definition units must not contain sorry');
  const lc = leanCheck(unit, 'Unit.lean', text);
  if (lc.exit !== 0 || lc.errors.length) problems.push('Lean errors:\n' + lc.out.slice(0, 4000));
  // sorry only allowed in theorem proofs: check that every "declaration uses 'sorry'" warning is on a thm_ line
  const sorryLines = [...lc.out.matchAll(/:(\d+):\d+: warning: declaration uses `sorry`/g)].map((m) => +m[1]);
  const lines = text.split('\n');
  for (const ln of sorryLines) if (!/thm_/.test(lines[ln - 1] || '')) problems.push(`sorry used outside a thm_ theorem (line ${ln}: ${lines[ln - 1]?.trim()})`);
  return {
    ok: problems.length === 0,
    feedback: problems.join('\n'),
    summary: { lean_exit: lc.exit, lean_wall_s: lc.wall, lean_rss_mb: lc.rss_mb, lint_ok: l.ok, n_errors: lc.errors.length },
    result: { lean_lines: leanLines(text), theorems: thms.length, fidelity_flag: /FIDELITY:|SUSPECT:/.test(text) },
  };
}

function syncCtx() {
  // read-only copy of accepted Pilot modules for lanes (RT blind lanes get a filtered copy)
  const ctx = path.join(SCRATCH, 'ctx/Pilot/U');
  fs.mkdirSync(ctx, { recursive: true });
  for (const f of fs.readdirSync(UDIR)) fs.copyFileSync(path.join(UDIR, f), path.join(ctx, f));
}

// ----- proof phase -----
function skeletonTheorems() {
  const out = [];
  for (const f of fs.readdirSync(UDIR).filter((f) => f.endsWith('.lean'))) {
    const text = fs.readFileSync(path.join(UDIR, f), 'utf8');
    const re = /^\s*theorem\s+(?:Pilot\.)?(thm_[A-Za-z0-9_]+)/gm;
    let m;
    while ((m = re.exec(text))) out.push({ mod: f.replace(/\.lean$/, ''), short: m[1], name: 'Pilot.' + m[1] });
  }
  return out;
}

async function phaseProof(only) {
  const thms = skeletonTheorems();
  const allNames = thms.map((t) => t.name);
  const itemOf = (t) => bp.items.find((i) => modName(i.id) === t.mod)?.id;
  let list = thms.filter((t) => !only || only.includes(t.short));
  if (only) list.sort((a, b) => only.indexOf(a.short) - only.indexOf(b.short));   // keep the given order
  else list.sort((a, b) => bp.items.findIndex((i) => i.id === itemOf(a)) - bp.items.findIndex((i) => i.id === itemOf(b)));
  const units = list.map((t, k) => { const slot = k % 2 === 0 ? 'A' : 'B'; return { key: t.short, slot, vendor: laneVendor(slot), deps: [], t }; });
  return runQueues(units, async (u) => {
    const t = u.t;
    const unit = 'proof_' + t.short;
    const dir = laneDir(unit);
    const skelFile = path.join(UDIR, t.mod + '.lean');
    const skel = fs.readFileSync(skelFile, 'utf8');
    fs.writeFileSync(path.join(dir, 'Proof.lean'), skel);
    fs.writeFileSync(path.join(dir, 'Skeleton.lean.orig'), skel);
    try { fs.unlinkSync(path.join(dir, 'gap.txt')); } catch {}
    syncCtx();
    const ud = { unit, name: t.name, short: t.short, itemId: itemOf(t) };
    const r = await unitLoop({
      unit, vendor: u.vendor, capS: 30 * 60, maxAttempts: 8, phase: 'proof',
      prompt: (fb) => proofPrompt(ud, fb),
      check: async (d) => checkProof(ud, d, skelFile, allNames),
    });
    r.theorem = t.name; r.item = ud.itemId; r.kind = byId.get(ud.itemId)?.kind; r.slot = u.slot;
    appendJsonl('proof-units.jsonl', r);
    log(`proof ${t.short}: ${r.accepted ? 'ACCEPTED' : 'FAILED ' + r.reason} in ${r.wall_min} min, ${r.attempts} attempts`);
    return r;
  });
}

function checkProof(u, dir, skelFile, allNames) {
  const f = path.join(dir, 'Proof.lean');
  const text = fs.readFileSync(f, 'utf8');
  const skel = fs.readFileSync(skelFile, 'utf8');
  const l = lint(f, ['--skeleton', skelFile, '--target', u.short, '--mode', 'proof']);
  const problems = l.violations.map((v) => `lint: ${v.line ? 'line ' + v.line + ': ' : ''}${v.token}: ${v.reason}`);
  const stops = allNames.filter((n) => n !== u.name);
  const checkText = text.replace(/^(\s*import [^\n]*\n)+/, (m) => m + 'import Pilot.Check\n') + `\n#unit_axioms ${u.name} ${stops.join(' ')}\n`;
  const lc = leanCheck(u.unit, 'Proof.lean', checkText);
  if (lc.exit !== 0 || lc.errors.length) problems.push('Lean errors:\n' + lc.out.slice(0, 4000));
  const ax = lc.out.match(/UNIT_AXIOMS [^:]+: \[([^\]]*)\]/);
  const axioms = ax ? ax[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
  const okAx = new Set(['propext', 'Classical.choice', 'Quot.sound']);
  if (!axioms) problems.push('axiom check did not run (does the file compile?)');
  else if (axioms.some((a) => !okAx.has(a))) problems.push(`${u.short} still depends on: ${axioms.filter((a) => !okAx.has(a)).join(', ')} (sorryAx means a sorry remains in it or in a helper)`);
  const usedStops = []; // which locked sibling statements were used
  for (const n of stops) if (new RegExp(`\\b${n.split('.').pop()}\\b`).test(text.replace(skel, ''))) usedStops.push(n);
  return {
    ok: problems.length === 0,
    feedback: problems.join('\n'),
    summary: { lean_exit: lc.exit, lean_wall_s: lc.wall, lean_rss_mb: lc.rss_mb, lint_ok: l.ok, axioms, n_errors: lc.errors.length },
    result: { lean_lines_added: leanLines(text) - leanLines(skel), used_locked: usedStops },
  };
}

// ----- round trip -----
async function phaseRT(ids) {
  // statement author X = vendor that wrote the skeleton unit; Y = other vendor
  const skelUnits = fs.existsSync(path.join(LOGS, 'skel-units.jsonl'))
    ? fs.readFileSync(path.join(LOGS, 'skel-units.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const authorOf = (id) => skelUnits.filter((r) => r.item === id && r.accepted).pop()?.vendor;
  const thms = skeletonTheorems();
  const jobs = [];
  for (const id of ids) {
    const t = thms.filter((x) => x.mod === modName(id));
    if (!t.length) { log('rt: no skeleton theorem for', id); continue; }
    jobs.push({ id, X: authorOf(id) || 'claude', thms: t });
  }
  const results = [];
  // run two round trips at a time (one per X vendor) to respect <=2 lanes
  const units = jobs.map((j, k) => ({ key: j.id, vendor: j.X, slot: k % 2 === 0 ? 'A' : 'B', deps: [], j }));
  return runQueues(units, async (u) => rtOne(u.j));
}

function blindCtx(dirName, keepMods) {
  const ctx = path.join(SCRATCH, dirName, 'Pilot/U');
  fs.rmSync(path.join(SCRATCH, dirName), { recursive: true, force: true });
  fs.mkdirSync(ctx, { recursive: true });
  for (const f of fs.readdirSync(UDIR)) if (keepMods.includes(f.replace(/\.lean$/, ''))) fs.copyFileSync(path.join(UDIR, f), path.join(ctx, f));
  return path.join(SCRATCH, dirName);
}

async function rtOne(j) {
  const X = j.X, Y = X === 'claude' ? LANE_B : 'claude';
  const it = byId.get(j.id);
  const mod = modName(j.id);
  const src = fs.readFileSync(path.join(UDIR, mod + '.lean'), 'utf8');
  const defMods = bp.items.filter(isDef).map((i) => modName(i.id));
  const res = { item: j.id, X, Y, steps: {} };
  const t0 = now();
  // step 1: Y writes English from Lean (no paper)
  const u1 = `rt_en_${sanit(j.id)}`; const d1 = laneDir(u1);
  fs.writeFileSync(path.join(d1, 'Statement.lean'), src);
  const p1 = `You are helping check a Lean 4 formalization. Statement.lean (in this directory) contains Lean 4 + Mathlib declarations; the definitions it imports are in ${path.join(SCRATCH, 'ctx')}/Pilot/U/ and Mathlib sources are in ${MATHLIB_SRC}.
Write to english.md a precise mathematical statement, in LaTeX-style English, of EXACTLY what the theorem(s) named thm_* in Statement.lean assert (not what an author might have intended): every hypothesis, quantifier and type, with Pilot/Mathlib definitions explained in standard mathematical language (you may name a Pilot definition when it is a standard notion, e.g. "the Schwartz-Bruhat space S(F_v)"). Also give the auxiliary definitions from Statement.lean in words. Do not copy Lean code. Write only english.md.`;
  syncCtx();
  const c1 = await runLane(Y, d1, p1, 15 * 60, `rt-${u1}`);
  const en = fs.existsSync(path.join(d1, 'english.md')) ? fs.readFileSync(path.join(d1, 'english.md'), 'utf8') : '';
  res.steps.en = { vendor: Y, wall_s: +c1.wall.toFixed(1), ok: en.length > 50 };
  if (!en) { res.ok = false; res.reason = 'no English produced'; appendJsonl('rt-units.jsonl', res); return res; }
  // step 2: X (fresh session) writes Lean from the English, blind to the original Lean and the paper
  const u2 = `rt_lean_${sanit(j.id)}`; const d2 = laneDir(u2);
  const blind = blindCtx('ctx_blind', defMods);
  fs.writeFileSync(path.join(d2, 'english.md'), en);
  const names = j.thms.map((t) => t.short.replace(/^thm_/, 'rt_'));
  const p2 = `${COMMON(u2).replace(path.join(SCRATCH, 'ctx'), blind)}

TASK: english.md (in this directory) states a theorem. Formalize it in Lean 4 into RT.lean: ${names.map((n) => `\`theorem ${n} : ... := by sorry\``).join(', ')} inside \`namespace Pilot\` (one theorem per numbered part if english.md has parts matching those names; otherwise a single theorem ${names[0]}). Reuse the Pilot definitions in ${blind}/Pilot/U (import them as Pilot.U.<FileName>) whenever english.md refers to them. Auxiliary definitions that english.md describes go in RT.lean before the theorem, complete (no sorry in defs). Do not prove anything. Do not open any other Pilot files. Done when ./lean-check RT.lean reports no errors.`;
  const r2 = await unitLoop({ unit: u2, vendor: X, capS: 20 * 60, maxAttempts: 8, phase: 'rt', addDirs: [MATHLIB_SRC, blind], prompt: (fb) => p2 + (fb ? '\n\nPREVIOUS ATTEMPT FAILED:\n' + fb : ''),
    check: async (d) => {
      const f = path.join(d, 'RT.lean');
      if (!fs.existsSync(f)) return { ok: false, feedback: 'RT.lean not written', summary: {}, result: {} };
      const text = fs.readFileSync(f, 'utf8');
      const l = lint(f, ['--mode', 'statement']);
      const lc = leanCheck(u2, 'RT.lean', text);
      const probs = l.violations.map((v) => `lint: ${v.token}: ${v.reason}`);
      if (lc.exit !== 0 || lc.errors.length) probs.push('Lean errors:\n' + lc.out.slice(0, 4000));
      if (!names.some((n) => text.includes(n))) probs.push(`theorem ${names[0]} not found`);
      for (const m of text.matchAll(/^\s*import\s+Pilot\.U\.(\S+)/gm)) if (!defMods.includes(m[1])) probs.push(`blind back-translation may only import definition modules; Pilot.U.${m[1]} is not one`);
      return { ok: !probs.length, feedback: probs.join('\n'), summary: { lean_exit: lc.exit, lean_wall_s: lc.wall }, result: {} };
    } });
  res.steps.lean = { vendor: X, accepted: r2.accepted, wall_min: r2.wall_min, attempts: r2.attempts };
  if (!r2.accepted) { res.ok = false; res.reason = 'back-translation did not compile'; appendJsonl('rt-units.jsonl', res); return res; }
  // namespace the RT file as its own module (rename clashing aux defs by wrapping in Pilot.RT_<id>)
  let rtText = fs.readFileSync(path.join(d2, 'RT.lean'), 'utf8').replace(/namespace Pilot\b/, `namespace Pilot.RT_${sanit(j.id)}`).replace(/^end Pilot\s*$/m, `end Pilot.RT_${sanit(j.id)}`);
  fs.writeFileSync(path.join(RTDIR, `R_${sanit(j.id)}.lean`), rtText);
  const b = pushModule('RT', `R_${sanit(j.id)}`);
  if (!b.ok) { res.ok = false; res.reason = 'RT module build failed: ' + b.out.slice(-400); appendJsonl('rt-units.jsonl', res); return res; }
  // step 3: Y proves equivalence of each part
  const u3 = `rt_eq_${sanit(j.id)}`; const d3 = laneDir(u3);
  const pairs = j.thms.map((t) => ({ a: `Pilot.${t.short}`, b: `Pilot.RT_${sanit(j.id)}.${t.short.replace(/^thm_/, 'rt_')}`, e: `eq_${t.short.replace(/^thm_/, '')}` }))
    .filter((p) => rtText.includes(p.b.split('.').pop()));
  // Compare both statements at universe 0: `type_of% @c` alone gives each side its own universe
  // variables, which makes the iff unprovable for universe-polymorphic statements.
  const probe = `import Mathlib\nimport Pilot.U.${mod}\nimport Pilot.RT.R_${sanit(j.id)}\n` + pairs.map((p) => `#check ${p.a}\n#check ${p.b}\n`).join('');
  const pr = leanCheck(u3 + '_probe', 'Probe.lean', probe);
  const inst = (name) => {
    const m = pr.out.match(new RegExp(name.replace(/\./g, '\\.') + '\\.\\{([^}]*)\\}'));
    const k = m ? m[1].split(',').length : 0;
    return k ? `@${name}.{${Array(k).fill(0).join(', ')}}` : `@${name}`;
  };
  const eqSkel = `import Mathlib\nimport Pilot.U.${mod}\nimport Pilot.RT.R_${sanit(j.id)}\n\nnamespace Pilot\n\n` +
    pairs.map((p) => `theorem ${p.e} : type_of% ${inst(p.a)} ↔ type_of% ${inst(p.b)} := by\n  sorry\n`).join('\n') + `\nend Pilot\n`;
  fs.writeFileSync(path.join(d3, 'Equiv.lean'), eqSkel);
  const skelPath = path.join(d3, 'Equiv.skeleton.lean'); fs.writeFileSync(skelPath, eqSkel);
  const p3 = `${COMMON(u3)}

TASK: Equiv.lean states that two formalizations of the same theorem are equivalent: ${pairs.map((p) => p.e).join(', ')}. Prove each (replace each sorry). The two statements live in the Pilot modules imported at the top (sources: ${path.join(SCRATCH, 'ctx')}/Pilot/U/${mod}.lean and ${RTDIR}/R_${sanit(j.id)}.lean). Do not change the statements. You may add helper lemmas. If you find they are NOT equivalent, write \`GAP: NOT EQUIVALENT: <precise difference>\` to gap.txt and stop. Done when ./lean-check Equiv.lean has no errors and no sorry.`;
  const r3 = await unitLoop({ unit: u3, vendor: Y, capS: 20 * 60, maxAttempts: 8, phase: 'rt', prompt: (fb) => p3 + (fb ? '\n\nPREVIOUS ATTEMPT FAILED:\n' + fb : ''),
    check: async (d) => {
      const f = path.join(d, 'Equiv.lean');
      const text = fs.readFileSync(f, 'utf8');
      const l = lint(f, ['--skeleton', skelPath, ...pairs.flatMap((p) => ['--target', p.e]), '--mode', 'proof']);
      const checkText = text.replace(/^(\s*import [^\n]*\n)+/, (m) => m + 'import Pilot.Check\n') + pairs.map((p) => `\n#unit_axioms Pilot.${p.e}`).join('') + '\n';
      const lc = leanCheck(u3, 'Equiv.lean', checkText);
      const probs = l.violations.map((v) => `lint: ${v.token}: ${v.reason}`);
      if (lc.exit !== 0 || lc.errors.length) probs.push('Lean errors:\n' + lc.out.slice(0, 4000));
      const axs = [...lc.out.matchAll(/UNIT_AXIOMS [^:]+: \[([^\]]*)\]/g)].map((m) => m[1]);
      if (axs.length !== pairs.length || axs.some((a) => /sorryAx/.test(a))) probs.push('equivalence proofs still use sorry: ' + axs.join(' | '));
      return { ok: !probs.length, feedback: probs.join('\n'), summary: { lean_exit: lc.exit, lean_wall_s: lc.wall }, result: {} };
    } });
  res.steps.eq = { vendor: Y, accepted: r3.accepted, wall_min: r3.wall_min, attempts: r3.attempts, reason: r3.reason };
  res.ok = r3.accepted; res.reason = r3.accepted ? '' : r3.reason;
  res.wall_min = +((now() - t0) / 60).toFixed(2);
  appendJsonl('rt-units.jsonl', res);
  log(`rt ${j.id}: ${res.ok ? 'EQUIVALENT (proved)' : 'FAILED ' + res.reason}`);
  return res;
}

// ---------- main ----------
const [, , phase, ...rest] = process.argv;
const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1].split(',') : null; };
const t0 = now();
let out;
if (phase === 'skel') out = await phaseSkel(opt('--only'));
else if (phase === 'proof') out = await phaseProof(opt('--only'));
else if (phase === 'rt') out = await phaseRT(opt('--ids'));
else { console.error('phase: skel | rt | proof'); process.exit(2); }
log(`${phase} done in ${((now() - t0) / 60).toFixed(1)} min: ${out.filter((r) => r.accepted || r.ok).length}/${out.length} accepted`);
