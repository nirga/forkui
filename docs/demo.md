# The demo: forkui from the customer's side

`examples/crm-demo` runs **Acme CRM**, a small SaaS product, with forkui integrated exactly as `forkui init` would do it. It has demo users at three customer orgs, so you can see what the product's customers see.

## Run it
1. Put your model key in `.env` at the repo root. Copy `.env.example`; `.env` is gitignored.
   ```bash
   ANTHROPIC_API_KEY=sk-ant-...
   # optional: FORKUI_MODEL=anthropic:claude-sonnet-5-5   FORKUI_ESCALATE_MODEL=anthropic:claude-opus-5-5 | none
   ```
2. Start it:
   ```bash
   pnpm install
   pnpm demo            # first run sets up the vendor repo (~30s); later runs start instantly
   pnpm demo --reset    # start over
   ```
3. Open **http://localhost:3000/demo**.

## What to try
1. **Sign in as Dana** (Acme Inc., admin) and click **Customize** (bottom right). You'll see **Your features** (empty at first). Click **+ New feature**.
2. **Tell it what you want,** as you would a colleague:
   - "Can you show each deal's priority in the table? High ones in red"
   - "Add a Win rate card to the dashboard"
   - "I'd like a Pipeline view with a column per stage"

   The assistant may ask one clarifying question. Then it proposes the change with **Done when** criteria; these become the check that keeps the change working through future updates. Click **Build it**.
3. **Watch it work:** the steps appear in plain language and take about a minute. Then click **Preview**. The page reloads into your private preview (purple banner), and the chat panel comes back with **Publish for everyone**, **Discard** and **Exit preview**.
4. **Refine it** by chatting in the same feature ("make the high ones bold too"). The assistant proposes an updated version of the feature. **Publish** when you're happy.
   - Later, open a **live** feature and chat again to change it. The new version is a preview, and the old one stays live until you publish.
   - Start other features with **+ New feature**. Each has its own conversation. Only one can wait unpublished at a time.
5. **Switch users:** sign in as **Sam** (Acme, not an admin): Sam sees the change but has no Customize button. Sign in as **Lee** (Globex): Lee sees the standard app.
6. **Be the vendor:** on `/demo`, click **Ship v2**. v2 breaks everything a customer change might touch:
   - the deals table is rewritten as a column-config `DealTable`
   - `stage` becomes `status`
   - the API moves to `/api/v2/opportunities`
   - the dashboard is rebuilt from `StatCard`s

   Watch the log: forkui rebases Acme's branch, the agent adapts the change to v2, verification runs, and Acme gets a new build. Sign in again: v2 is there (with its new search box) and so is the customization. An unpublished preview stays a preview: it's rebuilt on v2, never published automatically.

## What's real and what's demo
**Real:** everything forkui does:
- the forkui server, middleware, editor, agent, verification, builds and releases
- the git store, under `examples/crm-demo/.demo/forkui/store`

**Demo-only:**
- the login (a cookie that names the user)
- the in-memory API data
- the "Ship v2" button, which stands in for the vendor's CI: build, deploy, then `forkui release`
- running the forkui server in the same process as the app

| Port | |
|---|---|
| 3000 | The vendor's app server (Express + `forkui()` middleware) |
| 4400 | The forkui server (API, jobs, editor) |

## Troubleshooting
- **"No model credentials"** on `/demo`: set the provider key in `.env` and refresh. The demo re-reads `.env`, so no restart is needed.
- **An edit is "rejected"** with a reason: the change didn't pass verification. For example, the test passed even without the change, or a check failed. Rephrase it and try again.
- **Look at what the agent did:**
  ```bash
  git -C examples/crm-demo/.demo/forkui/store/repo.git log --all --format='%h %d %s'
  ```
