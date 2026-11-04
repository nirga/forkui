# forkui architecture

forkui gives every customer ("tenant") of a B2B product its own git branch of the vendor's real frontend. An AI agent edits that branch on the tenant's behalf. When the vendor ships a new base release, an agent rebases every tenant branch and preserves what the tenant *meant*.

See `spike/SPIKE.md` for the experiment behind these choices.

## Vocabulary
| Term | Meaning |
|---|---|
| **Store** | A forkui-managed bare git repo, plus its worktrees. It is the only place tenant code lives. |
| **Base release** | Tag `base/<version>` on `main`. Only the vendor creates these. |
| **Tenant branch** | `refs/heads/tenants/<tenantId>`, forked from a base release. |
| **Intent** | A tenant change: one commit carrying `Forkui-*` trailers. |
| **Spec** | A natural-language acceptance spec (`forkui-tests/<intentId>.spec.md`). It is frozen once the tenant approves it and is the source of truth for the intent. |
| **Compiled test** | Playwright or Vitest code generated from the spec (`forkui-tests/<intentId>.spec.ts[x]`). It is committed. When it breaks, it may only be *regenerated from the spec*, never edited by hand. |
| **Contract tests** | Vendor tests that must pass on every tenant branch. They assert behavior, not layout. |
| **Release** | A built artifact of a tenant branch at one commit. The router serves the tenant's current release. |
| **Pin** | A tenant that cannot move to the new base yet. It keeps serving its last good release and gets a readable explanation. |

## Commit trailers
```
Add Priority column to deals table

Forkui-Intent-Id: a1
Forkui-Intent: Show each deal's priority as a column right after Stage; high = red.
Forkui-Spec: forkui-tests/a1.spec.md
Forkui-Test: forkui-tests/a1.spec.tsx
```

## Configuration: `forkui.config.json` in the vendor repo
- It is JSON, not TS, so loading it never executes code.
- It is **always read from the base release, never from a tenant branch**. A tenant edit therefore cannot change its own policy, and the file itself is implicitly locked.
- Its contents are described by `packages/core/src/config.ts`:
  - checks
  - locked paths
  - vendor-owned paths
  - contract tests
  - dependency allowlist
  - allowed network hosts
  - agent model settings

## Packages
| Package | Responsibility |
|---|---|
| `@forkui/core` | Types, config schema and loader, trailer format/parse. No I/O beyond reading config. |
| `@forkui/git` | Store: import base releases, create tenants, worktrees, intent commits, rebase primitives, compare-and-swap ref updates. Uses the `git` CLI. |
| `@forkui/policy` | Static checks on a tenant change: locked or vendor-owned paths, tampered tenant tests, unlisted dependencies, forbidden code patterns, conflict markers. |
| `@forkui/sandbox` | Runs commands for a worktree. Driver interface: `local` for development and tests (no isolation); E2B, Daytona, Vercel or Cloudflare sandboxes for production. Also caches dependencies by lockfile hash and runs checks. |
| `@forkui/agent` | Provider-agnostic agent built on the Vercel AI SDK (`generateText` plus tools). Models are `"<provider>:<model>"` specs resolved through whichever `@ai-sdk/*` package is installed (Anthropic, OpenAI, Google, Bedrock, Ollama…). The agent gets **no shell**, only named, guarded tools: list, read, search, write, edit, delete, read-only `git`, `run_checks`, `rebase_continue`, `amend_intent`, `finish`, `pin`. Every file operation goes through the `Sandbox`, and every write is checked against policy as it happens. |
| `@forkui/engine` | The jobs. `editTenant`: the harness writes the frozen spec; the agent implements the change and compiles the spec into a test; the result is accepted only if the checks pass **and** the new test fails on the previous code. `rebaseTenant`: try plain git, then the primary model, then the escalation model, then verify; otherwise pin. The tenant ref moves only by compare-and-swap after verification. |
| `@forkui/server` | `ForkuiServices`: an in-process job queue (one job at a time per tenant), edit, then preview build, then publish or discard; rollouts (rebase, then rebuild and republish live tenants, or pin); the filesystem artifact store (content-addressed blobs and release manifests); per-tenant serving state. The Hono HTTP API, and the editor UI served to the `<Customize />` iframe. |
| `@forkui/node` | The vendor's middleware. A Fetch-API core (`createHandler`) with Express/Connect, Hono and Fetch adapters. Serves each tenant's live (or previewed) release at the app's normal URL paths and fails open. Issues HMAC editor tokens and preview cookies. No dependencies. |
| `@forkui/react` | `<Customize />`: the floating button, the editor iframe and the preview banner. |
| `forkui` (CLI) | `init`/`uninstall` (stack detection, plus codemods marked `// forkui`), `dev`, `release` (git bundle upload, then rollout), `doctor`, `tenants`. |
| *(later)* | Vendor console, Docker image, remote sandbox drivers, Next.js. |

## Verification rule
After any agent run, a rebased tenant branch is accepted only if *harness-run* checks pass. Nothing the agent reports is trusted. The checks:
1. Policy passes against the new base.
2. Contract tests and vendor checks (typecheck, build) pass.
3. Every intent's compiled test passes.
4. Any compiled test that was regenerated passes a **three-way check**:
   - it passes on the tenant's previous release
   - it fails on the bare new base
   - it passes on the rebased tenant branch

   This proves the regenerated test still detects the customization, with no LLM judging it.
5. *(Later, advisory only)* A visual check: screenshots of the old tenant release, the bare new base and the rebased tenant, compared by a vision model against the intent. A mismatch is flagged for human review; it does not block the release.

## Security model (summary)
- Tenant code runs in end users' browsers. The real enforcement happens at runtime, not in static checks:
  - every backend call goes through the forkui proxy using the end user's own token
  - CSP `connect-src` is limited to the proxy and the allowed hosts
- Static policy catches mistakes and obvious abuse. It is not a security boundary.
- Agents run in sandboxes with scrubbed environment variables. Production drivers must also isolate the filesystem and network.
- **Not yet designed: remote sandboxes.** The current `Sandbox` contract assumes the sandbox shares the worktree's filesystem, as with a bind mount; that holds for the `local` driver and a Docker bind mount. File reads and writes go through the sandbox, but several things still run `git` on the host:
  - the agent's `list_files`, `search`, `git`, `rebase_continue` and `amend_intent` tools
  - the engine's commits and rebases

  A remote driver (E2B, Daytona…) needs either file sync with the host worktree or git running inside the sandbox.
