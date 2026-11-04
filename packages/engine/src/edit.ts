import { AGENT_INSTRUCTIONS, createTools, editPrompt, runAgent } from '@forkui/agent';
import { isValidIntentId, refs } from '@forkui/core';
import type { Attempt, EditReport, EditRequest, EngineDeps } from './types.ts';
import { runTestFile, verify } from './verify.ts';

/**
 * Apply one tenant request as a new intent commit:
 * the harness writes the frozen spec, the agent implements the change and compiles the spec into a test,
 * and the harness accepts it only if all checks pass AND the new test fails on the previous code.
 */
export async function editTenant(d: EngineDeps, req: EditRequest): Promise<EditReport> {
  const { store } = d;
  const { tenantId, intentId } = req;
  if (!isValidIntentId(intentId)) throw new Error(`Invalid intent id ${intentId}`);
  const phase = (p: string, detail?: string) => d.onEvent?.({ type: 'phase', tenantId, phase: p, ...(detail ? { detail } : {}) });

  const previousHead = await store.tenantHead(tenantId);
  const base = await store.tenantBase(tenantId, previousHead);
  const existing = await store.listIntents(tenantId, previousHead);
  const exists = existing.some((i) => i.trailers?.intentId === intentId);
  if (exists && !req.revise) throw new Error(`Intent ${intentId} already exists for ${tenantId}`);
  if (!exists && req.revise) throw new Error(`Intent ${intentId} does not exist yet for ${tenantId}; nothing to revise`);
  const config = await store.readConfig(base.version);
  const dir = config.paths.tenantTests.replace(/\/+$/, '');
  const specPath = `${dir}/${intentId}.spec.md`;
  const testPath = `${dir}/${intentId}${config.testKit.extension}`;
  const report: EditReport = { tenantId, intentId, outcome: 'rejected', previousHead, attempts: [] };

  const wt = await store.worktree(previousHead, `edit-${tenantId}`);
  const sandbox = await d.driver.open(wt.path);
  try {
    await d.deps.link(sandbox, config);
    const models = [config.agent.model, config.agent.escalateTo].filter((m): m is string => !!m);
    for (const [i, spec] of models.entries()) {
      if (i > 0) {
        await wt.resetTo(previousHead);
      }
      await sandbox.writeFile(specPath, req.spec.trim() + '\n');
      phase('agent', spec);
      const { tools, outcome } = createTools({
        sandbox,
        worktree: wt,
        config,
        mode: 'edit',
        writableTenantTests: [testPath],
        onEvent: (event) => d.onEvent?.({ type: 'tool', tenantId, model: spec, event }),
      });
      const run = await runAgent({
        model: await d.resolveModel(spec),
        instructions: AGENT_INSTRUCTIONS,
        prompt: editPrompt({
          tenantId,
          intentId,
          request: req.request,
          spec: req.spec,
          testPath,
          testKitHint: config.testKit.guidance,
          ...(req.revise ? { previous: req.revise.previous } : {}),
        }),
        tools,
        outcome,
        maxSteps: config.agent.maxSteps,
      });
      if (run.outcome?.kind === 'pinned') {
        report.attempts.push({ by: spec, agent: run, verification: { ok: false, problems: ['Agent declined'], violations: [], checks: [] } });
        return { ...report, outcome: 'pinned', reason: run.outcome.reason };
      }

      phase('verify', spec);
      const problems: string[] = [];
      if ((await sandbox.readFile(testPath)) === null) problems.push(`The acceptance test ${testPath} was not written.`);
      // Commit first so verify() sees a clean tree and the right intent list.
      await wt.git(['add', '-A']);
      const staged = (await wt.git(['diff', '--cached', '--name-only'])).stdout.split('\n').filter(Boolean);
      if (!staged.some((f) => f !== specPath && f !== testPath)) {
        const attempt: Attempt = {
          by: spec,
          agent: run,
          verification: { ok: false, problems: ['The agent did not change the app.', ...problems], violations: [], checks: [] },
        };
        report.attempts.push(attempt);
        d.onEvent?.({ type: 'attempt', tenantId, attempt });
        await wt.resetTo(previousHead);
        continue;
      }
      const sha = await wt.commitIntent(
        req.title,
        { intentId, intent: req.request, spec: specPath, test: testPath },
        req.author ? { author: req.author } : {},
      );
      const v = await verify({
        worktree: wt,
        sandbox,
        config,
        baseRef: refs.base(base.version),
        previousTenantRef: previousHead,
        approvedTestChanges: [specPath, testPath],
        expectedIntents: [...existing.map((e) => e.trailers?.intentId ?? `(untagged ${e.sha.slice(0, 8)})`), intentId],
      });
      // The new test must detect the change: it has to FAIL on the previous code.
      if (problems.length === 0) {
        const probe = await store.worktree(previousHead, `probe-${tenantId}`);
        const probeBox = await d.driver.open(probe.path);
        try {
          await d.deps.link(probeBox, config);
          await probeBox.writeFile(testPath, (await sandbox.readFile(testPath))!);
          const r = await runTestFile(probeBox, config, testPath);
          if (r.code === 0) problems.push(`The acceptance test passes even without the change, so it does not test the request.`);
        } finally {
          await probeBox.dispose();
          await probe.dispose();
        }
      }
      const verification = { ...v, ok: v.ok && problems.length === 0, problems: [...problems, ...v.problems] };
      const attempt: Attempt = { by: spec, agent: run, verification };
      report.attempts.push(attempt);
      d.onEvent?.({ type: 'attempt', tenantId, attempt });
      if (verification.ok) {
        await store.updateTenant(tenantId, sha, previousHead);
        phase('accepted');
        return { ...report, outcome: 'committed', head: sha };
      }
      await wt.resetTo(previousHead);
    }
    const last = report.attempts.at(-1)?.verification.problems ?? [];
    return { ...report, outcome: 'rejected', reason: `The change could not be verified: ${last.slice(0, 3).join(' ')}` };
  } finally {
    await sandbox.dispose();
    await wt.dispose();
  }
}
