# CLAUDE.md: working on forkui

forkui gives each customer (tenant) of a B2B SaaS product its own git branch of the vendor's real frontend. An LLM agent edits that branch; on every vendor release forkui rebases each branch, verifies it, and rebuilds. Read in this order:
- `docs/concepts.md`
- `docs/ARCHITECTURE.md`
- `spike/SPIKE.md`: why the design is what it is

## Commands
```bash
pnpm install
pnpm typecheck      # tsc -b (all packages) + tsc -p tsconfig.test.json (tests). Must be clean.
pnpm test           # unit + engine + server tests (~15s). Scripted mock models, no network, no keys.
pnpm test:e2e       # CRM smoke (real npm ci + vite build, no model) + full run if FORKUI_E2E_MODEL is set
pnpm demo           # browser demo on :3000/demo (needs a key in .env); --reset to rebuild
pnpm forkui <cmd>   # run the CLI from source (tsx)
```

## Layout (TypeScript, pnpm workspace, ESM, Node 22+)
```
packages/core      config schema (zod), ReleaseManifest/ArtifactStore types, intent trailers, ids/refs
packages/git       GitStore (bare repo + worktrees), Worktree (commitIntent, rebase, resetTo)
packages/policy    checkPolicy (after-the-fact), createWriteGuard (immediate, for agent tools)
packages/sandbox   Sandbox/SandboxDriver, LocalDriver, DependencyCache, runChecks
packages/agent     createTools (the agent's ONLY capabilities), prompts, runAgent (AI SDK generateText), model resolver
packages/engine    editTenant, rebaseTenant, buildRelease, verify
packages/server    ForkuiServices (jobs, publish, discard, rollout), Hono app (createApp), editor UI, startServer
packages/node      vendor middleware: createHandler (Fetch core), forkui/forkuiHono/forkuiFetch adapters, tokens
packages/react     <Customize /> (ships built dist/; exports point at dist)
packages/cli       `forkui` CLI: detect, init/uninstall codemods, dev/release/doctor/tenants
examples/crm       v1/v2 releases of a Vite+React CRM + forkui.config.json (e2e fixture)
examples/crm-demo  browser demo (Express vendor server + in-process forkui server)
spike/             throwaway feasibility experiment (claude -p); results in SPIKE.md
test/              shared helpers (tmp dirs under .forkui-data/), e2e tests
```

## Invariants (don't break these)
- **Must be LLM-agnostic.** Models are `"provider:model"` strings resolved via AI SDK v7 (`ai@7.0.145`), with no default provider. Don't add vendor-specific SDKs to core packages.
- **The harness verifies; the agent is never trusted.** Branch refs move only via `GitStore.updateTenant` (compare-and-swap), after `verify()` passes.
- **No shell for agents.** Add capabilities as named tools in `packages/agent/src/tools.ts`, guarded by `createWriteGuard`. The read-only `git` tool blocks options like `--no-index` and `--output`. Keep it read-only.
- **Config is read from the base release** (`store.readConfig(version)`), never from a tenant branch.
- **Frozen tenant tests:** existing `forkui-tests/*` must be byte-identical unless explicitly approved (`approvedTestChanges`).
- **`checkPolicy` must never touch the real git index.** It uses a temporary `GIT_INDEX_FILE`, because worktrees can be mid-rebase, and the copy must keep the original's mtime (racy-git).
- **`forkui release` is idempotent and incremental.**
  - Re-releasing the same commit under the same version is a no-op; a version name is never reused for a different commit (`GitStore.tagBase`).
  - The CLI uploads only commits the server lacks (`GET /v1/bases`, then a bundle `HEAD ^known…`), or just tags a known sha.
  - Rollouts run tenants in parallel, bounded by the JobQueue concurrency; the coordinator job takes no slot.
- **The middleware fails open:** any error means `next()` and the base app.
- **Unpublished previews never go live by themselves.** Rollouts republish only tenants that were live; publish requires the release sha to equal the tenant head.
- **At most one unpublished change per tenant** (`TenantState.pending`), and it is always the top commit of the branch.
  - A rollout publishes only `head^` for a live tenant with a pending change, and rebuilds the pending change as a fresh preview.
  - A chat revision of the pending change discards it (by compare-and-swap) and rebuilds it as one intent.
- **Features:**
  - A feature is an intent id (`f1`…). Its versions are the branch commits with that id; a revision is a new commit on top (`editTenant` with `revise`).
  - `FeatureStore` (`state/features/<t>/<id>.json`) holds ONLY the conversation and draft title. Status and the current definition are derived from git plus `TenantState` in `ForkuiServices.listFeatures`. Snapshot running jobs *before* reading state there.
  - `planTurn` (packages/agent/src/planner.ts) is a tool-call planner (reply or propose the feature's complete definition) with no code access.
  - Editor progress wording comes from `humanize()` in packages/server/src/editor.ts: no file names in the UI. Agent finish summaries are prompted to be non-technical.
  - The editor JS lives in a template string: escape regex backslashes twice (`\\.`). A test parses the served script.
- **Every `init` codemod line carries the `// forkui` marker**, and `uninstall` must reverse `init` exactly (there's a test).

## Conventions
- **Imports:** relative imports use `.ts` extensions (`rewriteRelativeImportExtensions`).
- **Classes:** parameter properties are used, so run via tsx or vitest, not Node's strip-only mode.
- **Dependency versions:** pin exact versions, at least two weeks old.
- **Tests:**
  - create temp dirs with `tmp()` from `test/helpers.ts` (under `.forkui-data/`, gitignored; macOS `/var/folders` symlinks break `node_modules` links)
  - engine and server tests use `scriptedModel()` from `packages/engine/test/fixture.ts` (`MockLanguageModelV4`, one tool call per step)
- **Errors returned to agents** are short strings; they're tool results, not exceptions.

## Known gaps (as of 2026-11)
- The real-model e2e has not been run in CI. Run it locally with a key: `FORKUI_E2E_MODEL=anthropic:claude-sonnet-5-5 pnpm test:e2e`.
- Packages are not published, and the CLI bin is a `.ts` file. Needed: a build step, plus `dist` exports everywhere (only react has them).
- Not built yet:
  - remote sandbox drivers
  - the vendor console
  - the Docker image
  - the test-amendment flow (regenerate a test from its spec, with the three-way check)
  - `init --ai` to fill in the test kit
  - Next.js support
- The old "rare policy flake" was a real bug, fixed 2026-11-04. The temp index copy got a fresh mtime, which defeated git's racy-git check, so a same-size edit right after checkout looked unchanged and could slip past policy. `checkPolicy` now copies the index's timestamps; a regression test covers it.
