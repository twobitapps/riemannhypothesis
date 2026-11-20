# Riemann swarm — plan

A community supercomputer for checking and formalizing claimed proofs of the
Riemann Hypothesis. Volunteers point their coding agents at this repo; the agent
joins the swarm, reports what the Mac (or big machine) can do, and then pulls
work. Every result that matters is checked by Lean's kernel on machines owned by
different people, so nobody has to trust any volunteer or any model.

Status: phase 1 (membership, heartbeats, live wall). Work execution comes next.

## 1. Tracks

| Track | What | Output | Trust |
|---|---|---|---|
| **M — Masullo** (primary) | Formalize *The Music of the Primes* (940 pp, GRH for all unitary Hecke characters over all number fields; 183 definitions, 755 numbered results) | Lean skeleton of every statement, proofs filled in parallel, a ranked **gap ledger** for the author | kernel-checked |
| **A — Atlas** | Checked English map of Alpöge's Lean RH proof (175,187 modules, 17.4M lines, archive sha256 `9631b4f0…c7fc`) | Module cards, round-tripped statements, answers to open questions, dead-code list | round-trip + kernel |
| **R — Receipts** | Independent rebuilds of published Lean proofs | Signed attestations of archive / olean-manifest / export hashes and kernel verdicts | quorum of hashes |

Trust labels on every output: `⛓ kernel` · `✓ round-trip` · `≈ two-vendor` · `👤 reviewed`.
Round trip: vendor X writes the English statement of a Lean theorem; vendor Y,
blind to the Lean, writes Lean back from the English; Lean must prove the two
equivalent. Claude and Codex must always be on opposite sides.

## 2. Roles

Every machine picks one or more roles at join time. The coordinator may suggest
a role from the hardware report.

| Role | Hardware | Does | Count for a 24 h Track M run |
|---|---|---|---|
| **thinker** | Apple Silicon, ≥16 GB, ~20 GB free disk, macOS 14+ | One Claude Code or Codex lane on the volunteer's own login and cap. Runs its Lean checks locally in a VM sandbox against the shared skeleton cache | ~1,000 (range 110–3,300, see §5) |
| **verifier** | ≥32 GB, 10+ cores, no lane | Re-checks every accepted proof; each accept needs 2 verifiers with different owners | 30–50 |
| **anchor** *(big)* | 64+ cores or M-Ultra, ≥128 GB, fast uplink, 1 TB | Builds Mathlib + skeleton caches once per skeleton version and seeds them to the swarm (content-addressed pieces); hosts the pinned toolchain | 1 (+1 standby) |
| **canary** *(big)* | M-Ultra / 64+ cores, ≥128 GB | Every 2–3 h: merges all accepted proofs and builds, so cross-file breakage (instances, universes, name clashes, heartbeats) shows up early | 1 |
| **finisher** *(big)* | 96–192 cores, 384–768 GB, 2 TB | Final full build, `lake comparator --paranoid`, independent kernels (nanoda, con-*, lean4lean), export hash | 1–2, only for the last 4–6 h |
| **prover** *(big, GPU/RAM)* | ≥192 GB unified memory or GPUs | Runs open-weight Lean prover models as extra lanes — no subscription needed | any |
| **atlas** *(big)* | ≥512 GB RAM, 2 TB | Track A: holds Alpöge's built environment, serves `lean_check` and the declaration-level dependency trace | 1–2 |
| **coordinator** | Cloudflare Worker + Durable Objects + R2 | Leases, signed results, receipts log, live state + SSE | 1 (cloud) |

### Big machines
- **Big-1:** anchor (pinned Lean v4.36.0 + Mathlib v4.36.0 under
  `~/riemann/anchor`), cache seed, pilot host, verifier in spare cycles. A
  64 GB, 24-core machine is *not* a full-scale canary or finisher: a ~2M-line
  build is ~180 core-hours ≈ 7–8 h there. Canary on it only while the project
  is small.
- **Big-2:** finisher. Only needs to arrive at ~T+18 h.
- **Big-3+:** prover (open-weight models), atlas (Track A), standby anchor.

## 3. Can integrators come only at the end? — Yes, with one canary.

Because every statement is **locked before proving starts**, each proof depends
only on the *statements* of other nodes, never on their proofs. A thinker proves
node X against the skeleton oleans; verifiers re-check X against the same
skeleton. Assembly at the end is mechanical: drop each accepted proof file into
place and build. So the heavy integration machines can arrive for the last
4–6 hours.

Conditions that make this hold:
1. **Statements are immutable** after T+4 h (PROPERTIES gate: statement files
   and the axiom allowlist are hash-locked; a change needs a signed coordinator
   token and bumps the skeleton version).
2. **Splits only add below.** A lane may split a hard node into new sub-lemmas
   in new files that import only locked statements; it never edits a locked one.
3. **One file per proof**, namespaced by node id, so merges never conflict.
4. **Verifiers check against the exact skeleton version** the proof was written
   for; a skeleton bump re-queues affected proofs.
5. **A canary build every 2–3 h** on the canary machine catches the failures that only show up
   when files meet (instance diamonds, universe constraints, `maxHeartbeats`,
   duplicate names). Without it, the end-of-run build is where you find them.

Cost of a late finisher: the final build of ~2M lines is ~180 core-hours
(Alpöge's 17.4M took ~1,500), i.e. ~1 h on 192 cores, plus comparator and
kernels (hours, single-threaded export).

## 4. Network

- A machine joins with its own Ed25519 identity (generated in
  `~/.riemann/identity.json`). Every message to the coordinator is signed.
- Later: piece swarm for the Mathlib/skeleton caches (content-addressed, like
  the model-weight swarm) so the anchor doesn't serve 1,000 downloads alone.
- Receipts: each accepted result is a signed statement appended to a
  transparency log (RFC 6962 style, CAW format) that anyone can audit.

## 5. Sizing (Track M, estimates — state the assumptions)

| Assumption | Low | Mid | High |
|---|---|---|---|
| AI-style Lean lines per page | 1,000 | 2,000 | 3,000 |
| Total Lean | ~1M | ~2M | ~3M |
| Accepted lines per lane-hour | 1,000 | 300 | 100 |
| Lane-hours (×2 for failures) | ~2k | ~13k | ~60k |
| Lanes over 18 proving hours | ~110 | ~750 | ~3,300 |

Plan for ~1,000 thinker lanes. Verifier load ≈ 100k proofs × 2 × 30 s ≈ 1,700
core-hours (~70 busy cores all day) → 30–50 verifier Macs.

## 6. The 24-hour run

- **T−72…0 (prep):** consent; infra; blueprint extraction from the PDF by lanes,
  curated by grad students; dry run on Appendices A/B with ~20 lanes; anchor
  builds and seeds Mathlib cache.
- **T0–4 (skeleton):** every definition and statement in Lean with `sorry`;
  round-trip each; anchor checks (Hecke L over ℚ = Mathlib
  `DirichletCharacter.LFunction`, Dedekind ζ of ℚ = `riemannZeta`); experts
  approve headline definitions; lock. Big gap: Appendices C–E foundations
  (nuclear spaces, Pettis integration, stacks on CGWH spaces) are mostly not in
  Mathlib and must be stated here too.
- **T4–20 (prove):** every `sorry` is a unit; any lane takes any unit; verifiers
  re-check; canary every 2–3 h; live map counts `sorry`s down per PDF page.
  A unit failing N times across both vendors → **gap ledger** with the stuck goal
  → Masullo/Conrad triage (real gap vs. hard to formalize).
- **T18–24 (finish):** finisher(s) arrive; freeze at T20; full build,
  comparator `--paranoid`, independent kernels; publish % proved per chapter,
  remaining `sorry`s mapped to PDF pages, ranked gap ledger.

## 7. Safety and etiquette (non-negotiable)

- Each lane runs on the volunteer's own machine, own login, own cap.
  Credentials never leave the machine; nothing is pooled or resold.
- All Lean builds run in a VM/container sandbox (AI-generated Lean can run code
  at compile time). Lanes are text-only toward the coordinator; source text is
  untrusted input.
- No bot posts on Lean Zulip or anywhere else. Humans share links.
- **Authors in the loop, not gatekeepers:** Vakil publicly invited people to
  check and formalize the draft, so no permission is needed. We give Masullo and
  Conrad a heads-up, ask for the LaTeX source, and send gap findings to them
  privately before anything is published. Track A is offered to existing
  community efforts (study groups, the Deicyde repo), not run as a rival.

## 8. Build order

1. `coordinator/` — Worker + Durable Object: hello, beat, lease, result, state,
   SSE, admin unit loading.
2. `client/` — `join.sh` + `rh.mjs`: identity, hardware probe, lane detection,
   signed hello/heartbeat, work loop (lanes → phase 2, Lean runner → phase 3).
3. `site/` — riemannhypothesis.vercel.app: the live wall of who is connecting and
   how. Gated by a key until launch.
4. `lean/` — Track M project (pinned toolchain, skeleton, PROPERTIES lock).
5. `blueprint/` — extracted outline of the PDF (items + dependencies).
6. 3-D view: the same state feed rendered as a spatial swarm and proof graph.

## 9. Gaps (Nov 20 review) — in order of how much they block

1. **People, not machines, are the critical path.** Track M needs a heads-up to
   Masullo and Conrad (not permission: Vakil invited formalization), the **LaTeX source** (pdftotext of a 940-page draft with 14
   unresolved `??` refs is lossy), a named human **formalization lead**, and 5–10
   Lean experts to approve definitions.
2. **The skeleton is days, not 4 hours.** 183 definitions, many of them
   foundations Mathlib lacks (nuclear spaces, Pettis integration, stacks on CGWH
   spaces, Schwartz–Bruhat on LCA groups). Revised shape: a multi-day
   *skeleton phase* with experts → the 24 h *proof sprint* on a locked skeleton.
3. **Sizing is guesswork until the pilot lands** (`docs/PILOT.md`, measured
   lines per lane-hour, round-trip rate, check time and RSS).
4. **Hostile submissions.** Verifiers compile other volunteers' Lean. Lint
   (no run_cmd/#eval/elab/macro/unsafe/extern/native_decide/axiom…) + sandbox on
   every verifier + comparator at the end. Leases need TTL and per-node caps.
5. **Mathlib cache load.** 1,000 Macs × ~5 GB from Mathlib's community-funded
   cache = ~5 TB burst. Mirror to our own R2 / piece swarm, seeded by the anchor.
6. **Coordinator at launch scale.** One Durable Object cannot fan SSE out to a
   viral audience. Edge-cache `/api/state` (1–2 s), and split viewer fan-out
   from the node-ingest DO.
7. **Honest numbers on the wall.** Hardware is self-reported. Show "claimed"
   until a node passes a short Lean benchmark; headline kernel-verified work
   (lemmas, Lean-checks/s), not just machines.
8. **Signup hygiene.** Turnstile, email confirmation, a privacy note, and a
   delete-my-data path before the page is shared publicly.
9. **Lane limits.** Subscription caps (5-hour and weekly windows) mean lanes
   won't run 18 h flat; the pilot must measure sustained throughput per plan.
11. **A consent-free first workload** to prove the swarm before Track M:
    Kevin Buzzard's four checks across the ~290 OpenAI papers that ship Lean,
    plus Track R receipts for the Alpöge archive.
12. **3-D spatial view** of the same feed — not started.
