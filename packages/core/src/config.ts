import { z } from 'zod';

const MODEL_SPEC = /^[a-z0-9][a-z0-9-]*:.+$/;

const check = z.object({
  /** Short identifier, e.g. "typecheck". */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Command and args, run in the worktree root. No shell. */
  run: z.array(z.string()).min(1),
  timeoutMs: z.number().int().positive().default(300_000),
});

export const forkuiConfigSchema = z.object({
  version: z.literal(1),
  /** How to install dependencies. Cached by `lockfile` hash. */
  install: z
    .object({
      run: z.array(z.string()).min(1).default(['npm', 'ci', '--no-audit', '--no-fund']),
      lockfile: z.string().default('package-lock.json'),
    })
    .default({}),
  /** Vendor checks that every tenant branch must pass (typecheck, contract tests, build...). */
  checks: z.array(check).min(1),
  paths: z
    .object({
      /** Tenants may never change these (globs). */
      locked: z.array(z.string()).default([]),
      /** Vendor-owned files tenants may read but not change (test kit, fixtures, contract tests). */
      vendorOwned: z.array(z.string()).default([]),
      /** Where tenant specs and compiled tests live. */
      tenantTests: z.string().default('forkui-tests'),
    })
    .default({}),
  /** How a tenant release is built. Output files are served at the same URL paths as the vendor's own deploy. */
  build: z
    .object({
      run: z.array(z.string()).min(1).default(['npx', 'vite', 'build']),
      outDir: z.string().default('dist'),
    })
    .default({}),
  /** How tenant acceptance tests are written and run. */
  testKit: z
    .object({
      /** Compiled test file extension, e.g. ".spec.tsx" -> forkui-tests/<intentId>.spec.tsx */
      extension: z.string().regex(/^\.[a-z0-9.]+$/).default('.spec.tsx'),
      /** Command to run one test file; "{file}" is replaced with its path. */
      run: z.array(z.string()).min(1).default(['npx', 'vitest', 'run', '{file}']),
      /** Shown to the agent when writing tests: which helpers/fixtures to use. */
      guidance: z.string().default(''),
    })
    .default({}),
  dependencies: z
    .object({
      /** Packages a tenant change may add to package.json. Globs allowed, e.g. "@radix-ui/*". */
      allow: z.array(z.string()).default([]),
    })
    .default({}),
  network: z
    .object({
      /** Absolute URL hosts tenant code may reference, in addition to relative URLs (proxied). */
      allowHosts: z.array(z.string()).default([]),
    })
    .default({}),
  /** What customer admins see in the editor. */
  editor: z
    .object({
      /**
       * Example requests shown when an admin starts a feature, written for YOUR product.
       * Either a list, or per language: { "en": [...], "he": [...] }.
       */
      suggestions: z.union([z.array(z.string()), z.record(z.string(), z.array(z.string()))]).optional(),
      /** Language to use when the host page doesn't declare one (e.g. "he"). */
      defaultLanguage: z.string().optional(),
    })
    .default({}),
  agent: z
    .object({
      /**
       * "<provider>:<model id>", resolved through an installed AI SDK provider package
       * (e.g. "anthropic:claude-sonnet-5-5", "openai:gpt-5.4", "google:gemini-3-pro", "ollama:qwen3-coder").
       */
      model: z.string().regex(MODEL_SPEC),
      /** Retried once with this model if the first attempt fails verification. null = no escalation. */
      escalateTo: z.string().regex(MODEL_SPEC).nullable().default(null),
      maxSteps: z.number().int().positive().default(60),
    }),
});

export type ForkuiConfig = z.output<typeof forkuiConfigSchema>;
export type ForkuiConfigInput = z.input<typeof forkuiConfigSchema>;
export type Check = ForkuiConfig['checks'][number];

export const CONFIG_FILE = 'forkui.config.json';

export class ConfigError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(issues.length ? `${message}:\n  - ${issues.join('\n  - ')}` : message);
    this.name = 'ConfigError';
  }
}

/** Parse config from raw JSON text. The config file itself is always treated as locked. */
export function parseConfig(text: string): ForkuiConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  const result = forkuiConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `Invalid ${CONFIG_FILE}`,
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const config = result.data;
  if (!config.paths.locked.includes(CONFIG_FILE)) config.paths.locked.push(CONFIG_FILE);
  return config;
}
