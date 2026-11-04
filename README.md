# forkui

**Per-customer forks of your product's frontend that survive your releases.**

forkui lets each customer of a B2B product reshape the frontend with AI. Every customer gets a real git branch of your actual frontend code. When you ship a new version, an agent carries every customer's customizations onto it, and the result is verified by your checks and by each customer's own acceptance tests.

> Status: early. The engine, server, middleware, CLI and editor work. The vendor console and the hosted Docker image are next. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the feasibility spike in [spike/SPIKE.md](spike/SPIKE.md).

## Quickstart (Vite + React)

In your frontend repo:

```bash
npx forkui@latest init --model anthropic:claude-sonnet-5-5   # any AI SDK provider:model
```

`init` detects your stack and makes three one-line changes. Review them with `git diff`:

```tsx
// src/main.tsx: a "Customize" button, shown only to users you allow
createRoot(root).render(<><App /><Customize /></>);
```

```ts
// your server (Express shown; Hono and Fetch-API runtimes supported), before static files
app.use(forkui({
  tenant: (req) => req.user?.orgId,            // which customer is this?
  canCustomize: (req) => req.user?.isAdmin,    // who may customize?
}));
```

```yaml
# .github/workflows/forkui.yml: every deploy becomes a base release
- run: npx forkui@latest release ${{ github.sha }}
```

`init` also writes `forkui.config.json` (your checks, locked paths, test kit) and `forkui/testkit.ts`, the helpers your customers' acceptance tests use.

**Your backend doesn't change.** Customer builds are your own code, served from your own origin, so they call your API with the same auth.

**Customers without a fork, or any request while forkui is down, get your normal deploy.**

**Run `forkui release` after your backend deploys.** A customer that can't be carried onto a new version yet is *pinned*: they keep their last good build, so keep older API versions working while `forkui tenants` shows anyone pinned.

```bash
npx forkui dev      # local forkui server; prints FORKUI_URL / FORKUI_SECRET for your app server
npx forkui doctor   # checks everything is wired up
npx forkui release  # ship HEAD as a base release and carry every customer onto it
npx forkui uninstall
```

## See it from the customer's side
```bash
cp .env.example .env      # add ANTHROPIC_API_KEY (or another provider's key)
pnpm install && pnpm demo # then open http://localhost:3000/demo
```
Sign in as a customer admin, click **Customize**, ask for a change, preview it and publish it. Then ship the vendor's breaking v2 and watch the customization carry over. Walkthrough: [docs/demo.md](docs/demo.md).

## Docs
- [Getting started](docs/getting-started.md): the five-minute integration
- [Integration reference](docs/integration.md): `<Customize />`, the middleware, CI, the CLI and the HTTP API
- [Configuration](docs/configuration.md): every field of `forkui.config.json`
- [Concepts](docs/concepts.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](docs/security.md)
- **Using Claude Code?** Copy [`skills/forkui`](skills/forkui/SKILL.md) into your repo's `.claude/skills/` and ask Claude to "add forkui". It runs `init`, wires your auth into the resolvers, fills in the test kit and reviews the config with you.
- Contributing: see [CLAUDE.md](CLAUDE.md) for the layout, commands and invariants.

## How it works
1. **The vendor** adds `forkui.config.json` (checks, locked paths, test kit) and publishes base releases (`base/v1`, `base/v2`, …).
2. **A customer** asks for a change. The agent implements it on their branch and writes an acceptance test from the approved natural-language spec. The change is committed only if all checks pass and the new test fails without it.
3. **On every vendor release**, forkui rebases each customer branch:
   - first plain git
   - then the agent, which resolves conflicts and adapts the change to the new code
   - then a verification step run by the harness, not the agent

   Customers that can't be carried over are **pinned** to their last good version with a plain-language explanation. They never see a broken app.

## LLM-agnostic
Models are configured as `"<provider>:<model>"` and run through the [Vercel AI SDK](https://ai-sdk.dev). Install the provider you use:

```jsonc
// forkui.config.json
"agent": { "model": "openai:gpt-5.4", "escalateTo": "anthropic:claude-opus-5-5" }
```

## Packages
| Package | What it does |
|---|---|
| `@forkui/core` | config schema, intent trailers, ids |
| `@forkui/git` | the store: base releases, tenant branches, worktrees, rebase primitives |
| `@forkui/policy` | locked/vendor-owned paths, frozen tenant tests, dependency allowlist, forbidden code |
| `@forkui/sandbox` | sandbox driver interface (local driver included), dependency cache, check runner |
| `@forkui/agent` | guarded tool set, prompts, provider-agnostic agent runner |
| `@forkui/engine` | `editTenant`, `rebaseTenant`, `buildRelease` |
| `@forkui/server` | HTTP API, job queue, release store, editor UI |
| `@forkui/node` | `forkui()` middleware (Express/Connect, Hono, Fetch) + signed tokens |
| `@forkui/react` | `<Customize />` |
| `forkui` | the CLI: `init`, `dev`, `release`, `doctor`, `tenants`, `uninstall` |

## Develop
```
pnpm install
pnpm typecheck
pnpm test            # unit + engine tests (scripted mock models, no LLM needed)
pnpm test:e2e        # CRM example: no-model smoke always; full run with FORKUI_E2E_MODEL=<provider:model>
pnpm demo            # the browser demo (needs a key in .env)
```

## License
[Apache-2.0](LICENSE)
