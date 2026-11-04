import type { LanguageModel } from 'ai';

/** Turns a "<provider>:<model id>" spec into an AI SDK LanguageModel. */
export type ModelResolver = (spec: string) => LanguageModel | Promise<LanguageModel>;

/** Provider name -> [package, exported factory]. Anything else: `@ai-sdk/<provider>` exporting `<provider>`. */
const KNOWN: Record<string, [string, string]> = {
  anthropic: ['@ai-sdk/anthropic', 'anthropic'],
  openai: ['@ai-sdk/openai', 'openai'],
  google: ['@ai-sdk/google', 'google'],
  'amazon-bedrock': ['@ai-sdk/amazon-bedrock', 'bedrock'],
  azure: ['@ai-sdk/azure', 'azure'],
  mistral: ['@ai-sdk/mistral', 'mistral'],
  xai: ['@ai-sdk/xai', 'xai'],
  groq: ['@ai-sdk/groq', 'groq'],
  deepseek: ['@ai-sdk/deepseek', 'deepseek'],
  ollama: ['ollama-ai-provider-v2', 'ollama'],
};

export function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const i = spec.indexOf(':');
  if (i <= 0 || i === spec.length - 1) throw new Error(`Invalid model spec "${spec}" (expected "<provider>:<model id>")`);
  return { provider: spec.slice(0, i), modelId: spec.slice(i + 1) };
}

/**
 * Default resolver: dynamically imports the provider package, so forkui depends on no
 * particular LLM vendor. Install the one you use, e.g. `npm i @ai-sdk/openai`.
 * Credentials come from each provider's usual env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
 */
export const defaultModelResolver: ModelResolver = async (spec) => {
  const { provider, modelId } = parseModelSpec(spec);
  const [pkg, factoryName] = KNOWN[provider] ?? [`@ai-sdk/${provider}`, provider];
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pkg)) as Record<string, unknown>;
  } catch {
    throw new Error(`Model "${spec}" needs the provider package "${pkg}". Install it: npm install ${pkg}`);
  }
  const factory = mod[factoryName];
  if (typeof factory !== 'function') throw new Error(`"${pkg}" does not export a "${factoryName}" provider`);
  return (factory as (id: string) => LanguageModel)(modelId);
};
