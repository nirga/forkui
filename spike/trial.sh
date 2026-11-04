#!/usr/bin/env bash
# Usage: trial.sh <tenant a|b> <strategy rebase|replay> <model> <trialId>
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
T="$1"; S="$2"; M="$3"; ID="$4"
NAME="$T-$S-$M-$ID"; W="$ROOT/runs/$NAME"; OUT="$ROOT/results/$NAME"
rm -rf "$W" "$OUT"; mkdir -p "$OUT"
git clone -q "$ROOT/repo" "$W"; cd "$W"
for b in tenants/a tenants/b; do git branch -q "$b" "origin/$b"; done
git config user.email "forkui-agent@forkui.test"; git config user.name "forkui rebase agent"
ln -sfn "$ROOT/template/node_modules" node_modules
export GIT_EDITOR=true
TB="tenants/$T"

INTENTS=$(git log --reverse --format='--- commit %h: %s%n%(trailers:key=Forkui-Intent,valueonly)%(trailers:key=Forkui-Test,valueonly)' base/v1..$TB)
BASELOG=$(git log --format='%h %s' base/v1..base/v2; git diff --stat base/v1 base/v2)

COMMON="You are the forkui rebase agent. This repo is the frontend of a B2B SaaS product (Acme CRM, Vite + React + TS).
The vendor owns the base; each customer (tenant) has a git branch of customizations on top of a base release.
Tenant branch: $TB (forked from tag base/v1). The vendor just released tag base/v2.

Your goal: produce tenant commits on top of base/v2 that preserve every tenant INTENT below, while adopting the
vendor's new structure (use the vendor's new components, types, APIs and helpers; do not revert or duplicate vendor changes).

Tenant intents, in order (from commit trailers):
$INTENTS

What the vendor changed (run \`git diff base/v1 base/v2\` for details):
$BASELOG

Definition of done:
- The acceptance tests in forkui-tests/*.spec.tsx encode the tenant intents. They are the definition of done.
- NEVER modify, delete or rename forkui-tests/**, src/__tests__/** or src/test/** (tenant tests and vendor tests/helpers are protected). A harness verifies this byte-for-byte.
- \`npx tsc --noEmit\`, \`npx vitest run\` and \`npx vite build\` must all pass on the final HEAD.
- One commit per tenant intent, in the original order, keeping each original commit message including its Forkui-* trailer lines.
- Final state: HEAD on top of base/v2, clean working tree, no rebase in progress.
- If an intent genuinely cannot be satisfied without changing protected files, do not hack around it: stop and make your final message start with 'PIN:' followed by a short explanation a non-technical customer admin can read.
Keep your final message to a short summary of what you did per intent."

if [ "$S" = rebase ]; then
  git checkout -q -b work "$TB"
  if git rebase base/v2 >"$OUT/naive-rebase.log" 2>&1; then
    "$ROOT/check.sh" "$W" "$TB" base/v2 > "$OUT/naive-check.txt"
    if grep -q RESULT=PASS "$OUT/naive-check.txt"; then echo "OUTCOME=clean" > "$OUT/outcome.txt"; cp "$OUT/naive-check.txt" "$OUT/check.txt"; exit 0; fi
    STATE="git rebase onto base/v2 completed WITHOUT textual conflicts, but the checks fail (see \`$ROOT/check.sh\` output below). Fix the tenant commits (e.g. via an interactive-free approach like \`git reset --soft\`/fixup commits + autosquash, or amending) so each commit is correct.
$(cat "$OUT/naive-check.txt")"
  else
    STATE="A \`git rebase base/v2\` of the tenant branch is IN PROGRESS and has stopped with conflicts. Resolve them, \`git add\` the files and run \`git rebase --continue\` (GIT_EDITOR is already set). Repeat for each commit. Fix semantic breakage (type errors, renamed APIs) inside the commit that introduced the code before continuing, so each commit stands on its own."
  fi
  PROMPT="$COMMON

Current state: $STATE"
else
  git checkout -q -b work base/v2
  ORIG=$(git log --reverse -p --format='=== original commit %h: %s' base/v1..$TB -- . ':!forkui-tests')
  PROMPT="$COMMON

Current state: branch 'work' is checked out at base/v2 with none of the tenant changes. Re-implement each tenant intent on top of base/v2,
one commit per intent. For each commit, restore that commit's acceptance test exactly with \`git checkout $TB -- <test path>\` and include it in the commit.
For reference, here is how each intent was originally implemented against base/v1 (do NOT copy blindly; the base changed):
$ORIG"
fi

echo "$PROMPT" > "$OUT/prompt.txt"
START=$(date +%s)
claude -p "$PROMPT" --model "$M" --output-format json --permission-mode acceptEdits \
  --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash(git:*)" "Bash(npx tsc:*)" "Bash(npx vitest:*)" "Bash(npx vite:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash($ROOT/check.sh:*)" \
  > "$OUT/agent.json" 2> "$OUT/agent.stderr"
END=$(date +%s)
echo "WALL_SECONDS=$((END-START))" > "$OUT/meta.txt"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("COST_USD="+r.total_cost_usd);console.log("TURNS="+r.num_turns);console.log("DENIALS="+JSON.stringify(r.permission_denials||[]));require("fs").writeFileSync(process.argv[2],r.result||"")' "$OUT/agent.json" "$OUT/final-message.txt" >> "$OUT/meta.txt" 2>>"$OUT/meta.txt"
"$ROOT/check.sh" "$W" "$TB" base/v2 > "$OUT/check.txt"
git log --format='%h %an: %s' base/v2..HEAD > "$OUT/commits.txt" 2>&1
git diff base/v2..HEAD > "$OUT/final.diff" 2>&1
if grep -q RESULT=PASS "$OUT/check.txt"; then O=agent_resolved; elif head -c 4 "$OUT/final-message.txt" | grep -q 'PIN:'; then O=pinned; else O=failed; fi
echo "OUTCOME=$O" > "$OUT/outcome.txt"
cat "$OUT/outcome.txt" "$OUT/meta.txt"
