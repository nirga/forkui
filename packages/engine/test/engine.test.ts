import { afterEach, describe, expect, test } from 'vitest';
import { refs } from '@forkui/core';
import { editTenant, rebaseTenant } from '../src/index.ts';
import { engineDeps, priorityTestStable, priorityTestV1, scriptedModel, setupStore, v2 } from './fixture.ts';

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

async function withTenant(testContent: string) {
  const s = await setupStore();
  cleanups.push(s.t.cleanup);
  await s.store.createTenant('acme', 'v1');
  // Tenant intent a1: Priority column after Stage, made via the edit job with a scripted agent.
  const edit = scriptedModel('primary', [
    { tool: 'read_file', input: { path: 'src/table.mjs' } },
    { tool: 'write_file', input: { path: 'src/table.mjs', content: "export const columns = ['Name', 'Stage', 'Priority', 'Amount'];\n" } },
    { tool: 'write_file', input: { path: 'forkui-tests/a1.spec.mjs', content: testContent } },
    { tool: 'run_checks', input: {} },
    { tool: 'finish', input: { summary: 'Added Priority after Stage.' } },
  ]);
  const { deps } = engineDeps(s.store, s.t.dir, { 'mock:primary': edit });
  const r = await editTenant(deps, {
    tenantId: 'acme',
    intentId: 'a1',
    title: 'Add Priority column',
    request: 'Show priority right after stage',
    spec: 'The deals table has a Priority column immediately after the Stage column.',
  });
  expect(r.outcome, JSON.stringify(r.attempts.map((a) => a.verification.problems))).toBe('committed');
  return s;
}

describe('editTenant', () => {
  test('commits a verified intent with trailers, spec and test', async () => {
    const s = await withTenant(priorityTestV1);
    const intents = await s.store.listIntents('acme');
    expect(intents).toHaveLength(1);
    expect(intents[0]!.trailers).toEqual({
      intentId: 'a1',
      intent: 'Show priority right after stage',
      spec: 'forkui-tests/a1.spec.md',
      test: 'forkui-tests/a1.spec.mjs',
    });
    expect(await s.store.readFile(refs.tenant('acme'), 'forkui-tests/a1.spec.md')).toContain('immediately after the Stage');
  });

  test('rejects a test that passes without the change, and leaves the tenant untouched', async () => {
    const s = await setupStore();
    cleanups.push(s.t.cleanup);
    const { sha } = await s.store.createTenant('acme', 'v1');
    const lazy = (name: string) =>
      scriptedModel(name, [
        { tool: 'write_file', input: { path: 'src/table.mjs', content: "export const columns = ['Name', 'Stage', 'Priority', 'Amount'];\n" } },
        { tool: 'write_file', input: { path: 'forkui-tests/a1.spec.mjs', content: "import assert from 'node:assert';\nassert.ok(true);\n" } },
        { tool: 'finish', input: { summary: 'done' } },
      ]);
    const { deps } = engineDeps(s.store, s.t.dir, { 'mock:primary': lazy('p'), 'mock:escalation': lazy('e') });
    const r = await editTenant(deps, { tenantId: 'acme', intentId: 'a1', title: 'x', request: 'x', spec: 'x' });
    expect(r.outcome).toBe('rejected');
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]!.verification.problems[0]).toMatch(/passes even without the change/);
    expect(await s.store.tenantHead('acme')).toBe(sha);
  });

  test('write tools refuse vendor-owned and locked paths', async () => {
    const s = await setupStore();
    cleanups.push(s.t.cleanup);
    await s.store.createTenant('acme', 'v1');
    const m = scriptedModel('p', [
      { tool: 'write_file', input: { path: 'src/__tests__/table.test.mjs', content: 'process.exit(0)' } },
      { tool: 'write_file', input: { path: '../../escape.txt', content: 'x' } },
      { tool: 'git', input: { args: ['diff', '--no-index', '/etc/hosts', '/dev/null'] } },
      { tool: 'git', input: { args: ['push', 'origin'] } },
      { tool: 'pin', input: { reason: 'Cannot do it' } },
    ]);
    const { deps, events } = engineDeps(s.store, s.t.dir, { 'mock:primary': m });
    const r = await editTenant(deps, { tenantId: 'acme', intentId: 'a1', title: 'x', request: 'x', spec: 'x' });
    expect(r.outcome).toBe('pinned');
    const refused = events.flatMap((e) => (e.type === 'tool' && !e.event.ok ? [e.event.note] : []));
    expect(refused).toEqual([expect.stringMatching(/owned by the vendor/), expect.stringMatching(/relative to the repo root/)]);
    const gitCalls = m.doGenerateCalls.length; // model saw each refusal as a tool result
    expect(gitCalls).toBe(5);
  });

  test('an agent that changes nothing is rejected, not a crash', async () => {
    const s = await setupStore();
    cleanups.push(s.t.cleanup);
    const { sha } = await s.store.createTenant('acme', 'v1');
    const idle = (n: string) => scriptedModel(n, [{ tool: 'finish', input: { summary: 'nothing to do' } }]);
    const { deps } = engineDeps(s.store, s.t.dir, { 'mock:primary': idle('p'), 'mock:escalation': idle('e') });
    const r = await editTenant(deps, { tenantId: 'acme', intentId: 'a1', title: 'x', request: 'x', spec: 'x' });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toMatch(/did not change the app/);
    expect(await s.store.tenantHead('acme')).toBe(sha);
  });
});

describe('rebaseTenant', () => {
  test('clean: no conflicts and checks pass -> moves without any model', async () => {
    const s = await setupStore();
    cleanups.push(s.t.cleanup);
    await s.store.createTenant('acme', 'v1');
    s.vendor.commit({ 'src/footer.mjs': 'export const footer = 1;\n' }, 'v2');
    await s.store.importBase(s.vendor.dir, 'refs/heads/main', 'v2');
    const { deps } = engineDeps(s.store, s.t.dir, {});
    const r = await rebaseTenant(deps, 'acme', 'v2');
    expect(r.outcome).toBe('clean');
    expect((await s.store.tenantBase('acme')).version).toBe('v2');
  });

  test('conflict resolved by the agent, verified, then the branch moves', async () => {
    const s = await withTenant(priorityTestStable);
    s.vendor.commit(v2, 'v2: move table, Stage -> Status', ['src/table.mjs']);
    await s.store.importBase(s.vendor.dir, 'refs/heads/main', 'v2');
    const agent = scriptedModel('primary', [
      { tool: 'git', input: { args: ['status', '--short'] } },
      { tool: 'delete_file', input: { path: 'src/table.mjs' } },
      { tool: 'write_file', input: { path: 'src/deals/dealTable.mjs', content: "export const dealColumns = ['Name', 'Status', 'Priority', 'Amount'];\n" } },
      { tool: 'rebase_continue', input: {} },
      { tool: 'run_checks', input: {} },
      { tool: 'finish', input: { summary: 'a1: Priority now follows Status in DealTable.' } },
    ]);
    const { deps } = engineDeps(s.store, s.t.dir, { 'mock:primary': agent });
    const before = await s.store.tenantHead('acme');
    const r = await rebaseTenant(deps, 'acme', 'v2');
    expect(r.outcome, JSON.stringify(r.attempts.map((a) => a.verification.problems))).toBe('resolved');
    expect(r.attempts.map((a) => a.by)).toEqual(['git', 'mock:primary']);
    expect(r.head).not.toBe(before);
    expect((await s.store.tenantBase('acme')).version).toBe('v2');
    expect((await s.store.listIntents('acme')).map((i) => i.trailers?.intentId)).toEqual(['a1']);
    expect(await s.store.readFile(refs.tenant('acme'), 'src/table.mjs')).toBeNull();
  });

  test('frozen tenant test cannot be edited; failing verification escalates, then pins without moving', async () => {
    const s = await withTenant(priorityTestV1); // this test imports src/table.mjs, which v2 deletes
    s.vendor.commit(v2, 'v2', ['src/table.mjs']);
    await s.store.importBase(s.vendor.dir, 'refs/heads/main', 'v2');
    const cheat = (name: string) =>
      scriptedModel(name, [
        { tool: 'write_file', input: { path: 'forkui-tests/a1.spec.mjs', content: 'process.exit(0)' } },
        { tool: 'delete_file', input: { path: 'src/table.mjs' } },
        { tool: 'write_file', input: { path: 'src/deals/dealTable.mjs', content: "export const dealColumns = ['Name', 'Status', 'Priority', 'Amount'];\n" } },
        { tool: 'rebase_continue', input: {} },
        { tool: 'finish', input: { summary: 'done' } },
      ]);
    const { deps, events } = engineDeps(s.store, s.t.dir, { 'mock:primary': cheat('p'), 'mock:escalation': cheat('e') });
    const before = await s.store.tenantHead('acme');
    const r = await rebaseTenant(deps, 'acme', 'v2');
    expect(r.outcome).toBe('pinned');
    expect(r.attempts.map((a) => a.by)).toEqual(['git', 'mock:primary', 'mock:escalation']);
    expect(r.attempts[1]!.verification.problems.join('\n')).toMatch(/Check "test" failed/);
    expect(events.some((e) => e.type === 'tool' && !e.event.ok && /frozen tenant spec/.test(e.event.note ?? ''))).toBe(true);
    expect(await s.store.tenantHead('acme')).toBe(before);
  });

  test('agent pin is reported with its reason', async () => {
    const s = await withTenant(priorityTestStable);
    s.vendor.commit(v2, 'v2', ['src/table.mjs']);
    await s.store.importBase(s.vendor.dir, 'refs/heads/main', 'v2');
    const pinner = (n: string) => scriptedModel(n, [{ tool: 'pin', input: { reason: 'The vendor removed priority.' } }]);
    const { deps } = engineDeps(s.store, s.t.dir, { 'mock:primary': pinner('p'), 'mock:escalation': pinner('e') });
    const r = await rebaseTenant(deps, 'acme', 'v2');
    expect(r.outcome).toBe('pinned');
    expect(r.reason).toBe('The vendor removed priority.');
  });

  test('up-to-date tenants are a no-op', async () => {
    const s = await setupStore();
    cleanups.push(s.t.cleanup);
    await s.store.createTenant('acme', 'v1');
    const { deps } = engineDeps(s.store, s.t.dir, {});
    expect((await rebaseTenant(deps, 'acme', 'v1')).outcome).toBe('up-to-date');
  });
});
