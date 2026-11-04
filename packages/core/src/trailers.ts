/** Structured metadata stored as git trailers on every tenant intent commit. */
export type IntentTrailers = {
  intentId: string;
  /** The tenant's request, as approved. Single line. */
  intent: string;
  /** Path to the frozen natural-language spec, relative to repo root. */
  spec?: string;
  /** Path to the compiled acceptance test, relative to repo root. */
  test?: string;
};

const KEYS = {
  intentId: 'Forkui-Intent-Id',
  intent: 'Forkui-Intent',
  spec: 'Forkui-Spec',
  test: 'Forkui-Test',
} as const satisfies Record<keyof IntentTrailers, string>;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidIntentId(id: string): boolean {
  return ID_RE.test(id);
}

/** Build a full commit message: subject, optional body, then trailers. */
export function formatIntentMessage(subject: string, t: IntentTrailers, body?: string): string {
  if (!isValidIntentId(t.intentId)) throw new Error(`Invalid intent id: ${t.intentId}`);
  const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();
  const lines = [`${KEYS.intentId}: ${t.intentId}`, `${KEYS.intent}: ${oneLine(t.intent)}`];
  if (t.spec) lines.push(`${KEYS.spec}: ${t.spec}`);
  if (t.test) lines.push(`${KEYS.test}: ${t.test}`);
  return [oneLine(subject), body?.trim(), lines.join('\n')].filter(Boolean).join('\n\n') + '\n';
}

/** Parse forkui trailers from a commit message. Returns null if this is not an intent commit. */
export function parseIntentTrailers(message: string): IntentTrailers | null {
  // Trailers are the last paragraph.
  const paragraphs = message.trimEnd().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? '';
  const found: Partial<Record<keyof IntentTrailers, string>> = {};
  for (const line of last.split('\n')) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!m) continue;
    const entry = (Object.entries(KEYS) as [keyof IntentTrailers, string][]).find(
      ([, k]) => k.toLowerCase() === m[1]!.toLowerCase(),
    );
    if (entry) found[entry[0]] = m[2]!.trim();
  }
  if (!found.intentId || !found.intent || !isValidIntentId(found.intentId)) return null;
  return {
    intentId: found.intentId,
    intent: found.intent,
    ...(found.spec ? { spec: found.spec } : {}),
    ...(found.test ? { test: found.test } : {}),
  };
}
