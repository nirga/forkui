# Getting started

This guide takes a Vite + React app from zero to "my customers' admins can customize it" in about five minutes.

> **Status:** forkui is pre-release and the packages aren't on npm yet. Until they are, work from this repo: `pnpm forkui <command>` runs the CLI from source.

## Prerequisites
- **Your app:** a Vite + React SPA in a git repo, with Node 22+. Next.js support is planned for v0.2.
- **A server you control** that serves the built frontend (Express, Connect, Hono, or any Fetch-API runtime).
- **An LLM API key** for the provider you choose. Any [Vercel AI SDK](https://ai-sdk.dev) provider works: Anthropic, OpenAI, Google, Bedrock, Ollama…

## 1. Install
In your app repo:

```bash
npx forkui@latest init --model anthropic:claude-sonnet-5-5
# optional: --escalate anthropic:claude-opus-5-5   (retry with a stronger model if the first attempt fails verification)
```

`init` detects your package manager, TypeScript, test runner, build script and server framework. It then writes the files below; review them with `git diff`.

| File | What it is |
|---|---|
| `forkui.config.json` | Your checks, locked paths, test kit and model. See [configuration](configuration.md). |
| `forkui/testkit.ts` | Helpers your customers' acceptance tests use (`mockApi()`, `fixtures`). **Fill in its routes** (step 3). |
| `.github/workflows/forkui.yml` | Runs `forkui release` on every push to your main branch. |
| `src/main.tsx` | `<Customize />` added next to your root component. |
| your server file | `app.use(forkui({ tenant, canCustomize }))`, inserted before your static files. |
| `package.json`, `.gitignore` | Adds `@forkui/react` and `@forkui/node`, and ignores `.forkui/`. |

If `init` can't recognize your entry file or server, it prints the exact lines to paste instead of guessing.

## 2. Tell forkui who your customers are
The generated middleware assumes your auth sets `req.user`. Edit the two resolvers to match your app:

```ts
app.use(forkui({
  tenant: (req) => req.user?.orgId,            // the customer (organization) this request belongs to
  canCustomize: (req) => req.user?.isAdmin,    // who may open the editor
  user: (req) => req.user?.id,                 // optional: recorded as the author of a change
}));
```

Until `tenant()` returns an id, forkui is inert and everyone gets your normal app. **Never derive the tenant from something the client controls**, such as a header or query parameter. Use your session.

## 3. Fill in the test kit
Every customer change comes with an acceptance test that keeps it working through your future releases. Those tests mock your API through `forkui/testkit.ts`, so describe your endpoints there once:

```ts
export const fixtures = { deals: [{ id: 'd1', name: 'Website revamp', stage: 'proposal', amount: 12000 }] };
const routes = { '/api/deals': () => fixtures.deals };
```

When your API changes, update the test kit in the same commit, and every customer's tests keep passing. `forkui doctor` warns while `routes` is empty.

## 4. Run it locally
```bash
npx forkui dev        # starts a forkui server on :4400 and prints FORKUI_URL / FORKUI_SECRET
```
Start your app server with those two env vars, sign in as an admin of some customer and click **Customize**.

```bash
npx forkui doctor     # checks config, the three integration points, the test kit, your checks and the server
```

## 5. Ship releases
Run this after your backend deploys. The generated workflow does it in CI:

```bash
npx forkui release    # uploads HEAD as a base release and carries every customer onto it
```

For each customer, forkui tries a plain git rebase, then the agent, then verification by your checks and their tests. Customers that verify get a rebuilt release. The rest are **pinned**: they keep their last good build and get a plain-language reason. Keep older API versions working while `forkui tenants` shows anyone pinned.

## 6. Production
The forkui server holds customer branches, builds and the editor. Run it as its own service and give it:
- `FORKUI_SECRET`, a random string of 32 or more characters, shared with your app server's middleware
- the provider key, e.g. `ANTHROPIC_API_KEY`
- a persistent data directory

```ts
import { startServer } from '@forkui/server';
await startServer({ dataDir: '/var/lib/forkui', secret: process.env.FORKUI_SECRET!, port: 4400, hostname: '0.0.0.0', appOrigins: ['https://app.example.com'] });
```

A Docker image is planned. The `local` sandbox driver runs builds on the host, so run the forkui server in its own container or VM. See [security](security.md).

## Remove it
```bash
npx forkui uninstall   # removes the generated files and the inserted lines; then remove the packages
```
