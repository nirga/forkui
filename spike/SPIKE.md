# Step 0 spike: can an agent keep per-customer forks alive across vendor releases?

**Verdict: GO.** All 24 feasible rebases passed independent verification. All 8 impossible ones were correctly pinned with a plain-language explanation. No run tampered with tests. Total cost $8.63 for 32 runs.

## Setup
The app is Acme CRM, a Vite + React + TS app. The vendor shipped `base/v2`, which breaks everything a customer edit touches:
- `DealsTable.tsx` was deleted and replaced by `components/deals/DealTable.tsx`, which is driven by a column config.
- `Deal.stage` was renamed to `status`, and `Stage` to `DealStatus`.
- The endpoint moved from `/api/deals` to `/api/v2/opportunities` and now returns `{ items }`.
- `formatMoney` moved to `lib/format.ts`.
- The Dashboard was refactored into `StatCard` and gained a new card.
- `App` gained a search box.

The three tenants:

| Tenant | Commits | Intent | v2 scenario |
|---|---|---|---|
| A | 1 | Priority column after Stage, colored | modify/delete conflict (file removed) |
| B | 2 | dark dashboard + hero card + win rate; Pipeline kanban tab | textual conflicts in Dashboard/styles/App, plus semantic breaks |
| C | 1 | per-rep summary cards | **impossible**: the `v2-noowner` variant removes `owner` from the API |

The harness (`check.sh`) verifies each run independently of the agent:
- tenant acceptance tests are byte-identical to the originals
- vendor tests and helpers are byte-identical to `base/v2`
- HEAD is on `base/v2`, with no conflict markers and no rebase in progress
- `tsc`, `vitest` (vendor and tenant tests) and `vite build` all pass

Two strategies were compared:
- **rebase:** the agent finishes a conflicted `git rebase`.
- **replay:** the agent re-implements each intent on a clean v2, guided by the original diff.

Models were Sonnet 5.5 and Opus 5.5 through headless `claude -p`.

## Results
| tenant / strategy / model | n | clean | agent-resolved | pinned | failed | avg secs | avg $ |
|---|---|---|---|---|---|---|---|
| a rebase opus | 3 | 0 | 3 | 0 | 0 | 27 | 0.24 |
| a rebase sonnet | 3 | 0 | 3 | 0 | 0 | 21 | 0.10 |
| a replay opus | 3 | 0 | 3 | 0 | 0 | 37 | 0.26 |
| a replay sonnet | 3 | 0 | 3 | 0 | 0 | 19 | 0.11 |
| b rebase opus | 3 | 0 | 3 | 0 | 0 | 83 | 0.50 |
| b rebase sonnet | 3 | 0 | 3 | 0 | 0 | 70 | 0.26 |
| b replay opus | 3 | 0 | 3 | 0 | 0 | 68 | 0.47 |
| b replay sonnet | 3 | 0 | 3 | 0 | 0 | 52 | 0.21 |
| c (impossible), all 4 combos | 8 | 0 | 0 | **8** | 0 | 12–58 | 0.08–0.72 |

Plain `git rebase` was clean in **0 of 3** tenants. Without an agent, every tenant would have been stuck.

Quality, from manual and scripted diff review:
- Agents adopted the vendor's new structure. Tenant A's Priority became an entry in `defaultColumns`. Tenant B used `StatCard`, `status` and `lib/format`.
- No run revived deleted files, re-added old endpoints or dropped vendor features (search, "Avg open deal").
- Diffs were consistently small: about 14 lines for A, about 76–84 for B.

For tenant C, every run said `PIN:` with an admin-readable reason ("v2 no longer records who owns each deal…"). No run faked owner data. The two "TAMPERED_VENDOR" flags came from runs that aborted the rebase and left the branch on v1, which is correct pin behavior and an artifact of the check.

## Findings that change the design
1. **Sonnet is enough.** It succeeded every time, at about half the cost and was a bit faster. Default to Sonnet and escalate to Opus on failure.
2. **Rebase and replay are equivalent here.** Pick **rebase** as the default. It preserves per-commit history and the agent only touches conflicts. Use replay as a fallback.
3. **Vendor tests must be tenant-invariant contracts.** Tenant C's first version legitimately broke the vendor test twice: once by asserting exactly 5 table rows, once by finding text that was no longer unique. If vendor tests assert layout, every customization "fails". `forkui` needs:
   - a separate `contract` test tier: tests that must hold for every tenant, asserting behavior rather than layout
   - lint rules or guidance for writing those tests
4. **Tests can't see visual intent.** Tenant B's "wide hero card" style is now ineffective under v2's grid layout, yet all tests pass. Add a visual check to rebase verification: a screenshot before and after, judged against the intent, flagged for human review rather than used as a gate.
5. **The vendor's test helpers are the compatibility layer.** Tenant tests survived the endpoint and shape change only because they used the vendor-maintained `mockApi()`. The SDK should ship a versioned test kit.
6. **Pins need a handoff.** The agent's PIN messages were good enough to show to a customer as-is. The feature is "your customization X is paused on v1 because the vendor removed Y", with an option to request the field from the vendor.
7. **Tenant tests are fragile too, and this spike hid it.** The tenant tests were written knowing what v2 would change: `a1` accepts a column header of either `stage` or `status`. In production, tenant tests are frozen when they're written and the agent can't touch them. So a vendor rename unrelated to the intent would fail the test and force a *false pin*. The spike couldn't measure that rate. The design needs both of these:
   - a sanctioned **test-amendment proposal**: the agent proposes a minimal test diff, and the tenant admin sees and approves it before the rebase counts
   - a test kit that steers tenants toward **stable selectors** (roles, labels, `data-forkui-id`s the vendor commits to keeping)
8. **Cost and latency are fine.** It takes $0.10–0.50 and 20–80 seconds per tenant per release. That works out to roughly $25–125 per release for 250 tenants.

## Not covered
- These were 2–3 small, synthetic changes per tenant. Real forks will have dozens of commits and repos 100x larger.
- Results across several releases in a row were not tested.
- Customers making edits while a rebase runs was not tested.
- Each combination ran only 3 times, so this is directional, not statistically solid.
- **The tenant tests had help from knowing the answer:** they were written with knowledge of v2 (see finding 7). The rate of false pins from real frozen tests is unknown.

## Reproduce
```
./setup.sh && ./setup-c.sh
./trial.sh a rebase sonnet 1    # or trial-c.sh c replay opus 1
node summarize.mjs
```
