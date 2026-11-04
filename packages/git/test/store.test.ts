import { afterEach, describe, expect, test } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GitStore } from '../src/index.ts';
import { tmp, v1Files, vendorRepo } from '../../../test/helpers.ts';

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

async function setup() {
  const t = tmp('git');
  cleanups.push(t.cleanup);
  const vendor = vendorRepo(join(t.dir, 'vendor'));
  vendor.commit(v1Files, 'v1');
  const store = await GitStore.init(join(t.dir, 'store'));
  await store.importBase(vendor.dir, 'refs/heads/main', 'v1');
  return { store, vendor };
}

describe('GitStore', () => {
  test('imports base releases and refuses duplicates or missing config', async () => {
    const { store, vendor } = await setup();
    expect((await store.listBases()).map((b) => b.version)).toEqual(['v1']);
    expect((await store.readConfig('v1')).paths.locked).toContain('src/auth/**');
    // Re-releasing the same commit is a no-op; reusing a version name for another commit is refused.
    expect(await store.importBase(vendor.dir, 'refs/heads/main', 'v1')).toMatchObject({ version: 'v1', existing: true });
    vendor.commit({ 'src/x.ts': 'export const x = 1;\n' }, 'change');
    await expect(store.importBase(vendor.dir, 'refs/heads/main', 'v1')).rejects.toThrow(/different commit/);
    // A commit the store already has can be tagged without uploading anything.
    const v1sha = (await store.listBases())[0]!.sha;
    expect(await store.hasCommit(v1sha)).toBe(true);
    expect(await store.tagBase(v1sha, 'v1-again')).toMatchObject({ version: 'v1-again', sha: v1sha, existing: false });
    vendor.commit({}, 'drop config', ['forkui.config.json']);
    await expect(store.importBase(vendor.dir, 'refs/heads/main', 'v2')).rejects.toThrow(/no forkui.config.json/);
  });

  test('tenant lifecycle: create, commit intent, list intents', async () => {
    const { store } = await setup();
    await store.createTenant('acme', 'v1');
    await expect(store.createTenant('acme', 'v1')).rejects.toThrow(/already exists/);
    const head0 = await store.tenantHead('acme');

    const wt = await store.worktree('refs/heads/tenants/acme', 'edit');
    writeFileSync(join(wt.path, 'src/Table.tsx'), 'export const Table = () => <table><th>Name</th><th>Stage</th><th>Priority</th></table>;\n');
    const sha = await wt.commitIntent(
      'Add Priority column',
      { intentId: 'a1', intent: 'Show priority after stage', test: 'forkui-tests/a1.spec.tsx' },
      { author: { name: 'Tenant Admin', email: 'admin@acme.test' } },
    );
    await store.updateTenant('acme', sha, head0);
    await wt.dispose();

    const intents = await store.listIntents('acme');
    expect(intents).toHaveLength(1);
    expect(intents[0]!.trailers).toMatchObject({ intentId: 'a1', intent: 'Show priority after stage' });
    expect(intents[0]!.author).toBe('Tenant Admin <admin@acme.test>');
    expect((await store.tenantBase('acme')).version).toBe('v1');
  });

  test('linked node_modules is never committed, even without a vendor .gitignore', async () => {
    const { store } = await setup();
    await store.createTenant('acme', 'v1');
    const wt = await store.worktree('refs/heads/tenants/acme');
    const { symlinkSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(wt.path, '..', 'fake-modules'), { recursive: true });
    symlinkSync(join(wt.path, '..', 'fake-modules'), join(wt.path, 'node_modules'));
    writeFileSync(join(wt.path, 'x.txt'), 'x');
    const sha = await wt.commitIntent('x', { intentId: 'x1', intent: 'x' });
    const files = (await wt.git(['ls-tree', '-r', '--name-only', sha])).stdout;
    expect(files).toContain('x.txt');
    expect(files).not.toContain('node_modules');
    await wt.dispose();
  });

  test('updateTenant is compare-and-swap', async () => {
    const { store } = await setup();
    const { sha } = await store.createTenant('acme', 'v1');
    const wt = await store.worktree('refs/heads/tenants/acme');
    writeFileSync(join(wt.path, 'x.txt'), 'x');
    const s1 = await wt.commitIntent('x', { intentId: 'x1', intent: 'x' });
    await store.updateTenant('acme', s1, sha);
    await expect(store.updateTenant('acme', s1, sha)).rejects.toThrow(/moved concurrently/);
    await wt.dispose();
  });

  test('rebase: clean, and conflict that stops for resolution', async () => {
    const { store, vendor } = await setup();
    await store.createTenant('clean', 'v1');
    await store.createTenant('conflict', 'v1');

    for (const [tenant, file, content] of [
      ['clean', 'src/Extra.tsx', 'export const Extra = 1;\n'],
      ['conflict', 'src/Table.tsx', 'export const Table = () => <table><th>Name</th><th>Stage</th><th>Priority</th></table>;\n'],
    ] as const) {
      const wt = await store.worktree(`refs/heads/tenants/${tenant}`);
      writeFileSync(join(wt.path, file), content);
      await store.updateTenant(tenant, await wt.commitIntent(`edit ${tenant}`, { intentId: `${tenant}-1`, intent: 'x' }), await store.tenantHead(tenant));
      await wt.dispose();
    }

    vendor.commit({ 'src/DealTable.tsx': 'export const DealTable = () => <table />;\n' }, 'v2', ['src/Table.tsx']);
    const v2 = await store.importBase(vendor.dir, 'refs/heads/main', 'v2');

    const a = await store.worktree('refs/heads/tenants/clean');
    const ra = await a.rebase('refs/tags/base/v2');
    expect(ra.status).toBe('done');
    expect((await store.tenantBase('clean', await a.head())).version).toBe('v2');
    await a.dispose();

    const b = await store.worktree('refs/heads/tenants/conflict');
    const rb = await b.rebase(v2.sha);
    expect(rb.status).toBe('conflict');
    if (rb.status === 'conflict') {
      expect(rb.files).toEqual(['src/Table.tsx']);
      expect(rb.stoppedAt.subject).toBe('edit conflict');
    }
    // Resolve by porting the change to the new file.
    await b.git(['rm', '-q', 'src/Table.tsx']);
    writeFileSync(join(b.path, 'src/DealTable.tsx'), 'export const DealTable = () => <table><th>Priority</th></table>;\n');
    await b.git(['add', '-A']);
    const done = await b.continueRebase();
    expect(done.status).toBe('done');
    expect(await b.rebaseInProgress()).toBe(false);
    const log = (await b.git(['log', '--format=%s', 'refs/tags/base/v2..HEAD'])).stdout.trim();
    expect(log).toBe('edit conflict');
    await b.dispose();
    rmSync(b.path, { recursive: true, force: true });
  });
});
