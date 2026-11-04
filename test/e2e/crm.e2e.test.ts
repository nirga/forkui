import { describe, expect, test } from 'vitest';
import { cpSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultModelResolver } from '@forkui/agent';
import { GitStore } from '@forkui/git';
import { DependencyCache, LocalDriver } from '@forkui/sandbox';
import { editTenant, rebaseTenant, type EditReport, type EngineDeps, type RebaseReport } from '@forkui/engine';
import { tmp, vendorRepo } from '../helpers.ts';

try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'));
} catch {
  /* no .env */
}
const MODEL = process.env.FORKUI_E2E_MODEL ?? 'anthropic:claude-sonnet-5-5';
const RUN_MODEL = !!process.env.FORKUI_E2E_MODEL;
const ESCALATE = process.env.FORKUI_E2E_ESCALATE ?? null;
const EXAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), '../../examples/crm');
const RESULTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../.forkui-data/e2e-results.json');

const edits = [
  {
    tenantId: 'tenant-a',
    intentId: 'a1',
    title: 'Add Priority column to deals table',
    request: "Show each deal's priority as a column in the deals table, right after Stage. Color high priority red, medium orange, low gray.",
    spec: "The deals table has a Priority column immediately after the Stage column. Each row shows the deal's priority (high / medium / low). High priority is shown in red (#d92d20).",
  },
  {
    tenantId: 'tenant-b',
    intentId: 'b1',
    title: 'Dark dashboard with win rate',
    request: 'Make the dashboard dark, make the open-pipeline card a wide purple hero card, and add a Win rate card.',
    spec: 'The dashboard summary has a dark theme. The "Open pipeline" card is visually emphasized as a hero card. There is a "Win rate" card showing won / (won + lost) as a whole percentage; with the fixture data it shows 50%.',
  },
  {
    tenantId: 'tenant-b',
    intentId: 'b2',
    title: 'Add Pipeline kanban tab',
    request: 'Add a Pipeline tab next to Overview that shows open and won deals as kanban columns by stage, each with a count. Hide lost deals.',
    spec: 'There are two tabs, "Overview" and "Pipeline". Overview shows the existing dashboard and deals table. Pipeline shows one column per stage for lead, qualified, proposal and won, each labeled with the stage name and its deal count, listing the deals in that stage. Lost deals are not shown on the Pipeline tab.',
  },
];

function release(dir: string, version: 'v1' | 'v2') {
  const src = join(EXAMPLE, version);
  for (const entry of ['src', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', '.gitignore']) {
    rmSync(join(dir, entry), { recursive: true, force: true });
    cpSync(join(src, entry), join(dir, entry), { recursive: true });
  }
  const config = JSON.parse(readFileSync(join(src, 'forkui.config.json'), 'utf8'));
  config.agent = { ...config.agent, model: MODEL, escalateTo: ESCALATE };
  writeFileSync(join(dir, 'forkui.config.json'), JSON.stringify(config, null, 2));
}

const summarize = (r: EditReport | RebaseReport) => ({
  ...r,
  attempts: r.attempts.map((a) => ({
    by: a.by,
    ok: a.verification.ok,
    problems: a.verification.problems,
    agent: a.agent && {
      outcome: a.agent.outcome,
      steps: a.agent.steps,
      usage: a.agent.usage,
      durationMs: a.agent.durationMs,
      toolCalls: a.agent.toolCalls.length,
    },
  })),
});

describe.skipIf(!RUN_MODEL)(`CRM end-to-end with ${MODEL}`, () => {
  test('tenant edits on v1 survive the breaking v2 release', { timeout: 60 * 60_000 }, async () => {
    const t = tmp('e2e');
    const vendor = vendorRepo(join(t.dir, 'vendor'));
    release(vendor.dir, 'v1');
    vendor.commit({}, 'Acme CRM v1');
    const store = await GitStore.init(join(t.dir, 'store'));
    await store.importBase(vendor.dir, 'refs/heads/main', 'v1');
    const driver = new LocalDriver({ envAllow: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'npm_config_cache'] });
    const deps: EngineDeps = {
      store,
      driver,
      deps: new DependencyCache(join(t.dir, 'deps'), driver),
      resolveModel: defaultModelResolver,
      onEvent: (e) => {
        if (e.type === 'phase') console.log(`[${e.tenantId}] ${e.phase}${e.detail ? ` (${e.detail})` : ''}`);
        if (e.type === 'tool' && !e.event.ok) console.log(`[${e.tenantId}]   ${e.event.tool}: ${e.event.note}`);
      },
    };
    const results: Record<string, unknown> = { model: MODEL, escalate: ESCALATE, edits: [], rebases: [] };

    for (const id of new Set(edits.map((e) => e.tenantId))) await store.createTenant(id, 'v1');
    for (const e of edits) {
      const r = await editTenant(deps, e);
      (results.edits as unknown[]).push(summarize(r));
      expect(r.outcome, `${e.intentId}: ${r.reason}`).toBe('committed');
    }

    release(vendor.dir, 'v2');
    vendor.commit({}, 'Acme CRM v2: DealTable, status, v2 API, StatCard, search');
    await store.importBase(vendor.dir, 'refs/heads/main', 'v2');

    for (const tenantId of ['tenant-a', 'tenant-b']) {
      const r = await rebaseTenant(deps, tenantId, 'v2');
      (results.rebases as unknown[]).push(summarize(r));
      console.log(`[${tenantId}] => ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`);
      expect(['clean', 'resolved', 'pinned']).toContain(r.outcome);
      if (r.outcome !== 'pinned') expect((await store.tenantBase(tenantId)).version).toBe('v2');
    }
    mkdirSync(dirname(RESULTS), { recursive: true });
    writeFileSync(RESULTS, JSON.stringify(results, null, 2));
    console.log(`results: ${RESULTS}`);
    t.cleanup();
  });
});

describe('CRM pipeline smoke (no model)', () => {
  test('real npm install + typecheck/test/build via the dependency cache; clean rebase v1 -> v2', { timeout: 10 * 60_000 }, async () => {
    const t = tmp('smoke');
    const vendor = vendorRepo(join(t.dir, 'vendor'));
    release(vendor.dir, 'v1');
    vendor.commit({}, 'v1');
    const store = await GitStore.init(join(t.dir, 'store'));
    await store.importBase(vendor.dir, 'refs/heads/main', 'v1');
    await store.createTenant('plain', 'v1');
    release(vendor.dir, 'v2');
    vendor.commit({}, 'v2');
    await store.importBase(vendor.dir, 'refs/heads/main', 'v2');
    const driver = new LocalDriver({ envAllow: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'npm_config_cache'] });
    const deps: EngineDeps = {
      store,
      driver,
      deps: new DependencyCache(join(t.dir, 'deps'), driver),
      resolveModel: () => {
        throw new Error('no model expected');
      },
    };
    const r = await rebaseTenant(deps, 'plain', 'v2');
    expect(r.outcome, JSON.stringify(r.attempts[0]?.verification.problems)).toBe('clean');
    expect(r.attempts[0]!.verification.checks.map((c) => [c.name, c.ok])).toEqual([
      ['typecheck', true],
      ['test', true],
      ['build', true],
    ]);
    t.cleanup();
  });
});
