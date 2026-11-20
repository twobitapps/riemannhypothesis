# Protocol v1 — coordinator ⇄ client ⇄ site

One contract for every piece. JSON over HTTPS. All times are ms since epoch.

## Identity and signatures

- Each machine has an Ed25519 keypair. `node_id` = first 16 hex chars of
  sha256(raw 32-byte public key).
- Key file: `~/.riemann/identity.json` `{ "publicKey": <b64 raw 32B>, "privateKey": <b64 PKCS8 DER> }`, mode 0600.
- Signed request body: `{ ...fields, node_id, pubkey (b64, hello only), ts, nonce }`
  plus header `x-rh-sig: <b64 Ed25519 signature over the exact request body bytes>`.
- Coordinator rejects: bad signature, `|now − ts| > 5 min`, reused nonce
  (per node, 10 min window), unknown `node_id` (except hello).

## Endpoints (coordinator)

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/hello` | `{ pubkey, handle?, place?, machine, lanes, roles, client }` → `{ node_id, suggested_roles, beat_ms }` |
| POST | `/api/beat` | `{ node_id, status, activity?, load? }` → `{ ok, directives? }` |
| POST | `/api/lease` | `{ node_id, role }` → `{ unit? , lease_id?, expires_at? }` |
| POST | `/api/result` | `{ node_id, lease_id, unit_id, verdict, artifact_sha256?, summary?, vendor?, model? }` → `{ ok }` |
| POST | `/api/bye` | `{ node_id }` → `{ ok }` |
| GET | `/api/state` | public snapshot (below) |
| GET | `/api/events` | SSE: `event: snapshot` on connect, then `node`, `beat`, `lease`, `result`, `bye` deltas; honours `Last-Event-ID` |
| POST | `/api/admin/units` | bearer `RH_ADMIN_TOKEN`; `{ units: [Unit] }` |
| GET | `/join.sh`, `/agent.md`, `/llms.txt` | onboarding (text) |
| POST | `/api/signup` | public, unsigned, rate-limited (5/h/IP, Turnstile later); `Signup` → `{ ok, position }` |
| GET | `/api/signups/count` | `{ total, macs, big_machines, claude, codex, cores, ram_gb }` (public aggregate only) |
| GET | `/api/admin/signups` | bearer `RH_ADMIN_TOKEN`; full rows as JSON or `?format=csv` |

### Transport

Public API base: **`https://riemannhypothesis.vercel.app/api/rh`** (clients:
`RH_COORDINATOR`, default this). Route `/api/<x>` above is `<base>/<x>`, and the
onboarding texts are `<base>/join.sh`, `<base>/agent.md`, `<base>/llms.txt`.
The base is a byte-for-byte proxy (`site/app/api/rh`) in front of the
coordinator Worker: request bodies and `x-rh-sig` pass unchanged (signatures
cover the exact bytes) and SSE streams through. The proxy adds
`x-rh-proxy-key` (a shared secret, `RH_PROXY_KEY`, set on both sides) and
`x-rh-client-ip`; the Worker trusts `x-rh-client-ip` for rate limits only when
the key matches, and with `REQUIRE_PROXY=1` refuses non-admin API calls that
lack it. `/api/admin/*` is never proxied: admin calls go to the Worker directly.

### Signup (pre-launch interest list; stored in the Durable Object's SQLite)
Only what the run needs:
`{ email, machine: { kind: "mac"|"big", ram_gb, cores? }, claude: "none"|"pro"|"max5"|"max20"|"team",
   codex: "none"|"plus"|"pro"|"team", expert?: "lean"|"number-theory",
   proofs: ["alpoge"|"masullo"] }`  — which proof(s) they want to help verify; default both
`expert` is one optional toggle. Nothing else: no name, place, time zone, hours or notes.
Counts endpoint returns `{ total, macs, big_machines, claude, codex, cores, ram_gb }`.
Emails are never in `/api/state`, `/api/events` or any public response.

### `machine`
`{ chip, cores, perf_cores?, ram_gb, disk_free_gb, os, os_version, arch, gpu? }`

### `lanes`
`{ claude: bool, codex: bool, local_models: [string] }` — presence of a
logged-in CLI only. Never tokens, never emails.

### `roles`
subset of `thinker | verifier | anchor | canary | finisher | prover | atlas`.

### `proofs` (hello, signup, node in snapshot)
Which claimed proof the volunteer wants to work on: `["alpoge"]`, `["masullo"]`
or both (default). Track mapping: `alpoge` → Tracks A (map) and R (rebuild
receipts); `masullo` → Track M. `/api/lease` only hands a node units from its
chosen proofs. Counts endpoint adds `by_proof: { alpoge, masullo }` (a person
choosing both counts in each). `/api/state` totals add `by_proof` for online
nodes.

### `handle` / `place`
Opt-in public display name (≤24 chars) and coarse place (city or country).
Defaults: generated handle (`adjective-noun`), no place.

### `status`
`idle | preparing | thinking | checking | verifying | building | seeding | paused`

### `activity`
`{ track: "M"|"A"|"R", unit_id?, lane?: "claude"|"codex"|"local", phase?, since }`

### Unit
`{ id, track, kind: "statement"|"proof"|"roundtrip"|"card"|"verify"|"build"|"rebuild",
   ref (e.g. "M:7.3.2.1" or Lean decl name), page?, deps: [id], needs: {role, vendor_not?, ram_gb?}, attempts, state: "open"|"leased"|"done"|"failed"|"gap" }`

## Public snapshot (`/api/state`)

```
{
  "at": 0,
  "totals": { "nodes_online": 0, "nodes_ever": 0, "cores": 0, "ram_gb": 0,
              "lanes": { "claude": 0, "codex": 0, "local": 0 },
              "by_role": { "thinker": 0, ... }, "by_status": { "thinking": 0, ... } },
  "nodes": [ { "node_id", "handle", "place", "roles", "status", "activity",
               "machine": { "chip", "cores", "ram_gb" }, "lanes", "joined_at", "last_beat" } ],
  "tracks": { "M": { "units": 0, "done": 0, "gap": 0, "leased": 0 }, "A": {...}, "R": {...} },
  "events": [ last 200 deltas ]
}
```

Online = beat within 3 × `beat_ms` (default 20 s). The snapshot never contains
public keys' private halves, emails, IPs, tokens or exact locations.

## v1 implementation notes (additive; nothing above changed)

Deployed as a Cloudflare Worker (`coordinator/`), reached through the public base above.

- `/api/hello` also returns `handle` (the stored or generated one) and `roles`
  (as stored; when none are offered, the first suggested role).
- `/api/state` also carries `seq` (latest event id, usable as `Last-Event-ID`),
  `beat_ms`, and per node `online: bool`. `nodes` lists nodes seen in the last
  7 days (max 2000); totals count online nodes only, `nodes_ever` counts all.
- Event records (in `events[]` and as SSE `data`) are
  `{ id, type, at, ...payload }`; SSE `id:` = `id`. Payloads:
  `node {node_id, node}` · `beat {node_id, status, activity}` ·
  `lease {node_id, unit_id, track, role}` · `result {node_id, unit_id, track, verdict}` ·
  `bye {node_id}`. The `snapshot` event's data is the `/api/state` object.
  Replay: `Last-Event-ID` (or `?last_event_id=`) within the last 1000 events
  replays deltas; older or unknown ids get a fresh snapshot. `: ping` comment
  every 15 s.
- `verdict` ∈ `ok | fail | gap | skip`. `ok` → unit done, `gap` → gap ledger,
  `fail` → attempts+1 (failed after 6), `skip` → back to open, no attempt
  counted (phase-1 clients use it to hand units back). Leases expire after 30 min.
- `/api/lease` may also take `vendor` (checked against `needs.vendor_not`); the
  role must be one the node offered at hello.
- `/api/signup` also returns `updated: bool` (true when the lowercased email was
  already on the list; the row is replaced, position kept). Rate limit is per
  hashed IP; raw IPs are never stored. Errors: `{ error }` with 400/413/429.
- `/api/signup` requires `email`, `machine.kind`, `machine.ram_gb`, `claude`,
  `codex`; `cores` and `expert` optional. Any other field is ignored and not
  stored. Error codes: `bad_email`, `bad_machine_kind`, `bad_ram_gb`,
  `bad_cores`, `bad_claude`, `bad_codex`, `bad_expert`, `rate_limited`.
- `/api/signups/count`: `macs` / `big_machines` = signups with `machine.kind`
  `mac` / `big`; `claude`/`codex` = signups with a plan other than `none`;
  `cores`/`ram_gb` = sums over signups.
- Admin CSV columns: `id,email,machine_kind,ram_gb,cores,claude,codex,expert,created_at,updated_at`.
- `proofs`: invalid values → 400 `bad_proofs`; missing or `[]` → both.
  `/api/hello` echoes the stored `proofs`. Rows stored before `proofs` existed
  count as both. Admin CSV gains a `proofs` column (`;`-joined) before `created_at`.
- `DELETE /api/admin/signups?email=` (bearer `RH_ADMIN_TOKEN`) → `{ ok, deleted }`.
- `/api/admin/units` → `{ ok, upserted, rejected: [id] }`.

## 3-D view

A spatial view subscribes to `/api/events` and renders the same snapshot:
machines as bodies sized by cores/RAM and coloured by role, lanes as orbiting
agents, leases as threads to the unit they work on, units as the proof graph
(Track M: chapter → item; Track A: module DAG, depth 43).
