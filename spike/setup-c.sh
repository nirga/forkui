#!/usr/bin/env bash
# Builds origin.git-like repo at ./repo with:
#   base/v1 tag, tenants/a, tenants/b branches (forked from base/v1), base/v2 tag on main.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
F="$ROOT/fixtures"
R="$ROOT/repo-c"
rm -rf "$R" && mkdir -p "$R" && cd "$R"
git init -q -b main
git config user.email vendor@acme.test && git config user.name "Acme Vendor"
sync_tree() { rsync -a --delete --exclude .git --exclude node_modules "$1/" "$R/"; }
overlay() { rsync -a --exclude MESSAGE "$1/" "$R/"; git add -A; git -c user.name="$2" -c user.email=tenant@x.test commit -q -F "$1/MESSAGE"; }

sync_tree "$F/v1"; git add -A; git commit -q -m "Acme CRM v1"; git tag base/v1

git checkout -q -b tenants/c base/v1
overlay "$F/tenantC/c1" "Tenant C admin"

git checkout -q main
sync_tree "$F/v2-noowner"; git add -A; git commit -q -m "Acme CRM v2: DealTable component, status field, v2 API, StatCard, search"; git tag base/v2
git log --oneline --all --graph
