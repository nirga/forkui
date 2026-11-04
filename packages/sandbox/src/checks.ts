import type { Check } from '@forkui/core';
import type { Sandbox } from './types.ts';

export type CheckResult = {
  name: string;
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last part of combined output, for agents and humans. */
  output: string;
};

const TAIL = 8000;

/** Run vendor checks in order. Does not stop at the first failure (agents need the full picture). */
export async function runChecks(sandbox: Sandbox, checks: Check[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    const r = await sandbox.exec(c.run, { timeoutMs: c.timeoutMs });
    const output = `${r.stdout}\n${r.stderr}`.trim();
    results.push({
      name: c.name,
      ok: r.code === 0 && !r.timedOut,
      code: r.code,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      output: output.length > TAIL ? '…' + output.slice(-TAIL) : output,
    });
  }
  return results;
}
