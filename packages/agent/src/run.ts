import { generateText, hasToolCall, isStepCount, type LanguageModel, type ToolSet } from 'ai';
import type { AgentOutcome } from './tools.ts';

export type AgentRun = {
  outcome: AgentOutcome | null;
  /** Final assistant text (if any). */
  text: string;
  steps: number;
  toolCalls: string[];
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  model: string;
  durationMs: number;
  finishReason: string;
};

export type RunAgentOptions = {
  model: LanguageModel;
  instructions: string;
  prompt: string;
  tools: ToolSet;
  outcome: () => AgentOutcome | null;
  maxSteps: number;
  abortSignal?: AbortSignal;
};

function modelName(m: LanguageModel): string {
  if (typeof m === 'string') return m;
  return `${m.provider}:${m.modelId}`;
}

/** Run a tool-using agent until it calls finish/pin or hits the step limit. Provider-agnostic. */
export async function runAgent(o: RunAgentOptions): Promise<AgentRun> {
  const started = Date.now();
  const r = await generateText({
    model: o.model,
    instructions: o.instructions,
    prompt: o.prompt,
    tools: o.tools,
    stopWhen: [isStepCount(o.maxSteps), hasToolCall('finish'), hasToolCall('pin')],
    // Agent loops resend the whole history every step. Ask providers that support it to cache the prefix
    // (Anthropic: request-level cache_control; others ignore unknown provider keys, OpenAI caches automatically).
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    ...(o.abortSignal ? { abortSignal: o.abortSignal } : {}),
  });
  return {
    outcome: o.outcome(),
    text: r.text,
    steps: r.steps.length,
    toolCalls: r.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
    usage: {
      inputTokens: r.totalUsage.inputTokens ?? 0,
      outputTokens: r.totalUsage.outputTokens ?? 0,
      cachedInputTokens: r.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
    },
    model: modelName(o.model),
    durationMs: Date.now() - started,
    finishReason: String(r.finishReason),
  };
}
