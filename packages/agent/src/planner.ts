import { generateText, hasToolCall, isStepCount, tool, type LanguageModel } from 'ai';
import { z } from 'zod';

export type ChatTurn = { role: 'user' | 'assistant'; text: string };

export type Proposal = {
  /** Short name shown in "Your customizations". */
  title: string;
  /** The full request for the coding agent (complete, not a delta). */
  request: string;
  /** Acceptance criteria in plain language: what must be true when it's done. Becomes the frozen spec. */
  criteria: string[];
};

export type PlanResult = { kind: 'reply'; text: string } | { kind: 'propose'; text: string; proposal: Proposal };

export type FeatureContext = {
  title: string;
  request: string;
  criteria: string[];
  /** live = everyone at the customer sees it; preview = built, not published; draft = not built yet */
  status: 'draft' | 'preview' | 'live' | 'off' | 'paused';
};

const INSTRUCTIONS = `You are the customization assistant inside a B2B web app. You talk with an admin at one of the app's customers.
Each conversation is about ONE feature: one named customization of their organization's copy of the app.
A separate coding agent implements what the admin approves.

In each turn, either reply (to clarify, answer, or chat) or propose.
- Be brief, warm and plain-spoken. The admin is not technical. Never mention files, code, git, tests or tools.
- Propose as soon as it's clear enough to build. Ask at most one short clarifying question, and only if the answer really changes what gets built.
- A proposal is the COMPLETE definition of this feature: a short title, the full self-contained request for the coding agent, and 2-5 acceptance criteria.
  If the feature already exists (preview or live), propose its complete updated version (everything it should do now, including what stays), not just the delta.
- Acceptance criteria describe what the admin will see when it works, stated observably ("The deals table has a Priority column right after Stage").
  Avoid exact pixel or styling details unless asked. They become an automated check that keeps the feature working through future app updates.
- If the admin asks for something unrelated to this feature, say kindly that it belongs in a new feature (they can start one with "New feature").
- You cannot change data, permissions, billing, or anything outside the app's screens; say so kindly if asked.
Always respond by calling exactly one tool.`;

/** One conversational turn: reply or propose a change. Provider-agnostic. */
export async function planTurn(o: {
  model: LanguageModel;
  product: string;
  conversation: ChatTurn[];
  /** This feature as currently built, if it has been built. */
  feature: FeatureContext | null;
  /** Titles of the customer's other features. */
  otherFeatures: string[];
  abortSignal?: AbortSignal;
}): Promise<PlanResult> {
  let result: PlanResult | null = null;
  const tools = {
    reply: tool({
      description: 'Reply to the admin without proposing a change (clarifying question, answer, or chat).',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        result = { kind: 'reply', text };
        return 'ok';
      },
    }),
    propose: tool({
      description: 'Propose a concrete change for the admin to approve.',
      inputSchema: z.object({
        message: z.string().describe('One or two friendly sentences introducing the proposal.'),
        title: z.string().max(80),
        request: z.string().describe('Complete, self-contained instructions for the coding agent.'),
        criteria: z.array(z.string()).min(1).max(6),
      }),
      execute: async (p) => {
        result = { kind: 'propose', text: p.message, proposal: { title: p.title, request: p.request, criteria: p.criteria } };
        return 'ok';
      },
    }),
  };
  const context = [
    `Product: ${o.product}`,
    o.feature
      ? `This feature is "${o.feature.title}" (status: ${o.feature.status}). Current request: ${o.feature.request}. Current criteria: ${o.feature.criteria.join(' | ')}`
      : 'This is a new feature (nothing built yet).',
    `Their other features: ${o.otherFeatures.length ? o.otherFeatures.map((c) => `"${c}"`).join(', ') : 'none'}`,
  ].join('\n');
  const transcript = o.conversation.map((t) => `${t.role === 'user' ? 'Admin' : 'You'}: ${t.text}`).join('\n');
  const r = await generateText({
    model: o.model,
    instructions: INSTRUCTIONS,
    prompt: `${context}\n\nConversation so far:\n${transcript}\n\nRespond to the admin's last message by calling reply or propose.`,
    tools,
    stopWhen: [isStepCount(3), hasToolCall('reply'), hasToolCall('propose')],
    ...(o.abortSignal ? { abortSignal: o.abortSignal } : {}),
  });
  if (result) return result;
  // Models sometimes answer in plain text instead of calling `reply` (and forced tool choice isn't available on
  // every model). That text is the reply.
  const text = r.text.trim();
  return { kind: 'reply', text: text || "Sorry, I didn't catch that. What would you like to change?" };
}
