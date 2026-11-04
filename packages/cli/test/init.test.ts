import { afterEach, describe, expect, test } from 'vitest';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '@forkui/core';
import { addCustomize, addMiddleware, init, removeCustomize, uninstall } from '../src/index.ts';
import { tmp } from '../../../test/helpers.ts';

const CRM = resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/crm/v1');
let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

const SERVER = `import express from 'express';
import { session } from './session';

const app = express();
app.use(session());
app.use(express.static('dist'));
app.listen(3000);
`;

function vendorApp() {
  const t = tmp('cli');
  cleanups.push(t.cleanup);
  const dir = join(t.dir, 'app');
  cpSync(CRM, dir, { recursive: true, filter: (s) => !s.includes('node_modules') && !s.endsWith('forkui.config.json') });
  writeFileSync(join(dir, 'server.ts'), SERVER);
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=v', '-c', 'user.email=v@x', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '-m', 'app');
  return { dir, g };
}

describe('forkui init', () => {
  test('detects the stack and writes config, test kit, workflow and the three lines', () => {
    const { dir, g } = vendorApp();
    const r = init(dir, { model: 'openai:gpt-5.4', branch: 'main' });
    expect(r.detection).toMatchObject({ pm: 'npm', vite: true, react: true, typescript: true, testRunner: 'vitest', entry: 'src/main.tsx', server: { file: 'server.ts', kind: 'express' } });
    expect(r.created.sort()).toEqual(['.github/workflows/forkui.yml', 'forkui.config.json', 'forkui/testkit.ts']);
    expect(r.edited.sort()).toEqual(['.gitignore', 'package.json', 'server.ts', 'src/main.tsx']);
    expect(r.manual).toEqual([]);

    const config = parseConfig(readFileSync(join(dir, 'forkui.config.json'), 'utf8'));
    expect(config.checks.map((c) => [c.name, c.run.join(' ')])).toEqual([
      ['typecheck', 'npm run typecheck'],
      ['test', 'npx vitest run'],
      ['build', 'npm run build'],
    ]);
    expect(config.install.run).toEqual(['npm', 'ci', '--no-audit', '--no-fund']);
    expect(config.paths.locked).toEqual(expect.arrayContaining(['src/main.tsx', 'server.ts', 'index.html', 'forkui.config.json']));
    expect(config.agent).toMatchObject({ model: 'openai:gpt-5.4', escalateTo: null });

    const main = readFileSync(join(dir, 'src/main.tsx'), 'utf8');
    expect(main).toContain("import { Customize } from '@forkui/react'; // forkui");
    expect(main).toContain('.render(<><App /><Customize /></>)');
    const server = readFileSync(join(dir, 'server.ts'), 'utf8');
    // Middleware goes right after app creation, i.e. before static files.
    expect(server.indexOf('app.use(forkui(')).toBeLessThan(server.indexOf("express.static('dist')"));
    expect(server).toContain("import { forkui } from '@forkui/node'; // forkui");
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@forkui/react']).toBeTruthy();
    expect(pkg.dependencies['@forkui/node']).toBeTruthy();
    expect(pkg.devDependencies.forkui).toBeTruthy();
    expect(readFileSync(join(dir, '.github/workflows/forkui.yml'), 'utf8')).toContain('npx forkui@latest release ${{ github.sha }}');
    expect(g('status', '--porcelain')).toBeTruthy();
  });

  test('is idempotent', () => {
    const { dir } = vendorApp();
    init(dir, { model: 'openai:gpt-5.4' });
    const again = init(dir, { model: 'openai:gpt-5.4' });
    expect(again.unchanged).toBe(true);
    expect(readFileSync(join(dir, 'src/main.tsx'), 'utf8').match(/<Customize \/>/g)).toHaveLength(1);
  });

  test('uninstall restores the original tree exactly', () => {
    const { dir, g } = vendorApp();
    init(dir, { model: 'openai:gpt-5.4' });
    uninstall(dir);
    expect(g('status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(existsSync(join(dir, 'forkui'))).toBe(false);
    expect(existsSync(join(dir, '.github'))).toBe(false);
  });

  test('without a recognizable server it explains what to add instead of guessing', () => {
    const { dir } = vendorApp();
    rmSync(join(dir, 'server.ts'));
    const r = init(dir, { model: 'anthropic:claude-sonnet-5-5' });
    expect(r.manual.join('\n')).toMatch(/app\.use\(forkui\(/);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies['@forkui/node']).toBeUndefined();
  });

  test('refuses an invalid model spec', () => {
    const { dir } = vendorApp();
    expect(() => init(dir, { model: 'gpt-5' })).toThrow(/agent\.model/);
    expect(existsSync(join(dir, 'forkui.config.json'))).toBe(false);
  });
});

describe('codemods', () => {
  test('Customize wraps StrictMode roots and round-trips', () => {
    const src = "import { StrictMode } from 'react';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n";
    const out = addCustomize(src)!;
    expect(out).toContain('</StrictMode><Customize /></>,\n);');
    expect(removeCustomize(out)).toBe(src);
  });

  test('Hono middleware uses forkuiHono and reads c.var', () => {
    const out = addMiddleware("import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/', (c) => c.text('hi'));\n", 'hono', true)!;
    expect(out).toContain("import { forkuiHono } from '@forkui/node'; // forkui");
    expect(out).toMatch(/app\.use\(forkuiHono\(\{[\s\S]*c\.var[\s\S]*\}\)\);/);
  });

  test('unrecognized entry returns null (manual step)', () => {
    expect(addCustomize('export default function main() {}')).toBeNull();
  });
});
