#!/bin/sh
# pre-push-gate.sh — Claude Code PreToolUse hook (matcher: Bash).

#
# Blocks `git push` unless .claude/.verify-ok holds a content hash matching
# the CURRENT working tree — i.e. `yarn verify:push` (yarn build + full
# yarn test --force) passed against exactly this content. Enforces the
# standing pre-push rules deterministically; pushes from a plain terminal
# are unaffected (this only gates the Claude Code Bash tool).
#
# stdin:  hook JSON ({"tool_name":"Bash","tool_input":{"command":...}, ...})
# exit 0: allow the tool call
# exit 2: BLOCK — stderr is fed back to Claude as the reason
#
# Escape hatch (emergencies/hotfixes only): include VERIFY_GATE_BYPASS=1 in
# the push command itself, e.g. `VERIFY_GATE_BYPASS=1 git push origin main`.
# The bypass is visible in the transcript, so it is auditable.

INPUT=$(cat)

# Fast path: nearly every Bash call is not a push — bail before spawning node.
# Deliberately broad (any "push" in the raw JSON): its only job is to cheaply
# skip calls that cannot be pushes; false positives just pay the node parse.
# (The old substring "git push" was bypassable: `git -C dir push`,
# `git -c k=v push`, `git  push`.)
case "$INPUT" in
  *push*) ;;
  *) exit 0 ;;
esac

# The precise path needs node to extract the command from the hook JSON.
# A missing node must fail CLOSED — this input may be a real push.
command -v node >/dev/null 2>&1 || {
  echo "verify-gate: node not found — failing CLOSED for potential push" >&2
  exit 2
}

# Precise path: parse the JSON and confirm the actual command pushes.
CMD=$(printf '%s' "$INPUT" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(d);
      process.stdout.write(String(j?.tool_input?.command ?? ""));
    } catch {
      /* not JSON — treat as no command */
    }
  });
') || exit 0

# Match a real `git push` invocation, not a bare substring. Catches:
#   git push | git push origin x | git -C /a/b push | git -c k=v push |
#   git  push | cd x && git push | VAR=1 git push | /usr/bin/git push
# Options between git and push may carry a separated argument (-C <dir>,
# -c <k=v>, --git-dir <d>). Boundaries keep "mygit push" / "git pushed" /
# "git pushing" out. Known over-match: a command that merely QUOTES a push
# (e.g. `grep 'git push' file`) also matches — deliberate fail-closed
# behavior (with a stale marker it gets blocked, exactly as the old
# substring check would have).
if ! printf '%s' "$CMD" | grep -Eq \
  '(^|[^[:alnum:]_.-])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+push([^[:alnum:]_]|$)'
then
  exit 0 # no `git push` in the actual command (e.g. only in a description)
fi

case "$CMD" in
  *VERIFY_GATE_BYPASS=1*)
    echo "verify-gate: BYPASSED via VERIFY_GATE_BYPASS=1 — remember to run the full suite after." >&2
    exit 0
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib-tree-hash.sh"

MARKER=$(verify_marker_path)

block() {
  echo "verify-gate: git push BLOCKED — $1" >&2
  echo "" >&2
  echo "Standing rule: full 'yarn build' + 'yarn test --force' must pass before every push." >&2
  echo "Run:  yarn verify:push" >&2
  echo "(serialized fallback for parallel task flakes: VERIFY_SERIAL=1 yarn verify:push)" >&2
  echo "On success it writes .claude/.verify-ok for this exact tree content and the push unlocks." >&2
  exit 2
}

[ -f "$MARKER" ] || block "no verification marker found"

marker_hash=$(sed -n 's/^hash=//p' "$MARKER" | head -1)
[ -n "$marker_hash" ] || block "marker is malformed"

current_hash=$(tree_state_hash) || block "could not hash the working tree"

if [ "$marker_hash" != "$current_hash" ]; then
  block "working tree content changed since the last verified run (marker $marker_hash, current $current_hash)"
fi

verified_at=$(sed -n 's/^verified_at=//p' "$MARKER" | head -1)
echo "verify-gate: OK — tree content matches the run verified at ${verified_at:-unknown}." >&2
exit 0
