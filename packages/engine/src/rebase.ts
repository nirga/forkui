import { AGENT_INSTRUCTIONS, createTools, rebasePrompt, runAgent } from '@forkui/agent';
import { refs } from '@forkui/core';
import type { RebaseState, Worktree } from '@forkui/git';
import type { Sandbox } from '@forkui/sandbox';
import type { Attempt, EngineDeps, RebaseReport } from './types.ts';
import { verify } from './verify.ts';

function describeState(s: RebaseState): string {
  if (s.status === 'done') return 'The rebase applied without textual conflicts, but the result has not been verified yet. Run the checks and fix anything that is broken.';
  return `A rebase onto the new base is IN PROGRESS and stopped with conflicts while applying "${s.stoppedAt.subject}". Conflicted files: ${s.files.join(', ')}.`;
}

/**
 * Move a tenant branch to a new base release:
 *   1. plain git rebase; if it verifies, done ("clean")
 *   2. otherwise an agent resolves it (primary model, then the escalation model)
 *   3. if nothing verifies, the tenant stays on its current head ("pinned") with a readable reason.
 * The tenant branch only moves via compare-and-swap after the harness verifies the result.
 */
export async function rebaseTenant(d: EngineDeps, tenantId: string, toVersion: string): Promise<RebaseReport> {
  const { store } = d;
  const phase = (p: string, detail?: string) => d.onEvent?.({ type: 'phase', tenantId, phase: p, ...(detail ? { detail } : {}) });
  const previousHead = await store.tenantHead(tenantId);
  const from = await store.tenantBase(tenantId, previousHead);
  const base = (await store.listBases()).find((b) => b.version === toVersion);
  if (!base) throw new Error(`Unknown base release ${toVersion}`);
  const report: RebaseReport = { tenantId, from: from.version, to: toVersion, outcome: 'pinned', previousHead, attempts: [] };
  if (from.version === toVersion) return { ...report, outcome: 'up-to-date' };

  const config = await store.readConfig(toVersion); // policy always comes from the base
  const ontoRef = refs.base(toVersion);
  const intents = await store.listIntents(tenantId, previousHead);
  const expectedIntents = intents.map((i) => i.trailers?.intentId ?? `(untagged ${i.sha.slice(0, 8)})`);

  const wt = await store.worktree(previousHead, `rebase-${tenantId}`);
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await d.driver.open(wt.path);
    phase('git-rebase');
    let state = await wt.rebase(ontoRef);
    await d.deps.link(sandbox, config);

    const record = (a: Attempt) => {
      report.attempts.push(a);
      d.onEvent?.({ type: 'attempt', tenantId, attempt: a });
    };
    const accept = async (outcome: 'clean' | 'resolved') => {
      const head = await wt.head();
      await store.updateTenant(tenantId, head, previousHead);
      phase('accepted', outcome);
      return { ...report, outcome, head };
    };
    const verifyNow = () =>
      verify({ worktree: wt, sandbox: sandbox!, config, baseRef: ontoRef, previousTenantRef: previousHead, expectedIntents });

    if (state.status === 'done') {
      phase('verify', 'git');
      const v = await verifyNow();
      record({ by: 'git', verification: v });
      if (v.ok) return await accept('clean');
    } else {
      record({ by: 'git', verification: { ok: false, problems: [`Conflicts in ${state.files.join(', ')}`], violations: [], checks: [] } });
    }

    const vendorChanges = (
      await wt.git(['log', '--format=- %s', `${refs.base(from.version)}..${ontoRef}`])
    ).stdout.trim() + '\n\n' + (await wt.git(['diff', '--stat', refs.base(from.version), ontoRef])).stdout.trim();

    const models = [config.agent.model, config.agent.escalateTo].filter((m): m is string => !!m);
    let lastReason = 'The customization could not be carried over automatically.';
    for (const [i, spec] of models.entries()) {
      if (i > 0) state = await restart(wt, previousHead, ontoRef);
      phase('agent', spec);
      const model = await d.resolveModel(spec);
      const { tools, outcome } = createTools({
        sandbox,
        worktree: wt,
        config,
        mode: 'rebase',
        ontoRef,
        onEvent: (event) => d.onEvent?.({ type: 'tool', tenantId, model: spec, event }),
      });
      const run = await runAgent({
        model,
        instructions: AGENT_INSTRUCTIONS,
        prompt: rebasePrompt({ tenantId, fromVersion: from.version, toVersion, intents, vendorChanges, state: describeState(state) }),
        tools,
        outcome,
        maxSteps: config.agent.maxSteps,
      });
      phase('verify', spec);
      const v = await verifyNow();
      record({ by: spec, agent: run, verification: v });
      if (v.ok && run.outcome?.kind !== 'pinned') return await accept('resolved');
      lastReason = run.outcome?.kind === 'pinned' ? run.outcome.reason : `Automatic carry-over failed verification: ${v.problems.slice(0, 3).join(' ')}`;
    }
    phase('pinned');
    return { ...report, outcome: 'pinned', reason: lastReason };
  } finally {
    await sandbox?.dispose();
    await wt.abortRebase().catch(() => {});
    await wt.dispose();
  }
}

/** Reset the worktree to the tenant's previous head and start the rebase over. */
async function restart(wt: Worktree, previousHead: string, ontoRef: string): Promise<RebaseState> {
  await wt.resetTo(previousHead);
  return wt.rebase(ontoRef);
}
