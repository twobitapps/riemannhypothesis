# Riemann swarm

People pool their Macs, big machines and coding-agent subscriptions into one
community supercomputer that checks and formalizes claimed proofs of the
Riemann Hypothesis in Lean. Lean's kernel is the referee: no volunteer and no
model has to be trusted.

This project focuses on two things: a checked English map of Alpöge's Lean
proof, and the Lean formalization of Masullo's paper (*The Music of the Primes*).

Want to help replay Alpöge's modules instead? That work lives in
[rohanarun/alpoge-rh-replay](https://github.com/rohanarun/alpoge-rh-replay);
we credit it and don't duplicate it.

- Plan: [docs/PLAN.md](docs/PLAN.md)
- Protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md)
- Point your agent at: [AGENTS.md](AGENTS.md)
- Safety rules for contributors' machines: [docs/SAFETY.md](docs/SAFETY.md)
- Public API: `https://riemannhypothesis.vercel.app/api/rh`
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md)

| Dir | What |
|---|---|
| `coordinator/` | Cloudflare Worker + Durable Object: membership, leases, results, live state |
| `client/` | `join.sh` + `rh.mjs`: identity, hardware probe, heartbeat, work loop |
| `site/` | riemannhypothesis.vercel.app — the live wall |
| `lean/` | Track M Lean project (skeleton + proofs) |
| `blueprint/` | outline extracted from the paper |

Licensed under the [Apache License 2.0](LICENSE).
