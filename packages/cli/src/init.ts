import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_FILE, parseConfig, type ForkuiConfigInput } from '@forkui/core';
import { detect, type Detection, type PackageManager } from './detect.ts';

export const MARK = '// forkui';
const TESTKIT = 'forkui/testkit.ts';
const WORKFLOW = '.github/workflows/forkui.yml';
const VERSION = '^0.0.1';

export type InitOptions = { model: string; escalateTo?: string | null; branch?: string; force?: boolean };

export type InitResult = {
  detection: Detection;
  created: string[];
  edited: string[];
  /** Things init could not do safely; shown to the user as copy-paste instructions. */
  manual: string[];
  unchanged: boolean;
};

const indentOf = (json: string) => json.match(/^\{\n([ \t]+)"/)?.[1] ?? '  ';

const run = (pm: PackageManager, script: string) => (pm === 'npm' ? ['npm', 'run', script] : [pm, script]);

const INSTALL: Record<PackageManager, string[]> = {
  npm: ['npm', 'ci', '--no-audit', '--no-fund'],
  pnpm: ['pnpm', 'install', '--frozen-lockfile'],
  yarn: ['yarn', 'install', '--frozen-lockfile'],
  bun: ['bun', 'install', '--frozen-lockfile'],
};

export function buildConfig(d: Detection, o: InitOptions): ForkuiConfigInput {
  const checks: { name: string; run: string[] }[] = [];
  if (d.scripts.typecheck) checks.push({ name: 'typecheck', run: run(d.pm, 'typecheck') });
  else if (d.typescript) checks.push({ name: 'typecheck', run: ['npx', 'tsc', '--noEmit'] });
  if (d.testRunner === 'vitest') checks.push({ name: 'test', run: ['npx', 'vitest', 'run'] });
  else if (d.testRunner === 'jest') checks.push({ name: 'test', run: ['npx', 'jest'] });
  else if (d.scripts.test && !/no test specified/.test(d.scripts.test)) checks.push({ name: 'test', run: run(d.pm, 'test') });
  const build = d.scripts.build ? run(d.pm, 'build') : ['npx', 'vite', 'build'];
  checks.push({ name: 'build', run: build });

  const testRun = d.testRunner === 'jest' ? ['npx', 'jest', '{file}'] : ['npx', 'vitest', 'run', '{file}'];
  return {
    version: 1,
    install: { run: INSTALL[d.pm], lockfile: d.lockfile ?? 'package.json' },
    checks,
    build: { run: build, outDir: d.outDir },
    paths: {
      locked: [
        ...(d.entry ? [d.entry] : []),
        'index.html',
        'vite.config.*',
        'tsconfig*.json',
        '.github/**',
        ...(d.server ? [d.server.file] : []),
        ...d.sensitiveDirs.map((p) => `${p}/**`),
      ],
      vendorOwned: ['forkui/**'],
      tenantTests: 'forkui-tests',
    },
    testKit: {
      extension: d.typescript ? '.spec.tsx' : '.spec.jsx',
      run: testRun,
      guidance:
        "Use the vendor test kit: import { mockApi, fixtures } from '../forkui/testkit'. Call mockApi() before rendering the app. " +
        'Render the root component and query by accessible role/label (Testing Library). Do not mock modules yourself.',
    },
    dependencies: { allow: [] },
    network: { allowHosts: [] },
    agent: { model: o.model, escalateTo: o.escalateTo ?? null, maxSteps: 60 },
  };
}

function testkit(d: Detection): string {
  const mock = d.testRunner === 'jest' ? 'jest' : 'vi';
  const imp = d.testRunner === 'jest' ? '' : "import { vi } from 'vitest';\n";
  return `${imp}
/**
 * forkui test kit. Your customers' acceptance tests use these helpers, so keep them stable.
 * When your API changes, update mockApi() here and every tenant test keeps working.
 * This folder is vendor-owned: tenant changes can't modify it.
 */

/** Sample data your screens need. Replace with realistic fixtures. */
export const fixtures = {
  // e.g. deals: [{ id: 'd1', name: 'Website revamp', stage: 'proposal', amount: 12000 }],
} as Record<string, unknown>;

/** Map of URL path -> JSON body. Extend this with every endpoint your screens call. */
const routes: Record<string, () => unknown> = {
  // e.g. '/api/deals': () => fixtures.deals,
};

/** Stub fetch() with the routes above (plus per-test overrides). */
export function mockApi(overrides: Record<string, unknown> = {}) {
  const fetchMock = ${mock}.fn(async (input: unknown) => {
    const path = new URL(String(input instanceof Request ? input.url : input), 'http://localhost').pathname;
    if (path in overrides) return new Response(JSON.stringify(overrides[path]), { status: 200 });
    const route = routes[path];
    if (route) return new Response(JSON.stringify(route()), { status: 200 });
    return new Response('not found', { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
`.replace(/ as Record<string, unknown>;/, d.typescript ? ' as Record<string, unknown>;' : ';');
}

function workflow(branch: string): string {
  return `# forkui: publishes each deploy as a base release and carries every customer's customizations onto it.
# Run this AFTER your backend deploy (e.g. add it as the last step of your deploy workflow), so customer
# builds never reach users before the API they call. Customers pinned to an older version keep their old
# build: keep older API versions working while \`forkui tenants\` shows anyone pinned.
name: forkui
on:
  push:
    branches: [${branch}]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx forkui@latest release \${{ github.sha }} ${MARK}
        env:
          FORKUI_URL: \${{ secrets.FORKUI_URL }}
          FORKUI_SECRET: \${{ secrets.FORKUI_SECRET }}
`;
}

/** Find the argument of `.render(` with balanced parentheses. */
function renderArg(src: string): { start: number; end: number } | null {
  const m = /\.render\s*\(/.exec(src);
  if (!m) return null;
  let depth = 1;
  const start = m.index + m[0].length;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return { start, end: i };
  }
  return null;
}

export function addCustomize(src: string): string | null {
  if (src.includes('@forkui/react')) return src; // already installed
  const arg = renderArg(src);
  if (!arg) return null;
  // Wrap exactly the JSX expression (not surrounding whitespace or a trailing comma) so removal is exact.
  const raw = src.slice(arg.start, arg.end);
  const lead = raw.length - raw.trimStart().length;
  const jsx = raw.trim().replace(/,$/, '').trimEnd();
  if (!jsx.startsWith('<')) return null;
  const from = arg.start + lead;
  const to = from + jsx.length;
  const body = `${src.slice(0, from)}<>${jsx}<Customize /></>${src.slice(to)}`;
  const lines = body.split('\n');
  let lastImport = -1;
  lines.forEach((l, i) => {
    if (/^import\s/.test(l)) lastImport = i;
  });
  lines.splice(lastImport + 1, 0, `import { Customize } from '@forkui/react'; ${MARK}`);
  return lines.join('\n');
}

export function removeCustomize(src: string): string {
  return src
    .split('\n')
    .filter((l) => !(l.includes('@forkui/react') && l.includes(MARK)))
    .join('\n')
    .replace(/(\.render\(\s*)<>([\s\S]*?)<Customize \/><\/>/, '$1$2');
}

export function addMiddleware(src: string, kind: 'express' | 'connect' | 'hono', ts: boolean): string | null {
  if (src.includes('@forkui/node')) return src;
  const re =
    kind === 'hono'
      ? /^([ \t]*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*new\s+Hono\b[^\n]*$/m
      : new RegExp(`^([ \\t]*)(?:export\\s+)?(?:const|let|var)\\s+(\\w+)\\s*=\\s*${kind}\\s*\\(\\s*\\)[^\\n]*$`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  const [line, indent, name] = m as unknown as [string, string, string];
  const user = ts ? (kind === 'hono' ? '(c.var as { user?: { orgId?: string; isAdmin?: boolean } }).user' : '(req as { user?: { orgId?: string; isAdmin?: boolean } }).user') : kind === 'hono' ? 'c.var.user' : 'req.user';
  const arg = kind === 'hono' ? 'c' : 'req';
  const fn = kind === 'hono' ? 'forkuiHono' : 'forkui';
  const use =
    `${indent}${name}.use(${fn}({ ${MARK}: set these two from your auth; forkui stays inert until tenant() returns an id\n` +
    `${indent}  tenant: (${arg}) => ${user}?.orgId, ${MARK}\n` +
    `${indent}  canCustomize: (${arg}) => ${user}?.isAdmin === true, ${MARK}\n` +
    `${indent}})); ${MARK}`;
  const at = m.index + line.length;
  const withUse = `${src.slice(0, at)}\n${use}${src.slice(at)}`;
  const lines = withUse.split('\n');
  let lastImport = -1;
  lines.forEach((l, i) => {
    if (/^import\s/.test(l)) lastImport = i;
  });
  lines.splice(lastImport + 1, 0, `import { ${fn} } from '@forkui/node'; ${MARK}`);
  return lines.join('\n');
}

export function removeMarked(src: string): string {
  return src
    .split('\n')
    .filter((l) => !l.includes(MARK))
    .join('\n');
}

function edit(root: string, rel: string, fn: (s: string) => string | null, res: InitResult, manual: string) {
  const p = join(root, rel);
  const before = readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === null) res.manual.push(manual);
  else if (after !== before) {
    writeFileSync(p, after);
    res.edited.push(rel);
  }
}

function create(root: string, rel: string, content: string, res: InitResult, force = false) {
  const p = join(root, rel);
  if (existsSync(p) && !force) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  res.created.push(rel);
}

/** `forkui init`: detect the stack and write everything. Idempotent. */
export function init(root: string, o: InitOptions): InitResult {
  const d = detect(root);
  const res: InitResult = { detection: d, created: [], edited: [], manual: [], unchanged: false };
  if (!d.vite || !d.react)
    res.manual.push('forkui v0.1 supports Vite + React apps. Detected ' + `${d.vite ? 'Vite' : 'no Vite'}, ${d.react ? 'React' : 'no React'}.`);

  const config = buildConfig(d, o);
  parseConfig(JSON.stringify(config)); // never write an invalid config
  create(root, CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', res, o.force);
  create(root, TESTKIT, testkit(d), res);
  create(root, WORKFLOW, workflow(o.branch ?? 'main'), res);

  if (d.entry)
    edit(root, d.entry, addCustomize, res, `Add <Customize /> next to your root component:\n  import { Customize } from '@forkui/react';`);
  else res.manual.push("Render <Customize /> once in your app root: import { Customize } from '@forkui/react';");

  const ts = (f: string) => /\.tsx?$/.test(f);
  if (d.server && d.server.kind !== 'fastify') {
    const kind = d.server.kind;
    edit(
      root,
      d.server.file,
      (s) => addMiddleware(s, kind, ts(d.server!.file)),
      res,
      `In ${d.server.file}, before your static files:\n  app.use(forkui({ tenant: (req) => req.user?.orgId, canCustomize: (req) => req.user?.isAdmin }))`,
    );
  } else {
    res.manual.push(
      'Add the forkui middleware to the server that serves your frontend, before static files:\n' +
        "  import { forkui } from '@forkui/node';\n" +
        '  app.use(forkui({ tenant: (req) => req.user?.orgId, canCustomize: (req) => req.user?.isAdmin }));\n' +
        '  (Hono: forkuiHono; Workers/Bun/Deno: forkuiFetch)',
    );
  }

  edit(root, 'package.json', (s) => {
    const pkg = JSON.parse(s);
    pkg.dependencies ??= {};
    pkg.devDependencies ??= {};
    pkg.dependencies['@forkui/react'] ??= VERSION;
    if (d.server) pkg.dependencies['@forkui/node'] ??= VERSION;
    pkg.devDependencies['forkui'] ??= VERSION;
    return JSON.stringify(pkg, null, indentOf(s)) + '\n';
  }, res, '');

  const gi = join(root, '.gitignore');
  const giText = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!giText.split('\n').includes('.forkui/')) {
    writeFileSync(gi, giText + (giText && !giText.endsWith('\n') ? '\n' : '') + '.forkui/\n');
    (existsSync(gi) && giText ? res.edited : res.created).push('.gitignore');
  }

  res.unchanged = res.created.length === 0 && res.edited.length === 0;
  return res;
}

/** `forkui uninstall`: reverse init. */
export function uninstall(root: string): string[] {
  const d = detect(root);
  const touched: string[] = [];
  const rm = (rel: string) => {
    const p = join(root, rel);
    if (existsSync(p)) {
      removeFile(p);
      touched.push(rel);
    }
  };
  for (const f of [CONFIG_FILE, TESTKIT, WORKFLOW]) rm(f);
  const fix = (rel: string, fn: (s: string) => string) => {
    const p = join(root, rel);
    if (!existsSync(p)) return;
    const s = readFileSync(p, 'utf8');
    const out = fn(s);
    if (out !== s) {
      writeFileSync(p, out);
      touched.push(rel);
    }
  };
  if (d.entry) fix(d.entry, removeCustomize);
  if (d.server) fix(d.server.file, removeMarked);
  fix('package.json', (s) => {
    const pkg = JSON.parse(s);
    delete pkg.dependencies?.['@forkui/react'];
    delete pkg.dependencies?.['@forkui/node'];
    delete pkg.devDependencies?.['forkui'];
    for (const k of ['dependencies', 'devDependencies']) if (pkg[k] && Object.keys(pkg[k]).length === 0) delete pkg[k];
    return JSON.stringify(pkg, null, indentOf(s)) + '\n';
  });
  fix('.gitignore', (s) => s.split('\n').filter((l) => l !== '.forkui/').join('\n'));
  if (existsSync(join(root, '.gitignore')) && readFileSync(join(root, '.gitignore'), 'utf8').trim() === '') removeFile(join(root, '.gitignore'));
  return touched;
}

function removeFile(p: string) {
  rmSync(p, { force: true });
  // Remove now-empty parent dirs we created (forkui/, .github/workflows/).
  for (let dir = dirname(p); readdirSafe(dir)?.length === 0; dir = dirname(dir)) rmdirSync(dir);
}

function readdirSafe(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}
