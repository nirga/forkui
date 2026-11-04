# Example: Acme CRM

A small Vite + React + TS app used for forkui's end-to-end test.

- `v1/` is the first base release.
- `v2/` is a deliberately breaking second release:
  - `DealsTable` is replaced by `components/deals/DealTable` (driven by a column config)
  - `stage` becomes `status`
  - the API moves to `/api/v2/opportunities` and returns `{ items }`
  - `formatMoney` moves to `lib/format`
  - the dashboard is rebuilt from `StatCard`s
  - a search box is added

`forkui.config.json` (copied into both releases) defines:
- vendor checks: typecheck, tests, build
- locked and vendor-owned paths
- the tenant test kit: `mockApi()` and fixtures

Run the end-to-end test with a real model (any AI SDK provider you have installed):

```
FORKUI_E2E_MODEL=anthropic:claude-sonnet-5-5 ANTHROPIC_API_KEY=... pnpm test:e2e
FORKUI_E2E_MODEL=openai:gpt-5.4 OPENAI_API_KEY=... pnpm test:e2e
```
