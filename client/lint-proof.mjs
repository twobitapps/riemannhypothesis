#!/usr/bin/env node
// lint-proof.mjs — submission linter for Riemann swarm Lean units.
//
// Usage:
//   node client/lint-proof.mjs <submission.lean> [--skeleton <skeleton.lean>] [--target <declName>]...
//                              [--mode proof|statement] [--import-roots Mathlib,Pilot] [--json]
//
// Checks (comments and string literals are stripped first):
//   1. Forbidden commands/keywords anywhere in the file. This is the list in docs/SAFETY.md §2
//      (run_cmd, #eval, initialize, elab, macro, syntax, unsafe, implemented_by, extern,
//      native_decide, axiom, opaque, set_option except maxHeartbeats) plus the variants that
//      reach the same capabilities by another name:
//        run_cmd run_tac run_elab run_meta #eval #eval! initialize builtin_initialize
//        elab elab_rules macro macro_rules syntax declare_syntax_cat notation infix infixl
//        infixr prefix postfix unsafe implemented_by extern native_decide axiom opaque
//        and `set_option` for anything other than `maxHeartbeats` (value <= MAX_HEARTBEATS).
//      Also the `native` config flag (decide +native) and `Lean.ofReduceBool`/`trustCompiler`.
//   2. Imports: only `Mathlib...` and the project's own root (default `Pilot`; set with
//      --import-roots Mathlib,MyRoot).
//   3. With --skeleton: every top-level declaration of the skeleton must appear unchanged
//      (whitespace-normalized) in the submission, except that for each --target theorem only
//      the header up to `:=` must match (its proof may change). New declarations may be added.
//   4. In proof mode, `sorry`/`admit` inside the --target declarations is rejected.
// Exit code 0 = clean, 1 = violations, 2 = usage / IO error.
// The kernel-level check (no sorryAx, only standard axioms) is done separately by Lean.

import fs from 'node:fs';

const MAX_HEARTBEATS = 1_000_000;
let ALLOWED_IMPORT_ROOTS = ['Mathlib', 'Pilot'];

const FORBIDDEN = new Map(Object.entries({
  run_cmd: 'runs arbitrary code at compile time',
  run_tac: 'runs arbitrary TacticM code',
  run_elab: 'runs arbitrary elaborator code',
  run_meta: 'runs arbitrary MetaM code',
  '#eval': 'evaluates code at compile time',
  '#eval!': 'evaluates code at compile time',
  initialize: 'runs code at import time',
  builtin_initialize: 'runs code at import time',
  elab: 'defines an elaborator',
  elab_rules: 'defines an elaborator',
  macro: 'defines a macro',
  macro_rules: 'defines a macro',
  syntax: 'extends the parser',
  declare_syntax_cat: 'extends the parser',
  notation: 'extends the parser',
  infix: 'extends the parser',
  infixl: 'extends the parser',
  infixr: 'extends the parser',
  prefix: 'extends the parser',
  postfix: 'extends the parser',
  unsafe: 'unsafe code',
  implemented_by: 'replaces compiled code',
  extern: 'replaces compiled code',
  native_decide: 'trusts the compiler (Lean.ofReduceBool)',
  axiom: 'adds an axiom',
  opaque: 'opaque constant (can hide unsound implementations)',
  ofReduceBool: 'trusts the compiler',
  trustCompiler: 'trusts the compiler',
}));

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: lint-proof.mjs <file.lean> [--skeleton s.lean] [--target name]... [--mode proof|statement] [--json]');
  process.exit(2);
}

// Replace comments and string/char literals by spaces, keeping line/column positions.
export function stripCommentsAndStrings(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '-' && d === '-') { // line comment
      let j = i; while (j < n && src[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && d === '-') { // nested block comment (incl. doc comments)
      let depth = 0, j = i;
      while (j < n) {
        if (src[j] === '/' && src[j + 1] === '-') { depth++; j += 2; continue; }
        if (src[j] === '-' && src[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; continue; }
        j++;
      }
      blank(i, j); i = j; continue;
    }
    if (c === '"') { // string literal with escapes
      let j = i + 1;
      while (j < n && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
      blank(i, Math.min(j + 1, n)); i = j + 1; continue;
    }
    if (c === "'" ) { // char literal 'x' or '\n' (but not primes in identifiers like h')
      const prev = i > 0 ? src[i - 1] : ' ';
      if (!/[A-Za-z0-9_'.!?Ͱ-Ͽἀ-῿₀-₉]/.test(prev)) {
        const m = /^'(\\.|[^'\\\n])'/.exec(src.slice(i, i + 6));
        if (m) { blank(i, i + m[0].length); i += m[0].length; continue; }
      }
    }
    if (c === '«') { // guillemet identifiers are kept (they are identifiers), skip to closing »
      let j = i + 1; while (j < n && src[j] !== '»') j++;
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

function lineCol(src, idx) {
  let line = 1, col = 1;
  for (let k = 0; k < idx; k++) { if (src[k] === '\n') { line++; col = 1; } else col++; }
  return { line, col };
}

// Tokens: identifiers (possibly dotted), #commands, @[...] attribute contents are plain text.
const TOKEN_RE = /#?[A-Za-z_À-ɏͰ-Ͽ][A-Za-z0-9_'!?À-ɏͰ-Ͽ₀-₉]*(?:\.[A-Za-z_À-ɏͰ-Ͽ][A-Za-z0-9_'!?À-ɏͰ-Ͽ₀-₉]*)*/g;

export function lintSource(src) {
  const code = stripCommentsAndStrings(src);
  const violations = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(code))) {
    const tok = m[0];
    const parts = tok.startsWith('#') ? [tok] : tok.split('.');
    for (const p of parts) {
      if (FORBIDDEN.has(p)) {
        violations.push({ ...lineCol(code, m.index), token: p, reason: FORBIDDEN.get(p) });
      }
    }
    if (tok === 'native' || /(^|\.)native$/.test(tok)) {
      // `decide +native`, `(config := { native := true })`
      violations.push({ ...lineCol(code, m.index), token: tok, reason: 'native evaluation flag' });
    }
    if (tok === 'set_option') {
      const rest = code.slice(m.index + tok.length).match(/^\s+([A-Za-z_.]+)\s+(\S+)/);
      const opt = rest ? rest[1] : '?';
      const val = rest ? Number(rest[2]) : NaN;
      if (opt !== 'maxHeartbeats') {
        violations.push({ ...lineCol(code, m.index), token: `set_option ${opt}`, reason: 'only maxHeartbeats may be set' });
      } else if (!(val >= 0 && val <= MAX_HEARTBEATS)) {
        violations.push({ ...lineCol(code, m.index), token: `set_option maxHeartbeats ${rest ? rest[2] : ''}`, reason: `maxHeartbeats must be a number <= ${MAX_HEARTBEATS}` });
      }
    }
  }
  // imports
  const importRe = /^\s*import\s+(.+)$/gm;
  while ((m = importRe.exec(code))) {
    for (const mod of m[1].trim().split(/\s+/)) {
      const root = mod.split('.')[0];
      if (!ALLOWED_IMPORT_ROOTS.includes(root)) {
        violations.push({ ...lineCol(code, m.index), token: `import ${mod}`, reason: `imports must start with ${ALLOWED_IMPORT_ROOTS.join(' or ')}` });
      }
    }
  }
  return { code, violations };
}

// Split stripped code into top-level declaration chunks. A chunk starts at a line whose first
// column begins a command keyword (optionally preceded by modifiers / attributes).
const DECL_START = /^(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|partial|nonrec)\s+)*(theorem|lemma|def|abbrev|instance|structure|class|inductive|example|irreducible_def)\b/;
const CMD_START = /^(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|partial|nonrec)\s+)*(theorem|lemma|def|abbrev|instance|structure|class|inductive|example|irreducible_def|namespace|end|section|open|variable|universe|import|set_option|attribute|noncomputable section|#check|#print)\b/;

export function declarations(code) {
  const lines = code.split('\n');
  const decls = [];
  let cur = null;
  const ns = [];
  const flush = () => { if (cur) { cur.text = cur.lines.join('\n'); decls.push(cur); cur = null; } };
  for (const line of lines) {
    if (line.length && !/^\s/.test(line) && CMD_START.test(line)) {
      flush();
      const nsm = line.match(/^namespace\s+(\S+)/); if (nsm) ns.push(nsm[1]);
      const endm = line.match(/^end\s+(\S+)/); if (endm && ns.length && ns[ns.length - 1].endsWith(endm[1])) ns.pop();
      const dm = line.match(DECL_START);
      if (dm) {
        const after = line.slice(dm[0].length).trim();
        const nameTok = after.split(/[\s({[:]/)[0];
        const full = nameTok ? [...ns, nameTok].join('.') : '';
        cur = { kind: dm[1], name: full, short: nameTok, lines: [line] };
      }
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  flush();
  return decls;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function header(text) {
  // header = text up to the first top-level `:=` (or `where` / `|` for structures/pattern defs)
  const i = text.indexOf(':=');
  return norm(i >= 0 ? text.slice(0, i) : text);
}

function sameName(d, t) { return d.name === t || d.short === t || d.name.endsWith('.' + t) || t.endsWith('.' + d.short) && d.name.endsWith(t.split('.').slice(-1)[0]); }

export function compareWithSkeleton(subCode, skelCode, targets, mode) {
  const violations = [];
  const sub = declarations(subCode);
  const skel = declarations(skelCode);
  for (const d of skel) {
    if (!d.name) continue;
    const isTarget = targets.some((t) => sameName(d, t));
    const match = sub.filter((s) => s.name === d.name && s.kind === d.kind);
    if (match.length !== 1) {
      violations.push({ line: 0, col: 0, token: d.name, reason: match.length ? 'declaration duplicated' : 'skeleton declaration missing or renamed' });
      continue;
    }
    if (isTarget) {
      if (header(match[0].text) !== header(d.text)) {
        violations.push({ line: 0, col: 0, token: d.name, reason: 'statement (header before :=) differs from the locked skeleton' });
      }
      if (mode === 'proof' && /\b(sorry|admit)\b/.test(match[0].text)) {
        violations.push({ line: 0, col: 0, token: d.name, reason: 'target still contains sorry/admit' });
      }
    } else if (norm(match[0].text) !== norm(d.text)) {
      violations.push({ line: 0, col: 0, token: d.name, reason: 'non-target skeleton declaration was modified' });
    }
  }
  for (const t of targets) {
    if (!skel.some((d) => sameName(d, t))) violations.push({ line: 0, col: 0, token: t, reason: 'target not found in skeleton' });
  }
  return violations;
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length) usage();
  let file = null, skeleton = null, mode = 'proof', json = false;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--skeleton') skeleton = args[++i];
    else if (a === '--target') targets.push(args[++i]);
    else if (a === '--mode') mode = args[++i];
    else if (a === '--json') json = true;
    else if (a === '--import-roots') ALLOWED_IMPORT_ROOTS = args[++i].split(',').filter(Boolean);
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else file = a;
  }
  if (!file) usage('missing file');
  let src, skel;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { usage(`cannot read ${file}`); }
  const { code, violations } = lintSource(src);
  if (skeleton) {
    try { skel = fs.readFileSync(skeleton, 'utf8'); } catch (e) { usage(`cannot read ${skeleton}`); }
    violations.push(...compareWithSkeleton(code, stripCommentsAndStrings(skel), targets, mode));
  }
  const result = { ok: violations.length === 0, file, violations };
  if (json) console.log(JSON.stringify(result));
  else if (result.ok) console.log(`lint ok: ${file}`);
  else for (const v of violations) console.log(`${file}:${v.line}:${v.col}: ${v.token}: ${v.reason}`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('lint-proof.mjs')) main(process.argv);
