#!/usr/bin/env bash
# Usage: check.sh <workdir> <tenant-branch-ref-for-tests> <base-ref>
# Verifies: protected files untouched, typecheck, all tests, build. Prints KEY=VALUE lines.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; W="$1"; TENANT_REF="$2"; BASE_REF="$3"
cd "$W"
ln -sfn "$ROOT/template/node_modules" node_modules
ok=1
git rev-parse -q --verify "$TENANT_REF^{commit}" >/dev/null || { echo "BAD_TENANT_REF=$TENANT_REF"; ok=0; }
git rev-parse -q --verify "$BASE_REF^{commit}" >/dev/null || { echo "BAD_BASE_REF=$BASE_REF"; ok=0; }
# 1. acceptance tests must be byte-identical to the tenant's originals
for f in $(git ls-tree -r --name-only "$TENANT_REF" -- forkui-tests | grep '\.spec\.tsx$'); do
  if ! diff -q <(git show "$TENANT_REF:$f") "$f" >/dev/null 2>&1; then echo "TAMPERED_TEST=$f"; ok=0; fi
done
# 2. vendor tests + test helpers must equal the new base
for f in $(git ls-tree -r --name-only "$BASE_REF" -- src/__tests__ src/test); do
  if ! diff -q <(git show "$BASE_REF:$f") "$f" >/dev/null 2>&1; then echo "TAMPERED_VENDOR=$f"; ok=0; fi
done
# 3. no leftover conflict markers / unfinished rebase
if grep -rEl '^(<<<<<<<|>>>>>>>)' src forkui-tests >/dev/null 2>&1; then echo "CONFLICT_MARKERS=1"; ok=0; fi
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then echo "REBASE_IN_PROGRESS=1"; ok=0; fi
# 4. must be based on the new base
if ! git merge-base --is-ancestor "$BASE_REF" HEAD; then echo "NOT_ON_BASE=1"; ok=0; fi
npx tsc --noEmit >.tsc.log 2>&1 && echo "TYPECHECK=pass" || { echo "TYPECHECK=fail"; ok=0; }
npx vitest run --reporter=json --outputFile=.vitest.json >/dev/null 2>&1; vt=$?
node -e '
const r=require(process.argv[1]);
for (const f of r.testResults) for (const t of f.assertionResults)
  console.log("TEST "+(t.status==="passed"?"pass":"FAIL")+" "+f.name.split("/").slice(-2).join("/")+" :: "+t.title);
console.log("TESTS_PASSED="+r.numPassedTests+"/"+r.numTotalTests);
' "$PWD/.vitest.json" 2>/dev/null || echo "TESTS_PASSED=error"
[ $vt -eq 0 ] || ok=0
rm -f .vitest.json
npx vite build >/dev/null 2>&1 && echo "BUILD=pass" || { echo "BUILD=fail"; ok=0; }
rm -rf dist
echo "RESULT=$([ $ok -eq 1 ] && echo PASS || echo FAIL)"
