import type { IntentCommit } from '@forkui/git';

const RULES = `Rules:
- You have no shell. Use the provided tools. Paths are relative to the repo root.
- Vendor-owned files (test kit, fixtures, contract tests), locked paths and existing tenant specs/tests are protected; write tools will refuse them. Never try to work around a refusal.
- Do not revert, duplicate or bypass the vendor's code. Build on the vendor's current components, types, APIs and helpers.
- Keep changes minimal and focused on the tenant's intents.
- Run run_checks before you finish. Only call finish when every check passes.
- If an intent genuinely cannot be satisfied without changing protected files (e.g. the data it needs no longer exists), call pin with a plain-language explanation for a non-technical customer admin. Do not fake data or hard-code values to make tests pass.`;

export const AGENT_INSTRUCTIONS = `You are forkui's coding agent. You work in a git worktree of a B2B SaaS product's frontend.
The vendor owns the base. Each customer (tenant) has a git branch of customizations on top of a base release; every tenant commit is one "intent" with a natural-language spec and an acceptance test.

${RULES}`;

function describeIntents(intents: IntentCommit[]): string {
  return intents
    .map((c, i) => {
      const t = c.trailers;
      if (!t) return `${i + 1}. (${c.sha.slice(0, 10)}) ${c.subject} — no intent metadata`;
      return [
        `${i + 1}. [${t.intentId}] ${c.subject}`,
        `   intent: ${t.intent}`,
        t.spec ? `   spec: ${t.spec}` : null,
        t.test ? `   acceptance test: ${t.test}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

export function rebasePrompt(o: {
  tenantId: string;
  fromVersion: string;
  toVersion: string;
  intents: IntentCommit[];
  vendorChanges: string;
  state: string;
}): string {
  return `Tenant "${o.tenantId}" is moving from base ${o.fromVersion} to the new vendor release ${o.toVersion}.

Your goal: every tenant intent below must still hold on top of base/${o.toVersion}, while adopting the vendor's new structure.

Tenant intents, oldest first:
${describeIntents(o.intents)}

The acceptance tests encode the intents and are the definition of done. Read each intent's spec (if present) to understand what the customer meant.

What the vendor changed (use the git tool, e.g. ["diff", "base/${o.fromVersion}", "base/${o.toVersion}"], for details):
${o.vendorChanges}

Current state:
${o.state}

How to work:
- While a rebase is in progress: resolve the conflicted files for the commit being applied (port the tenant change onto the vendor's new code), fix anything that commit breaks, then call rebase_continue. Repeat until the rebase completes.
- After the rebase completes, run_checks. If something fails, fix it and use amend_intent to fold the fix into the commit of the intent it belongs to.
- When all checks pass, call finish with one short, non-technical line per intent describing how it was carried over (for the customer admin: no files, code or tests).`;
}

export function editPrompt(o: {
  tenantId: string;
  intentId: string;
  request: string;
  spec: string;
  testPath: string;
  testKitHint: string;
  /** Set when revising an existing feature. */
  previous?: { request: string; spec: string };
}): string {
  const revision = o.previous
    ? `
This REVISES an existing customization (intent ${o.intentId}) that is already in the app. Its previous version was:
  Request: ${o.previous.request}
  Spec: ${o.previous.spec}
Change the app from that version to the new one below. Its acceptance test already exists at ${o.testPath}: update it to check the NEW spec
(keep the parts of the old spec that still apply).
`
    : '';
  return `Tenant "${o.tenantId}" requested a change to their copy of the product.
${revision}
Request: ${o.request}

Approved acceptance spec (natural language; this is the definition of done):
${o.spec}

Do two things:
1. Implement the change in the app.
2. ${o.previous ? 'Update' : 'Write'} the acceptance test at ${o.testPath} so it checks the spec, and only the spec. ${o.testKitHint}
   Prefer stable, user-facing selectors (roles, labels, data-forkui-id) over layout details or exact styling, so the test survives harmless vendor refactors.

The test must fail without your change and pass with it. Run run_checks, then call finish.
The finish summary is shown to the customer admin, who is not technical: one or two plain sentences about what they will see
in the app. Never mention files, code, components, tests, checks or builds.
Intent id: ${o.intentId}`;
}
