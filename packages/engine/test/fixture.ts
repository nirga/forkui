import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { GitStore } from '@forkui/git';
import { DependencyCache, LocalDriver } from '@forkui/sandbox';
import type { EngineDeps, EngineEvent } from '../src/index.ts';
import { tmp, vendorRepo } from '../../../test/helpers.ts';

/** A tiny plain-JS "frontend": a table module with columns, tested with node:assert. */
export const config = {
  version: 1,
  install: { run: ['node', '-e', "require('fs').mkdirSync('node_modules',{recursive:true})"], lockfile: 'package.json' },
  checks: [{ name: 'test', run: ['node', 'scripts/run-tests.mjs'] }],
  build: { run: ['node', 'scripts/build.mjs'], outDir: 'dist' },
  paths: { locked: ['src/auth/**'], vendorOwned: ['src/__tests__/**', 'scripts/**'], tenantTests: 'forkui-tests' },
  testKit: { extension: '.spec.mjs', run: ['node', '{file}'] },
  agent: { model: 'mock:primary', escalateTo: 'mock:escalation', maxSteps: 20 },
};

export const gitignore = 'node_modules\ndist\n';

const runner = `import { readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
let failed = 0;
for (const dir of ['src/__tests__', 'forkui-tests']) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => /\\.(test|spec)\\.mjs$/.test(f))) {
    try { execFileSync('node', [dir + '/' + f], { stdio: 'pipe' }); console.log('PASS ' + f); }
    catch (e) { failed++; console.log('FAIL ' + f + '\\n' + e.stderr); }
  }
}
process.exit(failed ? 1 : 0);
`;

export const v1 = {
  'forkui.config.json': JSON.stringify(config, null, 2),
  'package.json': JSON.stringify({ name: 'crm', type: 'module' }, null, 2) + '\n',
  '.gitignore': 'node_modules\ndist\n',
  'scripts/run-tests.mjs': runner,
  'scripts/build.mjs':
    "import { mkdirSync, writeFileSync, existsSync } from 'node:fs';\n" +
    "const m = await import(existsSync('src/deals/dealTable.mjs') ? '../src/deals/dealTable.mjs' : '../src/table.mjs');\n" +
    "const cols = m.dealColumns ?? m.columns;\n" +
    "mkdirSync('dist/assets', { recursive: true });\n" +
    "writeFileSync('dist/index.html', '<table>' + cols.map((c) => '<th>' + c + '</th>').join('') + '</table>');\n" +
    "writeFileSync('dist/assets/app-0123abcd.js', 'export const cols = ' + JSON.stringify(cols));\n",
  'src/table.mjs': "export const columns = ['Name', 'Stage', 'Amount'];\n",
  'src/__tests__/table.test.mjs': "import assert from 'node:assert';\nimport { columns } from '../table.mjs';\nassert.ok(columns.includes('Name'));\n",
};

/** v2 moves the table to src/deals/dealTable.mjs and renames Stage -> Status. */
export const v2 = {
  'src/deals/dealTable.mjs': "export const dealColumns = ['Name', 'Status', 'Amount'];\n",
  'src/__tests__/table.test.mjs': "import assert from 'node:assert';\nimport { dealColumns } from '../deals/dealTable.mjs';\nassert.ok(dealColumns.includes('Name'));\n",
};

export const priorityTestV1 =
  "import assert from 'node:assert';\nimport * as m from '../src/table.mjs';\nconst cols = m.columns;\nassert.equal(cols[cols.indexOf('Stage') + 1], 'Priority');\n";

/** A tenant test written to survive the vendor's move (via a stable re-export the vendor keeps). */
export const priorityTestStable =
  "import assert from 'node:assert';\nimport { existsSync } from 'node:fs';\nconst mod = await import(existsSync('src/deals/dealTable.mjs') ? '../src/deals/dealTable.mjs' : '../src/table.mjs');\nconst cols = mod.dealColumns ?? mod.columns;\nconst i = cols.findIndex((c) => c === 'Stage' || c === 'Status');\nassert.equal(cols[i + 1], 'Priority');\n";

export async function setupStore() {
  const t = tmp('engine');
  const vendor = vendorRepo(join(t.dir, 'vendor'));
  vendor.commit(v1, 'v1');
  const store = await GitStore.init(join(t.dir, 'store'));
  await store.importBase(vendor.dir, 'refs/heads/main', 'v1');
  return { t, vendor, store };
}

type Call = { tool: string; input: Record<string, unknown> };

/** A mock model that plays back one tool call per step, then stops. */
export function scriptedModel(name: string, calls: Call[]) {
  let i = 0;
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  };
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: name,
    doGenerate: async () => {
      const c = calls[i++];
      if (!c) return { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
      return {
        content: [{ type: 'tool-call', toolCallId: `call-${i}`, toolName: c.tool, input: JSON.stringify(c.input) }],
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage,
        warnings: [],
      };
    },
  });
}

export function engineDeps(store: GitStore, root: string, models: Record<string, MockLanguageModelV4>) {
  const driver = new LocalDriver();
  const events: EngineEvent[] = [];
  const deps: EngineDeps = {
    store,
    driver,
    deps: new DependencyCache(join(root, 'cache'), driver),
    resolveModel: (spec) => {
      const m = models[spec];
      if (!m) throw new Error(`no mock for ${spec}`);
      return m;
    },
    onEvent: (e) => events.push(e),
  };
  return { deps, events };
}
