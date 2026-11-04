import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.forkui-data', 'test-tmp');

/** A temp dir under the repo (gitignored), removed by `cleanup()`. */
export function tmp(label: string): { dir: string; cleanup: () => void } {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const baseConfig = {
  version: 1,
  checks: [{ name: 'noop', run: ['node', '-e', '0'] }],
  paths: { locked: ['src/auth/**'], vendorOwned: ['src/test/**'], tenantTests: 'forkui-tests' },
  dependencies: { allow: ['@radix-ui/*', 'date-fns'] },
  network: { allowHosts: ['api.acme.test'] },
  agent: { model: 'mock:primary' },
};

export function writeFiles(dir: string, files: Record<string, string>) {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
}

function g(dir: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Vendor', '-c', 'user.email=v@acme.test', ...args], { cwd: dir, encoding: 'utf8' });
}

/** A vendor repo with a commit per call to `commit()`. */
export function vendorRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q', '-b', 'main');
  return {
    dir,
    commit(files: Record<string, string>, message = 'vendor change', remove: string[] = []) {
      writeFiles(dir, files);
      for (const r of remove) rmSync(join(dir, r), { force: true });
      g(dir, 'add', '-A');
      g(dir, 'commit', '-q', '-m', message);
      return g(dir, 'rev-parse', 'HEAD').trim();
    },
  };
}

export const v1Files = {
  'forkui.config.json': JSON.stringify(baseConfig, null, 2),
  'package.json': JSON.stringify({ name: 'acme', dependencies: { react: '18.3.1' } }, null, 2) + '\n',
  'src/App.tsx': 'export const App = () => <Table />;\n',
  'src/Table.tsx': 'export const Table = () => <table><th>Name</th><th>Stage</th></table>;\n',
  'src/auth/session.ts': 'export const session = 1;\n',
  'src/test/mockApi.ts': 'export const mockApi = () => {};\n',
};
