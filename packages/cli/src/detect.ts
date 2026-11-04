import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type ServerKind = 'express' | 'hono' | 'fastify' | 'connect';

export type Detection = {
  pm: PackageManager;
  lockfile: string | null;
  vite: boolean;
  react: boolean;
  typescript: boolean;
  testRunner: 'vitest' | 'jest' | null;
  scripts: Record<string, string>;
  /** Frontend entry that calls createRoot(...).render(...) */
  entry: string | null;
  server: { file: string; kind: ServerKind } | null;
  /** Directories that look sensitive (auth, billing, payments, admin). */
  sensitiveDirs: string[];
  outDir: string;
  hasGithub: boolean;
};

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

const SERVER_PATTERNS: [RegExp, ServerKind][] = [
  [/\bnew\s+Hono\s*(<[^>]*>)?\s*\(/, 'hono'],
  [/\bexpress\s*\(\s*\)/, 'express'],
  [/\bfastify\s*\(/, 'fastify'],
  [/\bconnect\s*\(\s*\)/, 'connect'],
];

function walk(dir: string, depth: number, out: string[] = []): string[] {
  if (depth < 0 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'dist' || name === 'build') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, depth - 1, out);
    else if (/\.(m?[jt]sx?)$/.test(name)) out.push(p);
  }
  return out;
}

export function detect(root: string): Detection {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const lock = LOCKFILES.find(([f]) => existsSync(join(root, f)));
  const rel = (p: string) => p.slice(root.length + 1).split('\\').join('/');

  const files = walk(root, 4);
  let entry: string | null = null;
  let server: Detection['server'] = null;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (!entry && /\.[jt]sx$/.test(f) && /createRoot\s*\([\s\S]*?\)\s*\.render\s*\(/.test(text)) entry = rel(f);
    if (!server && !/\.[jt]sx$/.test(f) && !rel(f).startsWith('src/')) {
      const hit = SERVER_PATTERNS.find(([re]) => re.test(text));
      if (hit) server = { file: rel(f), kind: hit[1] };
    }
  }
  if (!server)
    for (const f of files) {
      if (/\.[jt]sx$/.test(f) || rel(f).includes('__tests__') || /vite\.config/.test(f)) continue;
      const hit = SERVER_PATTERNS.find(([re]) => re.test(readFileSync(f, 'utf8')));
      if (hit) {
        server = { file: rel(f), kind: hit[1] };
        break;
      }
    }

  const sensitiveDirs: string[] = [];
  for (const base of ['src', 'app', 'src/features', 'src/pages', 'src/routes']) {
    const d = join(root, base);
    if (!existsSync(d) || !statSync(d).isDirectory()) continue;
    for (const name of readdirSync(d))
      if (/^(auth|authentication|login|billing|payments?|checkout|admin|permissions?)$/i.test(name) && statSync(join(d, name)).isDirectory())
        sensitiveDirs.push(`${base}/${name}`);
  }

  let outDir = 'dist';
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']) {
    if (!existsSync(join(root, f))) continue;
    const m = readFileSync(join(root, f), 'utf8').match(/outDir\s*:\s*['"]([^'"]+)['"]/);
    if (m) outDir = m[1]!;
  }

  return {
    pm: lock?.[1] ?? 'npm',
    lockfile: lock?.[0] ?? null,
    vite: !!deps.vite,
    react: !!deps.react,
    typescript: !!deps.typescript || existsSync(join(root, 'tsconfig.json')),
    testRunner: deps.vitest ? 'vitest' : deps.jest ? 'jest' : null,
    scripts: pkg.scripts ?? {},
    entry,
    server,
    sensitiveDirs,
    outDir,
    hasGithub: existsSync(join(root, '.github')),
  };
}
