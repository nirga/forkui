# Integration reference

There are three touchpoints, and `forkui init` writes all of them.

## 1. Frontend: `<Customize />`
```tsx
import { Customize } from '@forkui/react';
createRoot(root).render(<><App /><Customize /></>);
```
Props:
- `basePath` (default `/_forkui`)
- `label` (default `"Customize"`)
- `position` (`bottom-right` or `bottom-left`; by default, the left corner on right-to-left pages)
- `language`: your app's UI language, e.g. `i18n.language`. It defaults to `<html lang>` and picks the editor's suggestions. The editor also follows the page's direction (RTL).

What it does:
- Calls `GET /_forkui/token`. If the middleware says the user may customize, it shows a floating button.
- The button opens the editor in an iframe served by the forkui server. The editor token travels in the URL hash and the editor clears it on load.
- While an admin previews an unpublished change, it shows a banner with an **Exit preview** link.
- It renders nothing for everyone else.

## 2. Server: the middleware (`@forkui/node`)
Mount it **before** your static file handler.

```ts
// Express / Connect
import { forkui } from '@forkui/node';
app.use(forkui({ tenant: (req) => req.user?.orgId, canCustomize: (req) => req.user?.isAdmin }));

// Hono
import { forkuiHono } from '@forkui/node';
app.use(forkuiHono({ tenant: (c) => c.var.user?.orgId, canCustomize: (c) => c.var.user?.isAdmin }));

// Cloudflare Workers / Bun / Deno (any Fetch-API runtime)
import { forkuiFetch } from '@forkui/node';
const fk = forkuiFetch({ tenant: (req) => tenantFromSession(req) });
export default { fetch: async (req) => (await fk(req)) ?? serveYourApp(req) };
```

| Option | Default | |
|---|---|---|
| `tenant(ctx)` | required | The customer id, or nothing for "no tenant" (your normal app). Take it from your session. |
| `canCustomize(ctx)` | nobody | Who may open the editor. |
| `user(ctx)` | none | End-user id, recorded as the change's author. |
| `server` | `FORKUI_URL` or `http://localhost:4400` | The forkui server's URL. |
| `secret` | `FORKUI_SECRET` | Shared secret, 32+ characters. |
| `manifestTtlMs` | `30000` | How long a customer's release manifest is cached. |
| `assetCacheBytes` | 64 MB | In-memory cache for release files. |
| `onError(err)` | none | Called when forkui is unreachable. The request falls through to your app. |

How each request is handled:
| Request | Response |
|---|---|
| `/_forkui/token`, `/_forkui/preview`, `/_forkui/preview/exit`, `/_forkui/status` | Handled by forkui. |
| GET page navigation, customer has a live (or previewed) release | The release's `index.html`, with `Cache-Control: private, no-cache` and a CSP `connect-src 'self' <allowHosts>`. |
| GET a path that exists in that release | The file. Hashed assets are `immutable`; everything else is `private`. |
| Anything else (your API, customers without a fork, forkui down) | `next()`: your app handles it. |

Things that matter in production:
- **If a CDN sits in front of your app,** it must respect `Cache-Control: private` on HTML and `Vary: Cookie`.
- **Service workers** can cache one customer's build for another user on the same device. `forkui doctor` warns if it finds one.

## 3. CI: `forkui release`
```yaml
- run: npx forkui@latest release ${{ github.sha }}
  env: { FORKUI_URL: ${{ secrets.FORKUI_URL }}, FORKUI_SECRET: ${{ secrets.FORKUI_SECRET }} }
```
Run it **after** your backend deploy. It:
1. Uploads `HEAD` as a git bundle.
2. Publishes it as a base release.
3. For every customer: rebases, verifies, rebuilds and republishes.
4. Prints a table of the results.

It exits non-zero only on infrastructure errors. A pinned customer is an expected outcome, not an error.

It's **safe to re-run** (e.g. a CI retry):
- An already-published commit isn't uploaded again, and the rollout just runs again: up-to-date customers are a no-op, and pinned ones are retried.
- Only commits the server doesn't already have are uploaded.
- Publishing a commit the server already has under a new name uploads nothing.
- A version name is never reused for a different commit.

Customers are rolled out in parallel.

**The first release:**
- A fresh forkui server is empty. Customers can't customize, and the editor says so, until the first `forkui release`.
- `forkui dev` publishes your current commit automatically.
- `forkui doctor` warns if no base release exists.

## CLI
| Command | |
|---|---|
| `forkui init [--model p:m] [--escalate p:m] [--yes] [--no-install]` | Set up the repo. Idempotent. |
| `forkui dev [--port 4400]` | Local forkui server. Data and secret live in `.forkui/`. |
| `forkui release [version] [--url]` | Publish HEAD and roll out to all customers. |
| `forkui doctor [--no-checks] [--url]` | Readiness checks. |
| `forkui tenants [--url]` | Customers, their base, and their status (live, standard, pinned). |
| `forkui uninstall` | Reverse `init` exactly. |

## Server HTTP API
Server-to-server routes need the `x-forkui-key: <FORKUI_SECRET>` header.
| Route | |
|---|---|
| `GET /v1/tenants/:t/release` | Current release manifest (404 = no fork). |
| `GET /v1/releases/:id` | A release manifest. |
| `GET /v1/blobs/:sha256` | A release file. |
| `POST /v1/bases?version=&ref=[&sha=]` (body: a git bundle, or empty with `sha` for a commit the server has) | Publish a base release. Returns 201 if new, 200 if the same commit was already published, 409 if the version belongs to another commit. |
| `POST /v1/rollouts {version}` | Start a rollout; returns a job. |
| `GET /v1/bases` | Published base releases (version, sha, date). |
| `GET /v1/jobs/:id` | Job status, log and result. |
| `GET /v1/tenants` | All customers. |

Editor routes need `Authorization: Bearer <editor token>`, minted by `/_forkui/token`. The token is scoped to one tenant.
| Route | |
|---|---|
| `GET /v1/me` | This customer: base, live release, pin, customizations, recent jobs. |
| `GET /v1/me/features` | All features: id, title, status (`draft`, `building`, `preview`, `live`, `off`, `paused`), and the last message. |
| `POST /v1/me/features {text}` | Start a feature with its first message. Returns `{featureId, jobId}`. |
| `GET /v1/me/features/:id` | A feature: its status, conversation, and the customer's pending change. |
| `POST /v1/me/features/:id/messages {text}` | Chat in a feature. The assistant replies or proposes the feature's complete (new) definition. |
| `POST /v1/me/features/:id/build {messageId}` | Build a proposal: a new feature, a new version of a live one, or a replacement for its preview. |
| `POST /v1/me/features/:id/publish` · `/discard` | Publish or discard the feature's unpublished version. |
| `DELETE /v1/me/features/:id` | Delete a draft (refused once built). |
| `GET /v1/me/preview-grant` | A fresh preview grant for the pending change. |
| `POST /v1/me/edits {title, request, spec?}` | Make a change. The job's result is a *preview* release. |
| `GET /v1/me/jobs/:id` | Job progress. |
| `POST /v1/me/releases/:id/publish` | Make a preview live. Refused (409) if it's out of date. |
| `POST /v1/me/edits/:jobId/discard` | Undo an unpublished change. |
| `POST /v1/me/unpublish` | Switch everyone in this customer back to the standard app. |

`GET /editor` serves the editor UI, with `frame-ancestors` restricted to `appOrigins`.
