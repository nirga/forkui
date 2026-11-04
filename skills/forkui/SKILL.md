---
name: forkui
description: Integrate forkui into a Vite + React SaaS app so each customer's admins can customize their own copy with AI, with customizations carried over every vendor release. Use when the user wants to add forkui, set up per-customer customization, wire the forkui middleware or <Customize /> button, fill in the forkui test kit, configure forkui.config.json, run forkui release in CI, or debug why a customer is "pinned" or a forkui edit was rejected.
---

# Integrating forkui

forkui gives every customer (tenant) of the user's product a git branch of the product's real frontend. An agent edits it on the customer's behalf, and `forkui release` carries every branch onto each new version. Integration has three touchpoints; `npx forkui init` writes all of them.

## Before you start
- Confirm the app is **Vite + React** (`vite` and `react` in package.json). For Next.js, say v0.1 doesn't support it yet and stop.
- Find the **server that serves the built frontend** (Express, Connect, Hono or a Fetch runtime). If there isn't one, for example a static host, explain that forkui needs a middleware in front of the static files: an edge function or a small Node server.
- Find **how the app knows the current customer and whether the user is an admin.** Look for session or auth middleware, `req.user`, or JWT claims. You need both for step 2.
- Ask which **LLM provider:model** to use if it isn't obvious, e.g. `anthropic:claude-sonnet-5-5` or `openai:gpt-5.4`.

## Steps
1. **Run init** in the repo root, and show the user the diff afterwards:
   ```bash
   npx forkui@latest init --model <provider:model>
   git diff
   ```
   If `init` prints a "!" manual step (entry or server not recognized), make that edit yourself. The middleware goes **before** static file serving; `<Customize />` renders once next to the root component.

2. **Wire the resolvers to real auth.** In the server file, replace the generated defaults:
   ```ts
   app.use(forkui({
     tenant: (req) => req.session.user?.organizationId,   // from the SESSION
     canCustomize: (req) => req.session.user?.role === 'admin',
     user: (req) => req.session.user?.id,
   }));
   ```
   Never take the tenant from a header, query string or anything else the client controls. Hono uses `forkuiHono` with `c.var`; Workers, Bun and Deno use `forkuiFetch`.

3. **Fill in `forkui/testkit.ts`.** Read the app's API client (`fetch`/axios calls, base URLs, response shapes) and:
   - add realistic `fixtures`
   - add a `routes` entry for every endpoint the main screens call, keyed by URL **path**, returning the fixture shape

   Then run one tiny test that calls `mockApi()` and renders the root component, to prove it works. Customer tests depend on this file, so it must survive API changes: when the API changes, update the test kit, never the customer tests.

4. **Review `forkui.config.json`** with the user:
   - **`checks`:** must pass on every customer's branch. Flag vendor tests that assert layout (row counts, `getByText` on text that might repeat) and suggest scoping them with `within()` or roles.
   - **`paths.locked`:** add anything customers must never change (auth, billing, permissions, analytics, legal pages).
   - **`paths.vendorOwned`:** test helpers and fixtures.
   - **`dependencies.allow`** and **`network.allowHosts`:** keep them minimal.
   - **`testKit.guidance`:** name the test-kit helpers and how to render the app.

   The full reference is `docs/configuration.md` in the forkui repo.

5. **Verify locally:**
   ```bash
   npx forkui dev        # prints FORKUI_URL and FORKUI_SECRET; start the app server with both
   npx forkui doctor     # every line should be ✓; fix each ! and ✗
   ```
   Sign in as an admin user. A **Customize** button should appear; non-admins and users with no tenant see nothing.

6. **CI:** `init` wrote `.github/workflows/forkui.yml`. Move the `forkui release` step so it runs **after** the backend deploy, and add the `FORKUI_URL` and `FORKUI_SECRET` repo secrets. Remind the user that customers can be **pinned** to an older version, so older API versions must keep working while `forkui tenants` shows anyone pinned.

## Debugging
- **An edit is "rejected":** read the reason in the job (`GET /v1/me/jobs/:id`). Common causes:
  - the test passed without the change, so the spec was too vague
  - a vendor check failed
  - the agent touched a locked path
- **A customer is "pinned" after a release:** `npx forkui tenants` shows the reason. Usually the vendor removed something the customization depends on, or a frozen customer test relies on layout the vendor changed.
- **Customers see the standard app:** check that `tenant()` returns an id for that user, that the customization was **published** (not just previewed), and the `onError` log. The middleware fails open when forkui is unreachable.
- **To inspect a customer's branch:** `git -C <dataDir>/store/repo.git log tenants/<id>`.

## Don't
- Don't edit `forkui-tests/*` in customer branches by hand. They're frozen acceptance tests.
- Don't put the forkui middleware after the static file handler.
- Don't commit `.forkui/` (the dev data directory, which holds the secret).
