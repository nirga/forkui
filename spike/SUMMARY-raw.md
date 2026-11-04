| run | outcome | tests | turns | secs | cost $ | notes |
|---|---|---|---|---|---|---|
| a-rebase-opus-1 | agent_resolved | 4/4 | 10 | 28 | 0.23 |  |
| a-rebase-opus-2 | agent_resolved | 4/4 | 9 | 31 | 0.25 |  |
| a-rebase-opus-3 | agent_resolved | 4/4 | 7 | 22 | 0.22 |  |
| a-rebase-sonnet-1 | agent_resolved | 4/4 | 7 | 18 | 0.06 |  |
| a-rebase-sonnet-2 | agent_resolved | 4/4 | 14 | 28 | 0.14 |  |
| a-rebase-sonnet-3 | agent_resolved | 4/4 | 7 | 18 | 0.11 |  |
| a-replay-opus-1 | agent_resolved | 4/4 | 12 | 36 | 0.25 |  |
| a-replay-opus-2 | agent_resolved | 4/4 | 9 | 36 | 0.24 |  |
| a-replay-opus-3 | agent_resolved | 4/4 | 13 | 40 | 0.29 |  |
| a-replay-sonnet-1 | agent_resolved | 4/4 | 9 | 22 | 0.11 |  |
| a-replay-sonnet-2 | agent_resolved | 4/4 | 9 | 20 | 0.11 |  |
| a-replay-sonnet-3 | agent_resolved | 4/4 | 7 | 16 | 0.10 |  |
| b-rebase-opus-1 | agent_resolved | 6/6 | 17 | 69 | 0.48 |  |
| b-rebase-opus-2 | agent_resolved | 6/6 | 17 | 102 | 0.54 |  |
| b-rebase-opus-3 | agent_resolved | 6/6 | 16 | 78 | 0.47 |  |
| b-rebase-sonnet-1 | agent_resolved | 6/6 | 29 | 78 | 0.27 |  |
| b-rebase-sonnet-2 | agent_resolved | 6/6 | 17 | 50 | 0.22 |  |
| b-rebase-sonnet-3 | agent_resolved | 6/6 | 26 | 81 | 0.29 |  |
| b-replay-opus-1 | agent_resolved | 6/6 | 17 | 78 | 0.47 |  |
| b-replay-opus-2 | agent_resolved | 6/6 | 23 | 69 | 0.50 |  |
| b-replay-opus-3 | agent_resolved | 6/6 | 15 | 56 | 0.44 |  |
| b-replay-sonnet-1 | agent_resolved | 6/6 | 17 | 59 | 0.22 |  |
| b-replay-sonnet-2 | agent_resolved | 6/6 | 17 | 48 | 0.20 |  |
| b-replay-sonnet-3 | agent_resolved | 6/6 | 17 | 48 | 0.21 |  |
| c-rebase-opus-1 | pinned | 2/2 | 4 | 20 | 0.22 | TAMPERED PIN: The per-rep summary cards can't be carried over to the new release, because release v2 no longer includes a sales rep ("owner") on each deal. The new deals |
| c-rebase-opus-2 | pinned | 0/0 | 3 | 16 | 0.20 | PIN: I couldn't bring over the per-rep summary cards. In the new release, the vendor took the "owner" (sales rep) field off deals. The new deals service and the |
| c-rebase-sonnet-1 | pinned | 2/2 | 5 | 15 | 0.09 | TAMPERED PIN: The per-rep summary cards can't be rebuilt on the new vendor release, because version 2 no longer includes the "owner" (sales rep) on any deal. The vendor' |
| c-rebase-sonnet-2 | pinned | 2/2 | 4 | 12 | 0.08 | TAMPERED PIN: I couldn't carry over the per-rep summary cards, because the new vendor version no longer records who owns each deal.  In base/v2, deals have no "owner" fi |
| c-replay-opus-1 | pinned | 2/2 | 5 | 64 | 0.73 | TAMPERED PIN: Your "per-rep summary cards" customization can't be carried over to version 2. In v2 the vendor removed the sales rep (owner) from deal data, so the app ca |
| c-replay-opus-2 | pinned | 2/2 | 5 | 52 | 0.72 | TAMPERED PIN: The "Per-rep summary cards" customization can't be carried forward to version 2. In v2 the vendor removed the sales rep ("owner") from deals: it's gone fro |
| c-replay-sonnet-1 | pinned | 2/2 | 3 | 11 | 0.08 | TAMPERED PIN: Per-rep summary cards can't be rebuilt on the new vendor release (base/v2). The vendor's new version no longer includes a sales rep ("owner") on any deal.  |
| c-replay-sonnet-2 | pinned | 2/3 | 4 | 12 | 0.09 | PIN: The v2 release of Acme CRM no longer includes a sales rep (owner) on deals. The "Per-rep summary cards" feature can't be rebuilt on it, and I haven't chang |

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
| c rebase opus | 2 | 0 | 0 | 2 | 0 | 18 | 0.21 |
| c rebase sonnet | 2 | 0 | 0 | 2 | 0 | 14 | 0.09 |
| c replay opus | 2 | 0 | 0 | 2 | 0 | 58 | 0.72 |
| c replay sonnet | 2 | 0 | 0 | 2 | 0 | 12 | 0.08 |

Total cost: $8.63
