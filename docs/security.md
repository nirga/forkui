# Security model

## What customer code can and can't do
Customer builds are **your code**, modified by an agent and served from **your origin** to that customer's users.

**At runtime (the real enforcement):**
- Customer code calls your API with the end user's own session, so your backend's authorization applies unchanged. A customer build can't see data the user couldn't already see.
- The middleware sends `Content-Security-Policy: connect-src 'self' <network.allowHosts>` on customer HTML, so customer code can't call arbitrary hosts.
- A customer's build is only served to users whose `tenant()` returns that customer.

**Static policy (a guardrail, not a security boundary):**
- locked and vendor-owned paths
- a dependency allowlist; nothing else in `package.json` may change
- flags `eval`, `new Function`, `document.cookie`, inline `<script>`, remote imports, hosts outside the allowlist, and conflict markers

## Agents
- **No shell.** Agents only get guarded tools. The `git` tool allows read-only subcommands and blocks `--no-index`, `--output`, `--ext-diff`, and options that override the git directory.
- **File access goes through the sandbox and is confined to the worktree.** Paths using `..`, absolute paths and symlink escapes are rejected.
- **Checks and builds run with a scrubbed environment.** Provider keys and other secrets never reach them.
- **Nothing the agent says is trusted.** forkui verifies every result itself.

## Sandboxes: read this before production
The included `local` driver runs installs, checks and builds **on the forkui server's host**. It is not an isolation boundary.
- Run the forkui server in its own container or VM, holding only its own secrets.
- Remote drivers (E2B, Daytona…) are planned. The current sandbox contract assumes the worktree is a shared filesystem, and several tools still run `git` on the host (see the architecture doc).

## Tokens
- **Format:** HMAC-SHA256, JWT-shaped tokens signed with `FORKUI_SECRET`.
- **Editor tokens** last 15 minutes and are scoped to one tenant.
- **Preview grants** last 1 hour and are scoped to one tenant and release. They're stored in an `HttpOnly; SameSite=Lax` cookie, and a grant is ignored if presented under another tenant.
- The editor is an iframe on the forkui origin with a strict CSP (`default-src 'none'; script-src 'self'`). Restrict which sites can embed it with `appOrigins`.
- Rotate `FORKUI_SECRET` on both sides together.
