import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@forkui/core';
import { DependencyCache, LocalDriver, runChecks } from '../src/index.ts';
import { tmp } from '../../../test/helpers.ts';

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});
const dir = () => {
  const t = tmp('sandbox');
  cleanups.push(t.cleanup);
  return t.dir;
};

describe('LocalDriver', () => {
  test('scrubs secrets from the environment', async () => {
    process.env.FORKUI_TEST_SECRET = 'hunter2';
    const box = await new LocalDriver().open(dir());
    const r = await box.exec(['node', '-e', 'console.log(process.env.FORKUI_TEST_SECRET ?? "absent")'], { env: { EXTRA: '1' } });
    expect(r.stdout.trim()).toBe('absent');
    delete process.env.FORKUI_TEST_SECRET;
  });

  test('kills the process group on timeout', async () => {
    const box = await new LocalDriver().open(dir());
    const r = await box.exec(['node', '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  test('rejects cwd outside the sandbox and reports missing binaries', async () => {
    const box = await new LocalDriver().open(dir());
    await expect(box.exec(['ls'], { cwd: '../..' })).rejects.toThrow(/escapes/);
    const r = await box.exec(['definitely-not-a-binary-xyz']);
    expect(r.code).toBe(127);
  });
});

describe('runChecks', () => {
  test('runs all checks and captures output', async () => {
    const box = await new LocalDriver().open(dir());
    const res = await runChecks(box, [
      { name: 'ok', run: ['node', '-e', 'console.log("fine")'], timeoutMs: 5000 },
      { name: 'bad', run: ['node', '-e', 'console.error("boom"); process.exit(2)'], timeoutMs: 5000 },
    ]);
    expect(res.map((r) => [r.name, r.ok, r.code])).toEqual([
      ['ok', true, 0],
      ['bad', false, 2],
    ]);
    expect(res[1]!.output).toContain('boom');
  });
});

describe('DependencyCache', () => {
  test('installs once per manifest and links into worktrees', async () => {
    const root = dir();
    const config = parseConfig(
      JSON.stringify({
        version: 1,
        checks: [{ name: 'x', run: ['true'] }],
        agent: { model: 'mock:primary' },
        install: { run: ['node', '-e', 'require("fs").mkdirSync("node_modules/fake",{recursive:true})'], lockfile: 'package-lock.json' },
      }),
    );
    const driver = new LocalDriver();
    const cache = new DependencyCache(join(root, 'cache'), driver);
    const wt1 = join(root, 'wt1');
    const wt2 = join(root, 'wt2');
    for (const w of [wt1, wt2]) {
      (await import('node:fs')).mkdirSync(w, { recursive: true });
      writeFileSync(join(w, 'package.json'), '{"name":"x"}');
    }
    const a = await cache.link(await driver.open(wt1), config);
    const b = await cache.link(await driver.open(wt2), config);
    expect(a.installed).toBe(true);
    expect(b.installed).toBe(false);
    expect(a.key).toBe(b.key);
    expect(readlinkSync(join(wt2, 'node_modules'))).toContain(a.key);
    expect(existsSync(join(wt2, 'node_modules', 'fake'))).toBe(true);
  });

  test('concurrent links for the same manifest install exactly once', async () => {
    const root = dir();
    const config = parseConfig(
      JSON.stringify({
        version: 1,
        checks: [{ name: 'x', run: ['true'] }],
        agent: { model: 'mock:primary' },
        install: {
          run: ['node', '-e', 'require("fs").appendFileSync("../installs.log","x");require("fs").mkdirSync("node_modules/fake",{recursive:true})'],
          lockfile: 'package-lock.json',
        },
      }),
    );
    const driver = new LocalDriver();
    const cache = new DependencyCache(join(root, 'cache'), driver);
    const { mkdirSync, readFileSync: read } = await import('node:fs');
    const boxes = [];
    for (let i = 0; i < 6; i++) {
      const w = join(root, `wt${i}`);
      mkdirSync(w, { recursive: true });
      writeFileSync(join(w, 'package.json'), '{"name":"x"}');
      boxes.push(await driver.open(w));
    }
    const results = await Promise.all(boxes.map((b) => cache.link(b, config)));
    expect(results.filter((r) => r.installed)).toHaveLength(1);
    expect(read(join(root, 'cache', 'installs.log'), 'utf8')).toBe('x');
    for (const b of boxes) expect(existsSync(join(b.root, 'node_modules', 'fake'))).toBe(true);
  });
});
