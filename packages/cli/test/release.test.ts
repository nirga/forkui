import { afterEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { startServer } from '@forkui/server';
import { release } from '../src/index.ts';
import { v1 } from '../../engine/test/fixture.ts';
import { tmp, vendorRepo } from '../../../test/helpers.ts';

const SECRET = 'release-test-secret-release-test-secret!';
let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup() {
  const t = tmp('release');
  cleanups.push(t.cleanup);
  const port = 47000 + Math.floor(Math.random() * 2000);
  const server = await startServer({ dataDir: join(t.dir, 'forkui'), secret: SECRET, port });
  cleanups.push(() => server.close());
  const vendor = vendorRepo(join(t.dir, 'vendor'));
  vendor.commit(v1, 'v1');
  const lines: string[] = [];
  const out = { log: (s: string) => lines.push(s) };
  const run = (version?: string) => release(vendor.dir, { ...(version ? { version } : {}), url: `http://127.0.0.1:${port}`, secret: SECRET }, out);
  return { server, vendor, lines, run };
}

describe('forkui release', () => {
  test('first upload, safe re-run, incremental upload, re-tag without upload', async () => {
    const { server, vendor, lines, run } = await setup();

    const first = await run('v1');
    expect(first.results).toEqual([]);
    expect(lines.join('\n')).toMatch(/Published base release v1 .*\(1 new commit, \d+ KB\)/);

    lines.length = 0;
    await run('v1'); // CI retry: no error, no upload
    expect(lines.join('\n')).toContain('Base release v1 is already published; resuming the rollout.');

    vendor.commit({ 'src/footer.mjs': 'export const footer = 1;\n' }, 'v2');
    lines.length = 0;
    await run('v2');
    expect(lines.join('\n')).toMatch(/Published base release v2 .*\(1 new commit,/); // only what's new

    lines.length = 0;
    await run('v2-hotfix-label'); // same commit, new name
    expect(lines.join('\n')).toContain('commit already on the server, nothing uploaded');

    expect((await server.svc.store.listBases()).map((b) => b.version)).toEqual(['v1', 'v2', 'v2-hotfix-label']);

    vendor.commit({ 'src/footer.mjs': 'export const footer = 2;\n' }, 'v3');
    await expect(run('v2')).rejects.toThrow(/already published for a different commit/);
  });
});
