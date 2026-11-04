import type { ForkuiConfig, IntentTrailers } from '@forkui/core';
import { parseIntentTrailers } from '@forkui/core';
import type { Worktree } from '@forkui/git';
import { checkPolicy } from '@forkui/policy';
import { runChecks, type Sandbox } from '@forkui/sandbox';
import type { Verification } from './types.ts';

export type VerifyInput = {
  worktree: Worktree;
  sandbox: Sandbox;
  config: ForkuiConfig;
  /** The base release ref the result must sit on. */
  baseRef: string;
  /** Tenant head before this job; frozen tenant tests are compared against it. */
  previousTenantRef?: string;
  approvedTestChanges?: string[];
  /** Intent ids that must each appear exactly once, in this order, as commits on top of baseRef. */
  expectedIntents?: string[];
};

/** The harness's own verdict. Nothing the agent reports is trusted. */
export async function verify(v: VerifyInput): Promise<Verification> {
  const problems: string[] = [];
  const { worktree, sandbox, config } = v;

  if (await worktree.rebaseInProgress())
    return { ok: false, problems: ['The rebase was left in progress (unresolved).'], violations: [], checks: [] };
  const onBase = await worktree.git(['merge-base', '--is-ancestor', v.baseRef, 'HEAD'], { allowFail: true });
  if (onBase.code !== 0) problems.push(`HEAD is not on top of ${v.baseRef}.`);

  const dirty = (await worktree.git(['status', '--porcelain', '--untracked-files=all'])).stdout
    .split('\n')
    .filter((l) => l && !/^\?\? node_modules/.test(l) && !l.endsWith(' node_modules'));
  if (dirty.length) problems.push(`Uncommitted changes: ${dirty.slice(0, 10).join('; ')}`);

  let intents: { sha: string; trailers: IntentTrailers | null }[] = [];
  if (v.expectedIntents && onBase.code === 0) {
    const SEP = '\x1e';
    const out = (await worktree.git(['log', '--reverse', '--no-merges', `--format=%H%x1f%B${SEP}`, `${v.baseRef}..HEAD`])).stdout;
    intents = out
      .split(SEP)
      .map((c) => c.replace(/^\n/, ''))
      .filter(Boolean)
      .map((c) => {
        const [sha, body] = c.split('\x1f') as [string, string];
        return { sha, trailers: parseIntentTrailers(body) };
      });
    const got = intents.map((i) => i.trailers?.intentId ?? `(untagged ${i.sha.slice(0, 8)})`);
    if (JSON.stringify(got) !== JSON.stringify(v.expectedIntents))
      problems.push(`Expected one commit per intent [${v.expectedIntents.join(', ')}], found [${got.join(', ')}].`);
    for (const i of intents)
      for (const f of [i.trailers?.spec, i.trailers?.test].filter((x): x is string => !!x))
        if ((await sandbox.readFile(f)) === null) problems.push(`Intent ${i.trailers!.intentId}: ${f} is missing.`);
  }

  const policy = await checkPolicy({
    worktree,
    config,
    baseRef: v.baseRef,
    ...(v.previousTenantRef ? { previousTenantRef: v.previousTenantRef } : {}),
    ...(v.approvedTestChanges ? { approvedTestChanges: v.approvedTestChanges } : {}),
  });
  for (const x of policy.violations) problems.push(`Policy: ${x.message}${x.line ? ` (${x.path}:${x.line})` : ''}`);

  const checks = await runChecks(sandbox, config.checks);
  for (const c of checks) if (!c.ok) problems.push(`Check "${c.name}" failed${c.timedOut ? ' (timed out)' : ''}.`);

  return { ok: problems.length === 0, problems, violations: policy.violations, checks };
}

/** Run one tenant test file. */
export async function runTestFile(sandbox: Sandbox, config: ForkuiConfig, file: string) {
  const cmd = config.testKit.run.map((a) => a.replaceAll('{file}', file));
  return sandbox.exec(cmd, { timeoutMs: 300_000 });
}
