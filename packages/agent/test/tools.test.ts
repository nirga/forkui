import { afterEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { parseConfig } from '@forkui/core';
import { GitStore } from '@forkui/git';
import { LocalDriver } from '@forkui/sandbox';
import { createTools } from '../src/index.ts';
import { baseConfig, tmp, v1Files, vendorRepo, writeFiles } from '../../../test/helpers.ts';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function tools() {
  const t = tmp('tools');
  cleanups.push(t.cleanup);
  const vendor = vendorRepo(join(t.dir, 'vendor'));
  vendor.commit(v1Files, 'v1');
  const store = await GitStore.init(join(t.dir, 'store'));
  await store.importBase(vendor.dir, 'refs/heads/main', 'v1');
  const wt = await store.worktree('refs/tags/base/v1');
  cleanups.push(() => wt.dispose());
  const sandbox = await new LocalDriver().open(wt.path);
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${'x'.repeat(30)}`).join('\n');
  writeFiles(wt.path, { 'public/translation.json': big });
  const { tools } = createTools({ sandbox, worktree: wt, config: parseConfig(JSON.stringify(baseConfig)), mode: 'edit' });
  const read = (input: object) => (tools.read_file as unknown as { execute: (i: object, o: object) => Promise<string> }).execute(input, {});
  return { read };
}

describe('read_file', () => {
  test('large files are cut at a line boundary with a pointer to the rest', async () => {
    const { read } = await tools();
    const out = await read({ path: 'public/translation.json' });
    expect(out.length).toBeLessThan(41_000);
    expect(out).toMatch(/\[showing lines 1-\d+ of 5000; .* Read more with start_line=\d+, or use search\.\]$/);
    const next = Number(out.match(/start_line=(\d+)/)![1]);
    expect(out).toContain(`line ${next - 1} `);
    expect(out).not.toContain(`line ${next} `);
  });

  test('line ranges return exactly those lines', async () => {
    const { read } = await tools();
    const out = await read({ path: 'public/translation.json', start_line: 10, end_line: 12 });
    expect(out.split('\n')).toEqual(['[lines 10-12 of 5000]', expect.stringMatching(/^line 10 /), expect.stringMatching(/^line 11 /), expect.stringMatching(/^line 12 /)]);
  });
});
