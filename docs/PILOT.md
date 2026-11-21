# Track M pilot — measured numbers

This pilot replaces the guesses in the sizing table of `docs/PLAN.md` §5 with
numbers measured on a small, representative slice of Masullo, *The Music of the
Primes* (940 pp.). Everything below was measured on 20 November 2026.

## Summary

- **Definitions.** Of the paper's 185 defining items, 28 exist in Mathlib as
  is, 50 need a thin wrapper, 103 need real development and 4 have no support;
  stating them all takes an estimated 8,700 Lean lines. App. E (topological
  stacks) accounts for 65 of the 185.
- **Statements.** All 33 pilot items (14 definitions, 19 results) compiled on
  the lane's first session: 1.9 lane-minutes and 39 Lean lines per item.
  Review rejected 1 of 34 Lean-accepted versions (a vacuous definition) and
  flagged 2 of the 19 statements for the author's review.
- **Round trips.** 10 of 10 equivalences proved in Lean, 3.1 lane-minutes per
  statement. Both sides were Claude, because Codex ran out of allowance.
- **Proofs.** 23 of 33 units were accepted within 30 minutes / 8 attempts, 19
  of them unconditionally; the median was 9.9 minutes and 222 lines. The other
  10 stopped within 2 minutes: 2 statements were flagged for the author's review, 1 needed a
  statement that is missing from the skeleton, and 7 need foundations that do
  not exist yet. **The rate was about 1,420 accepted Lean lines per lane-hour**,
  against PLAN.md's guess of 100–1,000.
- **Lean.** A check with `import Mathlib` takes 13 s at the median and 5.4–6.0
  GiB of memory. Re-checking an accepted proof takes 16 s.
- **What changes.** Compute is not the bottleneck: the low to high cases need
  25–360 lanes, not 1,000. The bottleneck is how fast statements can be
  written and reviewed, foundation statements above all.

## 1. Setup

- **Lean:** v4.36.0 with Mathlib tag v4.36.0 (commit `fc4f59e5`, 16 Nov 2026).
  All Lean checks ran on the anchor, a 24-core / 64 GB M2 Ultra Mac that other
  workloads were also using (load average ≈ 12 during the run). Each check is
  `lean <file>` with `import Mathlib`, run under `nice`, at most 3 Lean
  processes at a time, and paused while free memory is under 25 %.
- **Lanes:** headless Claude Code (`claude -p`, model `claude-opus-5-5`) and
  Codex (`codex exec`, model `gpt-5.6-terra`, reasoning effort `xhigh`), at most
  2 lanes at a time. Each lane is an agent with file tools and one shell
  command, `./lean-check <file>`, which runs Lean on the anchor. Lanes may grep
  a local copy of the Mathlib sources.
- **Units:** one blueprint item per skeleton unit; one `sorry` theorem per proof
  unit. A unit gets up to 8 lane calls (each call is one *attempt*; after a
  failed attempt the next call receives the driver's Lean errors and linter
  report). Caps: 20 min per skeleton unit, 30 min per proof unit.
- **Acceptance (driver, not the lane):**
  1. `client/lint-proof.mjs` — rejects `run_cmd`/`run_tac`/`run_elab`/`run_meta`,
     `#eval`, `initialize`, `elab`, `macro`, `syntax`, `notation` and other parser
     extensions, `unsafe`, `implemented_by`, `extern`, `native_decide` and
     `+native`, `axiom`, `opaque`, `set_option` other than `maxHeartbeats`
     (≤ 1,000,000), and imports outside `Mathlib`/`Pilot`; in proof mode it also
     checks that every skeleton declaration is unchanged and that the target's
     statement (header before `:=`) is byte-for-byte the locked one.
  2. Lean compiles the file with no errors.
  3. Kernel axiom check: `#unit_axioms` (in `lean/pilot/Pilot/Check.lean`) walks
     the target's dependency graph, stopping at other locked skeleton theorems,
     and the result must be a subset of `{propext, Classical.choice, Quot.sound}`.
     This is what lets a proof use other units' locked statements without
     inheriting their `sorry`.
- **Review:** every definition accepted by Lean was read by a reviewer
  (fidelity to the paper), and every statement too. In the real run this is the
  expert gate.
- Pilot Lean sources and per-unit logs are held back until the author has seen the findings. Sources (private for now): `lean/pilot/Pilot/U/*.lean` (skeleton), `lean/pilot/Pilot/RT/*.lean`
  (round-trip back-translations), `lean/pilot/proofs/*.lean` (accepted proofs),
  `lean/pilot/Pilot/Deps.lean` (the re-check, which also reports which locked
  statements a proof uses),
  `lean/pilot/harness/` (driver, report, Lean wrapper), `lean/pilot/logs/`
  (raw per-attempt measurements).

**Deviations from the intended setup.**

1. *Where the lanes ran.* The vendor logins on the anchor had expired (both
   CLIs refused with an expired-token error in a non-interactive session), and
   logging in again is a credential step for the machine's operator, not for an
   agent. So the lanes ran on a second Mac with working logins; every Lean
   check still ran on the anchor, over the network.
2. *Codex ran out after 3 calls.* The Codex account available was on a plan
   with a small allowance: after 3 working calls (264,221 tokens reported)
   every call returned "You've hit your usage limit … try again at Dec 18th".
   From then on, lane B was a second, independent Claude Code session. All
   Codex numbers below therefore come from those 3 calls, and the round trips
   were Claude-vs-Claude. A volunteer on a similar plan contributes about one
   unit per month; the client must detect this message and stop (SAFETY.md
   §3 already says so).
3. *Lanes had tools.* Pilot lanes could edit their one file and run Lean
   through `./lean-check` (they did, ~1.8 times per skeleton unit before
   handing back). docs/SAFETY.md specifies text-only lanes with Lean run by
   the client. A text-only lane gets one Lean verdict per call instead of
   several per session, so expect more attempts per accepted unit than
   measured here.

## 2. Definition coverage (all defining items)

The paper has **1,093 numbered items** by our extraction (pdftotext, every
`Kind A.B.C.D` heading, gaps in the numbering checked by hand): 304 lemmas,
129 theorems, 106 propositions, 47 corollaries, 2 conjectures, 1 claim
(**589 results**), 253 remarks, 56 examples, **158 definitions, 19
constructions, 6 notations, 2 terminologies (185 defining items)**, 9
situations and 1 discussion. (PLAN.md's 183 / 755 do not match this count.)

`blueprint/definitions.csv` rates each of the 185 defining items against this
Mathlib. Every Mathlib name in it (284 distinct) was checked with `#check` in
the anchor environment; all resolve (one, `PiTensorProduct.injectiveSeminorm`,
is deprecated). Status: **exact** = usable as is; **close** = thin wrapper
(< ~50 lines); **partial** = ingredients exist but the notion needs real
development; **missing** = no support. `est_lines` in the notes is the
estimated Lean needed just to *state* the definition.

| Part of the paper | items | exact | close | partial | missing | est. lines to state |
|---|---|---|---|---|---|---|
| Ch. 2–12 (main text) | 58 | 2 | 7 | 45 | 4 | 3,013 |
| App. A (algebraic number theory) | 20 | 4 | 7 | 9 | 0 | 1,105 |
| App. B (analytic number theory) | 6 | 0 | 4 | 2 | 0 | 315 |
| App. C (locally convex spaces) | 20 | 2 | 7 | 11 | 0 | 1,243 |
| App. D (Schwartz–Bruhat) | 16 | 0 | 6 | 10 | 0 | 608 |
| App. E (topological stacks) | 65 | 20 | 19 | 26 | 0 | 2,422 |
| **Total** | **185** | **28** | **50** | **103** | **4** | **≈ 8,700** |

What exists in this Mathlib (more than PLAN.md assumed): adele and idele rings
and the idele class group (`NumberField.AdeleRing`, `IdeleGroup`,
`IdeleClassGroup`), Hecke characters as continuous homomorphisms
`IdeleClassGroup → ℂ` with their finite L-function
(`NumberField.HeckeCharacter.LFunction`), Dedekind zeta, Schwartz space on
real normed spaces, tempered distributions, strong duals and S-topologies
(`UniformConvergenceCLM`, `StrongDual`), barrelled spaces, restricted products,
compactly generated spaces (`CompactlyGeneratedSpace`, `GeneratedByTopCat`),
bicategories, pseudofunctors, fibered categories and the Grothendieck
construction.

What is missing and must be built before most statements can even be written:

1. **Schwartz–Bruhat spaces of LCA groups** (Bruhat's S(G), App. D) and of
   adeles/ideles, with their LF topologies; Mathlib's Schwartz space needs a
   normed domain.
2. **Locally convex inductive limits, LF-spaces, topological tensor products
   and nuclearity** (App. C): only special cases exist (test functions; normed
   projective/injective tensor seminorms). No nuclear operators, trace class,
   Schatten classes.
3. **Adelic harmonic analysis:** Haar/Tamagawa measures on adeles and ideles
   (no measurable structure on the adele ring yet), the standard additive
   character, the adelic Fourier transform, Fourier/Plancherel on general LCA
   groups.
4. **Quasi-character surfaces Ω(G)** and meromorphic functions on them;
   Mathlib's `MeromorphicOn` lives on a field.
5. **App. E:** internal groupoids, stacks as categories fibered in groupoids,
   stackification, weakly Hausdorff spaces (CGWH), 2-limits in a general
   2-category. App. E is 65 of the 185 defining items; its single largest
   definition (quotient stacks, E.6.2.4) is estimated at ~800 lines.

## 3. Pilot slice

`blueprint/pilot.json`: 33 items, chosen to cover each kind of work rather than
the easy ones — §2.1 (Schwartz–Bruhat spaces, 12 items), §2.2.3.1, §3.1.1 and
§3.2 (idelic zeta functions, Hecke L-functions, Tate's theorem; 9 items),
App. B.1 (convexity bound; 4 items), and the App. C/D foundation definitions
these use (LF-spaces, nuclear spaces, modulated groups), plus 4 definitions the
paper only makes in running text (S(F_v), S(A_F), Ω(G), the locally convex
vocabulary). By kind: 10 numbered definitions, 4 running-text definitions, 6 propositions, 7 lemmas, 1 theorem (Tate, 3.2.2.1), 2 corollaries, 2 examples, 1 remark. Together they cover about 30 pages of the paper.

## 4. Statement skeleton

Order: definitions first (in dependency order), then statements. Each unit is
one lane session that writes one Lean file and checks it with Lean until it
compiles; the driver then lints and re-checks it, builds it as a module, and a
reviewer reads it against the paper.

| | units | accepted by Lean | attempts per unit | median lane minutes per unit | lane-hours | Lean lines (non-blank, non-comment) |
|---|---|---|---|---|---|---|
| definitions (numbered + running-text) | 14 | 14 | 1 | 1.9 | 0.49 | 521 |
| statements (props, lemmas, theorem, corollaries, examples, remark) | 19 | 19 | 1 | 1.4 | 0.53 | 769 |
| **total** | **33** | **33** | **1** | **1.6** | **1.02** | **1,290** (≈ 39 per item) |

Every unit compiled on its lane's first session; the lanes ran Lean themselves
1.8 times per unit on average before handing back. The statement layer is
cheap: **≈ 1.9 lane-minutes per item, ≈ 1,270 lines per lane-hour**.

**Review is the bottleneck, not writing.** Of 34 versions accepted by Lean, the
reviewer rejected one: the first nuclear-space definition (C.2.4.1, Codex) took
the projective and injective tensor topologies as *parameters*, so any space
could be called nuclear by passing equal topologies. The rewrite (after the
driver's prompt gained an explicit "never take the defining structure as a
parameter" rule) uses the Grothendieck–Pietsch characterization and passed.
Final verdicts on the 33 units:

| verdict | units | examples |
|---|---|---|
| faithful (incl. equivalent by a standard cited theorem) | 26 | S(F_v) = locally constant compactly supported functions with the finest locally convex topology; Schwartz space via Mathlib's `SchwartzMap` with the paper's seminorms defined alongside |
| faithful, generalized | 3 | 3.2.2.1, 3.2.2.3, 3.2.2.5: arbitrary Haar measure instead of the Tamagawa normalization; true-but-missing instances on C_F assumed |
| weakened | 1 | 3.2.1.3: residue volume μ̄₁(C_F^1) replaced by "some V > 0" (no Haar measure on C_F^1 in Mathlib) |
| corrected (paper does not typecheck) | 1 | 2.1.4.3(3), found independently by the lane |
| flagged for the author's review | 2 | details shared with the author first |

Two of 19 statements were flagged for the author's review. In a full run, flagged statements must be caught by statement review before they reach the proof queue.

## 5. Round trips

Ten statements (2.1.1.6, 2.1.2.5, 2.1.2.6, 2.1.2.10, 2.1.4.4, 3.2.1.1,
3.2.1.3, B.1.1.1, B.1.1.2, B.1.1.3): lane Y wrote an English/LaTeX statement
from the Lean alone (no paper); lane X, in a fresh session that could see only
the definition modules (not the statement files), wrote Lean from that text;
lane Y proved `type_of% thm ↔ type_of% rt` in Lean.

- **10/10 equivalences proved by Lean**, each step on its first attempt; median
  **3.1 lane-minutes per statement** (English ≈ 0.7 min, back-translation ≈ 0.7
  min, equivalence ≈ 0.7 min plus Lean checks).
- A harness bug first made two equivalences unprovable (`type_of%` gave the two
  sides independent universe variables; the lane diagnosed it and stopped with
  `NOT EQUIVALENT`). Fixed by comparing both at universe 0; both reruns passed.
- **Caveat 1 — same vendor.** Codex was unavailable (§1), so X and Y were two
  independent Claude sessions, not Claude vs. Codex as PLAN.md requires.
- **Caveat 2 — what a round trip measures.** It checks that the Lean says what
  a reader of the Lean thinks it says. It does not compare with the paper: the
  two statements later flagged for the author's review both round-trip
  perfectly, and the vacuous nuclear-space definition would have too. Paper
  fidelity still needs a reviewer who reads the PDF.

## 6. Proofs

Every `sorry` in the locked skeleton is a unit: 33 units from the 19 statement
items (multi-part results were split by part). Units alternated between the two
lanes in a fixed interleaved order. A lane could stop early by writing `GAP:`
with a reason (false statement, or foundations out of reach).

Lane A and lane B are both Claude Code (§1). "Lean lines" counts non-blank, non-comment lines added to the skeleton file (helper lemmas included). "Uses locked statements" lists the other units' statements the proof actually depends on, as recorded by the re-check.

| unit | kind | lane | wall min | attempts | accepted | Lean lines | uses locked statements | failure reason |
|---|---|---|---|---|---|---|---|---|
| 2.1.2.5 | example | A | 3.3 | 1 | y | 96 |  |  |
| B.1.1.1 | lemma | B | 14.1 | 1 | y | 580 |  |  |
| 2.1.2.6 | example | A | 4.7 | 1 | y | 128 |  |  |
| 3.2.1.1 | lemma | B | 11.5 | 1 | y | 447 |  |  |
| 2.1.2.4(1) | proposition | A | 9.3 | 1 | y | 211 |  |  |
| (withheld) | lemma | B | 1.0 | 1 | n | - |  | flagged for author review |
| (withheld) | lemma | A | 0.8 | 1 | n | - |  | flagged for author review |
| 2.1.2.10(1) | lemma | B | 10.4 | 1 | y | 194 |  |  |
| 2.1.1.6(1) | proposition | A | 0.9 | 1 | n | - |  | foundations: completeness, Montel, reflexivity, nuclearity of Schwartz space |
| 2.1.2.4(3) | proposition | B | 1.3 | 1 | y | 20 |  |  |
| B.1.1.3 | proposition | A | 1.4 | 1 | n | - |  | missing statement: finite functional equation and the bound on W are not locked theorems |
| 2.1.4.1(3) | proposition | B | 8.4 | 1 | y | 239 |  |  |
| 3.2.2.3 | lemma | A | 2.0 | 1 | n | - |  | foundations: Haar measure and integrability on ideles (Tate) |
| 2.1.4.3 | lemma | B | 9.9 | 1 | y | 285 | 2.1.4.1(5), 2.1.4.1(3) |  |
| B.1.1.4 | remark | A | 3.5 | 1 | y | 109 | a flagged statement **(rests on an unproved one)** |  |
| 2.1.2.8(1) | proposition | B | 12.0 | 1 | y | 268 |  |  |
| 2.1.4.4 | corollary | A | 6.5 | 1 | y | 129 | 2.1.4.1(5), 2.1.4.1(3) |  |
| 3.2.1.3 | proposition | B | 1.2 | 1 | n | - |  | foundations: Hecke's theorem (continuation, functional equation) |
| 2.1.2.4(2) | proposition | A | 30.2 | 2 | y | 531 | 2.1.2.4(1) |  |
| 2.1.4.1(4) | proposition | B | 0.7 | 1 | y | 1 | 2.1.4.1(3) |  |
| 2.1.2.10(2) | lemma | A | 8.4 | 1 | y | 172 |  |  |
| 2.1.3.2(2) | lemma | B | 4.1 | 1 | y | 116 | 2.1.3.2(1) **(rests on an unproved one)** |  |
| 3.2.2.1 | theorem | A | 1.3 | 1 | n | - |  | foundations: Tate's thesis |
| 2.1.1.6(2) | proposition | B | 0.8 | 1 | n | - |  | foundations: duals of nuclear Fréchet spaces (DFN) |
| 2.1.2.8(3) | proposition | A | 1.8 | 1 | y | 11 |  |  |
| 2.1.4.2(1) | corollary | B | 28.9 | 2 | y | 630 | 2.1.4.1(3), 2.1.4.1(1), 2.1.3.2(1), 2.1.4.1(4), 2.1.4.1(5) **(rests on an unproved one)** |  |
| 2.1.2.10(3) | lemma | A | 10.1 | 1 | y | 222 |  |  |
| 2.1.4.1(1) | proposition | A | 20.7 | 2 | y | 563 |  |  |
| 2.1.3.2(1) | lemma | A | 1.3 | 1 | n | - |  | foundations: strict LF / nuclear / Montel structure of S(A_F^f), S(A_F) |
| 2.1.2.8(2) | proposition | B | 14.8 | 1 | y | 287 | 2.1.2.8(1), 2.1.2.4(2), 2.1.2.4(1) |  |
| 2.1.4.1(2) | proposition | A | 1.4 | 1 | n | - |  | foundations: same structure for S(A_{F,S}) |
| 2.1.4.1(5) | proposition | A | 20.3 | 2 | y | 555 | 2.1.4.1(3) |  |
| 2.1.4.2(2) | corollary | A | 14.2 | 1 | y | 388 | 2.1.4.1(2) **(rests on an unproved one)** |  |

**Totals.** 33 units, **23 accepted (70 %)**, 10 stopped with `GAP`. The 4.35 lane-hours spent on all 33 units (failures included) produced 6,182 accepted Lean lines: **≈ 1,420 accepted lines per lane-hour**. Lane A: 12 of 19 accepted, 1,315 lines per lane-hour; lane B: 11 of 14, 1,546. By kind: examples 2/2, lemmas 7/11, propositions 10/15, corollaries 3/3, remark 1/1, theorem (Tate) 0/1. Every accepted proof was re-checked from scratch on the anchor, as a verifier would: 23/23 passed, each depending only on `propext`, `Classical.choice` and `Quot.sound`.

What the numbers say:

- **Everything that was in reach was proved, mostly on the first attempt.**
  No unit failed by running out of attempts; the four units that needed a
  second attempt had hit the 15-minute per-call limit on the first. Accepted units
  took a median of 9.9 lane-minutes and added a median of 222
  Lean lines (mean 269), helper lemmas included.
- **Everything else stopped within ~2 minutes with a precise reason**, never
  by grinding to the cap: 2 units were flagged for the author's review, 1 needed a statement the
  skeleton did not contain (B.1.1.3 needs the finite functional equation
  (3.2.1.8) and the bound (3.2.1.10) as theorems, but the paper states them
  inside Definition 3.2.1.4, so the skeleton only had them as `Prop`
  definitions), and 7 need foundations nobody has written: completeness and
  nuclearity of Schwartz space and its dual (2.1.1.6), structure of
  S(A_F) and S(A_{F,S}) (2.1.3.2(1), 2.1.4.1(2)), Hecke's theorem and Tate's
  thesis (3.2.1.3, 3.2.2.1, 3.2.2.3).
- **Acceptance can be conditional.** A proof may use other units' locked
  statements. The re-check (below) records which ones each accepted proof
  actually uses: 10 of the 23 use at least one sibling statement. Following those edges, 19 are unconditional and 4 rest on a statement that is not proved: 2.1.3.2(2) and 2.1.4.2(1) on 2.1.3.2(1), 2.1.4.2(2) on 2.1.4.1(2), and B.1.1.4 on a flagged statement. This is the design of PLAN.md §3, but the pilot shows the failure mode: a proof can be accepted on top of a statement that is later flagged. The gap ledger has to track these edges and re-open every
  dependent proof when a statement is repaired.
- **The definition decides how hard a theorem is.** S(A_F) was defined
  (running-text unit) by the paper's own Lemma 2.1.3.2(2)–(3); the matching
  part 2.1.3.2(2) then took 4 minutes. Reviewers must check that definitions
  do not quietly absorb the theorems.
- **Lanes used Lean a lot.** Accepted units ran Lean themselves 7.1 times on
  average before handing back; units that ended in `GAP` ran it 0 times. A
  text-only lane (SAFETY.md) gets one Lean verdict per call, so with the
  8-attempt cap it would be right at the limit for a typical unit.

## 7. Cost of Lean checks and lane calls

Measured on the anchor (24-core / 64 GB M2 Ultra, shared, load ≈ 12), every
check with `import Mathlib`:

| check | count | wall median | wall p90 | wall max | peak RSS median | peak RSS max |
|---|---|---|---|---|---|---|
| lane checks (inside a lane session) | 251 | 13.0 s | 17.0 s | 53.5 s | 5.43 GiB | 5.61 GiB |
| driver acceptance checks | 102 | 13.4 s | 17.5 s | 40.5 s | 5.41 GiB | 6.03 GiB |
| verifier re-checks of accepted proofs | 23 | 15.8 s | 18.8 s | 20.9 s | 5.82 GiB | 6.04 GiB |
| module builds (accepted skeleton files) | 47 | 19.1 s | 20.7 s | 27.5 s | 5.40 GiB | 5.42 GiB |

- The floor is loading Mathlib: a file with only `import Mathlib` takes 11–42 s
  (cold to warm page cache) and 5.5 GiB. Checks did not get much slower as the
  files grew: the largest accepted proof (630 lines) re-checked in 17.8 s.
- 3 concurrent checks never pushed free memory under 25 % on the anchor (no
  waits recorded). A 16 GB thinker Mac can run one check at a time beside its
  lane; a 32 GB verifier about four.
- Lane calls (Claude Code, `claude-opus-5-5`): about 105 calls over the pilot, about 6 lane-hours, none refused and no usage limit reached. Claude Code reports an API-equivalent usage figure per call: $16.4 for the skeleton, $8.1 for the round trips, $54.1 for the proofs; **$2.35 and about 43k output tokens per accepted proof**. Proof calls took 4.2 minutes at the median; 4 calls hit the 15-minute per-call limit.
- Codex (`gpt-5.6-terra`, `xhigh`): 3 working calls of 2.8–4.4 minutes and
  79k–98k tokens each (the third was cut off by the limit before it wrote its
  file), then the usage limit (§1).

## 8. What blocked

**The end point.** Observations on the draft's structure, and what the formalization's final target should be, are shared with the author first.

**Missing Mathlib foundations** (see §2): every §2.1 statement about
topology (nuclear, Montel, reflexive, LF, inductive tensor products) had to be
stated over definitions the lanes wrote on the spot. They compiled and read
faithfully, but none of them comes with any API, so the proofs of these items
start from nothing. Measures on adeles/ideles and the Haar measure on
C_F^1 are missing, which is why 3.2.1.3 had to replace the volume μ̄₁(C_F^1)
by an unspecified positive constant, and why 3.2.2.1/3.2.2.3/3.2.2.5 take an
arbitrary Haar measure and assume (true) `T2Space`, `LocallyCompactSpace` and
`SecondCountableTopology` instances on the idele class group as hypotheses.

**Skeleton hygiene.** Lanes chose different conventions for "Hausdorff locally
convex space" (type-class assumptions in some files, a bundled `Prop` in
others), and the topological-vector-space instances of S(X) ended up inside a
statement file (2.1.2.4) that other statement files import. Importing all 33
skeleton modules plus the 10 round-trip modules together worked (no name or
instance clashes, 14 s), but at scale a short prelude, written and locked
first, should fix these conventions and own the shared instances.

**Notes on the draft.** Typos and statement issues found while extracting and stating are shared privately with the author first, per docs/PLAN.md §7.

## 9. Corrected sizing for Track M

### Measured inputs

| Quantity | PLAN.md assumed | Measured here | Basis |
|---|---|---|---|
| Numbered items | 183 definitions, 755 results | 185 defining items, 589 results, 253 remarks, 56 examples | §2 |
| Lean to *state* a definition | — | 37 lines (14 units); ≈ 8,700 lines for all 185 (audit estimate) | §2, §4 |
| Lean to state a result | — | 40 lines | §4 |
| Lane time per statement | — | 1.9 min (write + compile, first try) | §4 |
| Statements flagged for the author's review | — | 2 of 19 | §4 |
| Proof units per stated result | — | 1.7 (33 from 19) | §6 |
| Units accepted within 30 min / 8 attempts | — | 23 / 33 (70 %); 19 unconditional | §6 |
| Lean lines per accepted unit | — | median 222, mean 269 | §6 |
| **Accepted lines per lane-hour** | 1,000 / 300 / 100 | **≈ 1,420** (all proof lane time, failures included) | §6 |
| Lean check | 30 s | 13 s median, 17 s p90 | §7 |
| Verifier re-check per proof | 30 s | 16 s median, 19 s max | §7 |
| Lane usage per accepted proof | — | ≈ $2.35 API-equivalent, ≈ 43k output tokens | §7 |

### What the pilot does not measure

The units that were blocked (30 % of this slice: Tate's thesis, Hecke's
theorem, nuclearity, the structure of S(A_F)) are the deepest parts, and their
size is set by foundations that do not exist yet. The pilot therefore pins down
the *rate* (lines per lane-hour, cost per unit, check cost) but not the *total*
amount of Lean. The table below keeps the total as an explicit assumption.

### 1,000 Macs, 18 proving hours

| Assumption | Low | Mid | High |
|---|---|---|---|
| Proof units from the paper's own items (1.7 × ~750 results, examples and claim-bearing remarks) | 1,100 | 1,300 | 1,500 |
| Foundation units (App. C–E, adelic measures and Fourier analysis, Tate's thesis, Hecke L-functions) — **not measured** | 1,000 | 3,000 | 10,000 |
| Lines per accepted unit | 150 | 250 | 400 |
| Total Lean | ≈ 0.3M | ≈ 1.1M | ≈ 4.6M |
| Lane-hours at ≈ 1,420 lines per lane-hour, × 2 for splitting and repair | ≈ 450 | ≈ 1,500 | ≈ 6,500 |
| Lanes needed for 18 hours | ≈ 25 | ≈ 85 | ≈ 360 |
| Statements to write and review (one per unit) | ≈ 2,100 | ≈ 4,300 | ≈ 11,500 |
| Reviewer-hours at 3 min per statement | ≈ 105 | ≈ 215 | ≈ 575 |
| Verifier core-hours (2 checks × 16 s per unit) | ≈ 20 | ≈ 40 | ≈ 100 |

Assumptions: agentic lanes with a local Lean tool, like the pilot's; the
skeleton (including foundation statements) is written and reviewed *before*
proving; the measured rate holds for foundation units (unknown — they may be
harder, or easier, like most §2.1 units here).

### What changes in the plan

1. **Compute is not the constraint.** Even the high case needs ~360 lanes;
   1,000 Macs is about 3–40× more lane time than the proofs need. PLAN.md's 110 / 750
   / 3,300 lanes came from a rate of 100–1,000 accepted lines per lane-hour; the
   measured rate is ≈ 1,420.
2. **Statement supply is the constraint.** Lanes finished or rejected every
   unit they were given within minutes; 30 % stopped because the statements
   they needed did not exist. The run is bounded by how fast locked statements
   — mostly foundation lemmas, which the paper never states — can be written
   and *reviewed*. Writing is cheap (1.9 lane-minutes each); review is not, and
   round trips do not replace it (§5). Plan for the review hours above, and let
   lanes propose new locked sub-statements ("splits only add below") with
   review in the loop.
3. **Verifiers: 5–10 Macs, not 30–50.** At 16 s and 6 GB per check, two
   verifiers per proof is ~20–100 core-hours for the whole run.
4. **Vendors.** A low-allowance Codex account delivers ~3 lane calls a month.
   Two-vendor round trips need volunteers with paid Codex plans; until then the
   round trip falls back to two independent Claude sessions (weaker).
5. **The end point.** Without Chapter 13, the run can at best formalize the
   paper up to the trace formula (Theorem 12.5.1.1). The author's statement of
   the main theorems is needed before "% of the paper proved" is a statement
   about GRH.
