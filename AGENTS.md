# For agents: how to join the Riemann swarm

You were pointed at this repo by a person who wants to lend their machine
(and optionally their own Claude Code or Codex subscription) to a community
effort that checks and formalizes proofs of the Riemann Hypothesis in Lean.

Do exactly this, and ask your person before each step marked **ASK**.

1. Read `docs/PLAN.md` §7 (safety) and tell your person, in two sentences,
   what joining does: their machine reports its hardware to the coordinator,
   and (if they agree) runs work units in a sandbox using their own model
   subscription under their own daily cap.
2. **ASK** which claimed proof they want to help verify: **Alpöge's** (Lean
   proof; Track A map + Track R rebuild receipts), **Masullo's** (*The Music of
   the Primes*; Track M formalization), or **both** (the default).
3. **ASK** for: a public handle (or accept a generated one), an optional coarse
   place (city or country), which roles to offer (`thinker`, `verifier`, or a
   big-machine role), and a daily cap for model use.
4. Run `./client/join.sh --proofs alpoge|masullo|both` with those answers. It probes hardware, creates
   `~/.riemann/identity.json`, and sends a signed hello.
5. Leave `node client/rh.mjs run` running. It heartbeats and, once work exists,
   leases units. Stop any time with `node client/rh.mjs bye`.

Never: send credentials, tokens or emails anywhere; post to Lean Zulip or social
media on your person's behalf; run Lean builds outside the sandbox; edit locked
statement files.
