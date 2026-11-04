import type { AgentRun, ModelResolver, ToolEvent } from '@forkui/agent';
import type { GitStore } from '@forkui/git';
import type { DependencyCache, SandboxDriver, CheckResult } from '@forkui/sandbox';
import type { Violation } from '@forkui/policy';

export type EngineEvent =
  | { type: 'phase'; tenantId: string; phase: string; detail?: string }
  | { type: 'tool'; tenantId: string; model: string; event: ToolEvent }
  | { type: 'attempt'; tenantId: string; attempt: Attempt };

export type EngineDeps = {
  store: GitStore;
  driver: SandboxDriver;
  deps: DependencyCache;
  resolveModel: ModelResolver;
  onEvent?: (e: EngineEvent) => void;
};

export type Verification = {
  ok: boolean;
  problems: string[];
  violations: Violation[];
  checks: CheckResult[];
};

export type Attempt = {
  /** "git" for a plain rebase, otherwise the model spec. */
  by: string;
  agent?: Omit<AgentRun, 'outcome'> & { outcome: AgentRun['outcome'] };
  verification: Verification;
};

export type RebaseOutcome = 'up-to-date' | 'clean' | 'resolved' | 'pinned';

export type RebaseReport = {
  tenantId: string;
  from: string;
  to: string;
  outcome: RebaseOutcome;
  /** New tenant head when the branch moved. */
  head?: string;
  previousHead: string;
  /** Plain-language explanation when pinned. */
  reason?: string;
  attempts: Attempt[];
};

export type EditRequest = {
  tenantId: string;
  intentId: string;
  /** Commit subject, e.g. "Add Priority column". */
  title: string;
  /** What the tenant asked for. */
  request: string;
  /** The approved natural-language acceptance spec. Frozen once committed. */
  spec: string;
  author?: { name: string; email: string };
  /**
   * Revise an existing feature: adds a new commit with the same intent id on top, and allows that
   * feature's spec and test to change (an approved amendment). `previous` is the version being revised.
   */
  revise?: { previous: { request: string; spec: string } };
};

export type EditOutcome = 'committed' | 'rejected' | 'pinned';

export type EditReport = {
  tenantId: string;
  intentId: string;
  outcome: EditOutcome;
  head?: string;
  previousHead: string;
  reason?: string;
  attempts: Attempt[];
};
