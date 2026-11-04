# Concepts

forkui gives every customer ("tenant") of a B2B product **their own git branch of the vendor's real frontend**. An AI agent edits that branch for them. When the vendor ships, forkui carries every branch onto the new version and verifies it before anyone sees it.

## Vocabulary
- **Base release:** a vendor version, stored as the tag `base/<version>`. Created by `forkui release`.
- **Tenant branch:** `tenants/<id>`, the customer's customizations on top of a base release.
- **Intent:** one customer change, stored as one commit. It records what the customer asked for in commit trailers (`Forkui-Intent-Id`, `Forkui-Intent`, `Forkui-Spec`, `Forkui-Test`).
- **Spec:** "when is it done", in plain language, written by the customer admin. It is frozen once committed.
- **Acceptance test:** the agent compiles the spec into a test. It must **fail on the code before the change and pass after**, which proves it actually tests the change. It is frozen once committed.
- **Release:** a built, content-addressed copy of a tenant commit. It is a *preview* until published, then *live*.
- **Pinned:** a customer whose changes couldn't be carried onto the new base. They keep their last live release and get a plain-language reason.

## Features
Customers see their customizations as **features**. Each feature has its own conversation, shared by that customer's admins, and a status:

| Status | Meaning |
|---|---|
| Draft | Discussed but not built yet |
| Building | The agent is working on it |
| Preview | Built but not published; only the admin previewing it can see it |
| Live | Everyone at the customer sees it |
| Not live | Built, but the customer switched back to the standard app |
| Paused | A vendor release couldn't carry it over yet |

Chatting inside a live feature produces a **new version** of it, and the old version stays live until the new one is published.

## The lifecycle
1. **Edit:**
   1. The admin chats with the assistant, which proposes the change and its "done when" criteria. The admin approves it with **Build it**.
   2. The agent changes the code and writes the test.
   3. forkui verifies the result: policy, your checks, and the new test failing on the old code.
   4. It builds a preview, which the admin can view privately, then publish or discard. Follow-up messages revise the same change, and there's only ever one unpublished change per customer.
2. **Release:**
   1. The vendor runs `forkui release`.
   2. For each customer, forkui tries a plain `git rebase`, then the agent (primary model, then the escalation model). The agent resolves conflicts and adapts the change to your new code.
   3. forkui verifies the result itself.
   4. On success, it rebuilds and republishes the customer, if they were live. Otherwise the customer is pinned.
3. **Serve:** your app's middleware serves each customer's live release, and your normal deploy for everyone else.

## Who's trusted with what
- **Verification is the harness's, not the agent's.** Whatever the agent reports, a change is accepted only if:
  - policy passes
  - every check passes
  - there is exactly one commit per intent
  - the specs and tests are byte-identical to the frozen originals
- **The agent has no shell.** It gets named tools: list, read, search, write, edit, delete, read-only git, run checks, continue rebase, amend intent, finish, pin. Writes to locked, vendor-owned or frozen paths are refused as they happen.
- **Branches only move by compare-and-swap.** A customer edit can't be lost to a concurrent rollout.

See [architecture](ARCHITECTURE.md) for how the packages fit together and [security](security.md) for the threat model.

## How the backend stores it
**Git is the source of truth for everything built.** A feature *is* an intent id (`f1`, `f2`…), and its versions are the commits on the customer's branch that carry that id:

```
base/v1 ── f1 "Priority column" ── f2 "Win rate card" ── f1 "Priority and Owner columns"   ← tenants/acme
                                                          ▲ a revision: same id, new commit on top
```

| Kept where | What |
|---|---|
| **git** (`store/repo.git`) | Base releases are tags. Each customer's branch holds its features as commits. Every commit has trailers (feature id, request, spec path, test path), a spec file (`forkui-tests/<id>.spec.md`) and a test file (`forkui-tests/<id>.spec.tsx`). |
| **Release store** (`artifacts/`) | Built releases, as content-addressed blobs plus a manifest (`URL path → sha256`). Each release records the commit it was built from. |
| **Customer state** (`state/tenants/<t>.json`) | `current`: the live release. `pending`: the one unpublished change, which is always the top commit. `pinned`: the reason, after a rollout it couldn't complete. |
| **Feature records** (`state/features/<t>/<id>.json`) | Only the conversation (messages, proposals, build references) and a draft title. Nothing about what's built. |

**Status is computed, never stored.** A feature is:
- **Building** while an edit job for it runs.
- **Preview** if it's the pending change.
- **Live** if one of its commits is an ancestor of the live release's commit.
- **Not live** or **Paused** if it's built but not live.
- **Draft** if it has no commits yet.

**The rules that keep it safe:**
- **One unpublished change per customer.** Building another feature while one waits is refused.
  - A new version of the *same* feature replaces its preview: the old preview commit is dropped (compare-and-swap) and rebuilt.
- **Publish** points `current` at the pending release. It's only allowed when that release was built from the branch's current head.
- **Discard** moves the branch back one commit, from the pending commit to its parent. A revision's discard leaves the earlier version live.
- **A rollout rebases the whole branch** (all features, all versions), then:
  - republishes `head^` for live customers, or `head` if nothing is pending
  - rebuilds the pending change as a fresh preview; it is never published automatically
- **The assistant (planner) can't see or change code.** It only replies or proposes a feature's full definition (title, request, "done when" criteria). The coding agent works only in a sandboxed worktree, and the harness verifies everything before the branch moves.
