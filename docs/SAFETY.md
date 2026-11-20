# Contributor safety

What joining may and may not do to a contributor's machine and accounts.
Every rule here is a requirement for the client; a change that breaks one is a
bug, not a trade-off.

## 1. Code that runs on your machine

- **Only code you can read.** The client is `client/rh.mjs` (one file, no npm
  dependencies) plus `client/join.sh`. Nothing is downloaded and executed later.
- **No silent updates.** The client never pulls or replaces itself. Updating is
  `git pull` by you, on a tagged release you chose.
- **The coordinator sends data, never commands.** Work units are JSON validated
  against a fixed schema and size limit. Fields such as `directives` are
  ignored. No unit can name a program, a shell command, a path outside
  `~/.riemann`, or a URL to fetch.
- **No root, no sudo, no launch agents, no login items.** It runs only while you
  run it. `node rh.mjs leave --purge` removes everything it created.
- **One directory.** All files live in `~/.riemann` (identity, state, caches,
  work dirs). Nothing else on disk is read or written.

## 2. Lean builds (verifier, anchor and all Lean checks)

Lean code can run programs while it compiles (`#eval`, `run_cmd`,
`initialize`, custom elaborators, `extern`). Proofs come from other people.

- Every submission passes `client/lint-proof.mjs` first. It rejects
  `run_cmd`, `#eval`, `initialize`, `elab`, `macro`, `syntax`, `unsafe`,
  `implemented_by`, `extern`, `native_decide`, `axiom`, `opaque` and any
  `set_option` except `maxHeartbeats`.
- Then Lean runs in a sandbox with no network, writes only inside its work
  directory, reads only the toolchain, Mathlib cache and that directory.
  macOS uses `sandbox-exec` with a deny-by-default profile; Linux uses
  `bwrap`. If the sandbox cannot start, the check does not run.
- Limits: `nice 10`, at most N concurrent Lean processes (default: half the
  performance cores), a wall-clock timeout per check, and a hard memory budget
  (the client pauses when free memory falls below 25%).

## 3. Your Claude and Codex subscriptions

- **Subscription only, never surprise bills.** Lanes start with
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and similar
  removed from their environment, so usage bills only to the subscription you
  are already logged into, never to an API account.
- **Your private context never enters swarm work.** Lanes run in an empty
  temporary directory with your personal setup switched off:
  - Claude Code: `claude -p --tools "" --strict-mcp-config --setting-sources ""
    --no-session-persistence`, in an empty directory. Verified: no tools, no
    MCP servers, no CLAUDE.md, no memory, no saved session. (`--bare` is not
    usable: it also drops the subscription login.) Claude Code still shows the
    model the account email, so every output is screened (below).
  - Codex: `codex exec --ephemeral --ignore-user-config --skip-git-repo-check
    -s read-only -C <empty dir>`. `--ignore-user-config` skips `config.toml`
    but a global `~/.codex/AGENTS.md` may still load. **Codex lanes stay off
    until a test proves personal instructions are excluded.**
  - Lanes produce text only (Lean source or LaTeX). They cannot run commands,
    browse, or touch files; Lean checking is done by the client, separately.
- **Your login is never read.** The client checks that `claude --version` and
  `codex --version` run; it never opens `~/.claude`, `~/.codex`, the keychain,
  or any credential file.
- **Your limits are respected.** A local daily cap (`--cap`, in lane-minutes)
  and one lane per vendor by default. On any rate-limit or usage-limit message
  (e.g. Codex: "You've hit your usage limit … try again at <time>") the lane
  stops until that time; it never retries in a loop.
- **Results are checked before they leave.** Output must parse as the expected
  Lean or LaTeX, fit the size limit, and contain no email address, URL, file
  path, username or hostname. Anything else is discarded, not submitted.

## 4. Privacy

- Sent: a public key, chip, core count, RAM, free disk, OS version, which CLIs
  are present, your chosen roles and proofs, and an optional handle and place.
- Public on the wall: handle, place (if given), chip, cores, RAM, role, status.
- Never sent: emails, IP-derived location, file names, usernames, hostnames,
  tokens, logins, or anything a lane saw beyond its work unit.

## 5. Your machine stays yours

- Work only on AC power (laptops) and pauses when the battery is below 50%,
  when the machine is in use by default (`--when idle`), or when free memory or
  disk is low (keeps 20 GB free).
- `rh pause`, `rh resume`, `rh status` show and control exactly what runs.
- A local log (`~/.riemann/log/`) records every lane call and Lean check:
  time, unit, duration, result.
