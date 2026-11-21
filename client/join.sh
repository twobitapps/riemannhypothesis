#!/usr/bin/env bash
# Join this machine to the Riemann swarm (macOS or Linux, no sudo).
#
#   ./client/join.sh --handle ada --place Lisbon --roles thinker,verifier --cap 50 --proofs masullo
#
# --handle  public display name (<=24 chars; default: generated adjective-noun)
# --place   coarse place, city or country (optional)
# --roles   comma list of thinker,verifier,anchor,canary,finisher,prover,atlas
#           (default: the coordinator suggests one from your hardware)
# --cap     daily cap for model use on this machine (kept locally)
# --proofs  which claimed proof to help verify: alpoge, masullo or both (default)
# --github  optional GitHub username, shown publicly as credit for accepted work
# --when    idle (default: lanes run only when the machine is idle) or always
# --focus   optional module prefix or area this node prefers on the board
# --share   % of your weekly plan the swarm may use (default 20)
# --reserve never run lanes while your week is >= 100-N % (default 30, i.e. 70%)
#
# What it does: checks Node 20+, finds or fetches the client, creates
# ~/.riemann/identity.json (Ed25519, 0600), probes hardware, and sends one
# signed hello. It sends no tokens, emails or logins. Leave the swarm any time:
#   node rh.mjs bye
set -euo pipefail

# When the coordinator serves this script it fills in its own origin here.
# Run from a checkout, rh.mjs uses its built-in default unless RH_COORDINATOR is set.
SERVED_FROM='__RH_COORDINATOR__'
case "$SERVED_FROM" in __RH_*) SERVED_FROM='' ;; esac
if [ -z "${RH_COORDINATOR:-}" ] && [ -n "$SERVED_FROM" ]; then export RH_COORDINATOR="$SERVED_FROM"; fi
REPO_URL="${RH_REPO_URL:-https://github.com/twobitapps/riemannhypothesis.git}"
RH_DIR="${RH_HOME:-$HOME/.riemann}"
REPO_DIR="${RH_REPO_DIR:-$RH_DIR/repo}"

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --handle|--place|--roles|--cap|--proofs|--github|--when|--focus|--share|--reserve|--model-cards|--model-research)
      [ $# -ge 2 ] || { echo "join.sh: $1 needs a value" >&2; exit 2; }
      ARGS+=("$1" "$2"); shift 2 ;;
    --handle=*|--place=*|--roles=*|--cap=*|--proofs=*|--github=*|--when=*|--focus=*|--share=*|--reserve=*|--model-cards=*|--model-research=*) ARGS+=("$1"); shift ;;
    -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null || echo "see the header of join.sh"; exit 0 ;;
    *) echo "join.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo "join.sh: macOS or Linux only" >&2; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "join.sh: Node.js 20+ is required (https://nodejs.org, or: brew install node)" >&2; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "join.sh: Node $(node -v) is too old; need 20+" >&2; exit 1
fi

mkdir -p "$RH_DIR"
chmod 700 "$RH_DIR" 2>/dev/null || true

# Find the client: next to this script, or an existing checkout. Never updates
# or downloads code on its own (docs/SAFETY.md §1).
RH=""
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$SELF" ] && [ -f "$(dirname "$SELF")/rh.mjs" ]; then
  RH="$(cd "$(dirname "$SELF")" && pwd)/rh.mjs"
elif [ -f "$REPO_DIR/client/rh.mjs" ]; then
  RH="$REPO_DIR/client/rh.mjs"
else
  echo "join.sh: clone the repo first, read client/rh.mjs, then run client/join.sh from it:" >&2
  echo "  git clone $REPO_URL && cd riemannhypothesis && ./client/join.sh" >&2
  exit 1
fi

node "$RH" join ${ARGS[@]+"${ARGS[@]}"}

echo
echo "Joined. Keep it heartbeating with:"
echo "  node \"$RH\" run"
echo "Leave any time with:"
echo "  node \"$RH\" bye"
