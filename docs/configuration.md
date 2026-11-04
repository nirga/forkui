# `forkui.config.json`

The config lives in your repo, but forkui always reads it from the **base release**, never from a customer's branch. A customer change can't alter its own rules, and the config file itself is always locked. It is JSON, so loading it runs no code.

```jsonc
{
  "version": 1,
  "install": { "run": ["npm", "ci", "--no-audit", "--no-fund"], "lockfile": "package-lock.json" },
  "checks": [
    { "name": "typecheck", "run": ["npx", "tsc", "--noEmit"] },
    { "name": "test", "run": ["npx", "vitest", "run"] },
    { "name": "build", "run": ["npm", "run", "build"] }
  ],
  "build": { "run": ["npm", "run", "build"], "outDir": "dist" },
  "paths": {
    "locked": ["src/main.tsx", "index.html", "vite.config.*", "src/auth/**"],
    "vendorOwned": ["forkui/**", "src/test/**"],
    "tenantTests": "forkui-tests"
  },
  "testKit": {
    "extension": ".spec.tsx",
    "run": ["npx", "vitest", "run", "{file}"],
    "guidance": "Use mockApi() from ../forkui/testkit before rendering <App />…"
  },
  "dependencies": { "allow": ["date-fns", "@radix-ui/*"] },
  "network": { "allowHosts": ["api.example.com"] },
  "agent": { "model": "anthropic:claude-sonnet-5-5", "escalateTo": "anthropic:claude-opus-5-5", "maxSteps": 60 }
}
```

| Field | Default | Meaning |
|---|---|---|
| `install.run` / `install.lockfile` | `npm ci …` / `package-lock.json` | How dependencies are installed in the sandbox. Installs are cached by a hash of the lockfile, so customers sharing your dependencies never reinstall. |
| `checks[]` | required | Commands every customer branch must pass, run in order. Each takes `name`, `run` (argv, no shell) and `timeoutMs` (default 5 min). Your test command must also pick up `forkui-tests/`. |
| `build.run` / `build.outDir` | `npx vite build` / `dist` | Builds a customer release. Output is served at the same URL paths as your own deploy. |
| `paths.locked` | `[]` (+ the config file) | Globs a customer change may never modify. |
| `paths.vendorOwned` | `[]` | Globs customers may read but never modify: your test kit, fixtures and contract tests. |
| `paths.tenantTests` | `forkui-tests` | Where customer specs (`<id>.spec.md`) and compiled tests live. Once committed they are frozen. |
| `testKit.extension` | `.spec.tsx` | The compiled test is `<tenantTests>/<intentId><extension>`. |
| `testKit.run` | `npx vitest run {file}` | Runs a single test file. Used to prove a new test fails without the change. |
| `testKit.guidance` | `""` | Told to the agent whenever it writes a test. Name your helpers here. |
| `dependencies.allow` | `[]` | Packages a customer change may add. Globs are allowed. Nothing else in `package.json` may change. |
| `network.allowHosts` | `[]` | Absolute URLs customer code may reference, beyond your own origin. They're also added to the CSP `connect-src`. |
| `editor.suggestions` | product-neutral examples | Example requests shown when an admin starts a feature. Write them for *your* product. Either a list, or per language: `{ "en": [...], "he": [...] }`. |
| `editor.defaultLanguage` | `en` | Language used when the host page doesn't declare one (`<html lang>` or `<Customize language>`). |
| `agent.model` | **required** | `"<provider>:<model id>"`. The provider package is loaded dynamically, e.g. `anthropic` → `@ai-sdk/anthropic`, `openai` → `@ai-sdk/openai`, `google`, `amazon-bedrock`, `azure`, `mistral`, `xai`, `groq`, `deepseek`, `ollama`. Credentials come from each provider's usual env var. |
| `agent.escalateTo` | `null` | A second model, tried once if the first attempt fails verification. |
| `agent.maxSteps` | `60` | Tool-call budget per attempt. |

## Writing checks customers can live with
Your checks run on **every customer's branch**, so they must test behavior rather than layout. The spike found two common traps:
- **Exact layout:** `expect(rows).toHaveLength(5)` breaks the moment a customer adds a summary row.
- **Globally unique text:** `getByText('$32,000')` breaks as soon as a customer shows the same number somewhere else.

Query by role and label, scope queries with `within()`, and keep layout-specific tests out of the checks.
