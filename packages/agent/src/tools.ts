import picomatch from 'picomatch';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ForkuiConfig } from '@forkui/core';
import type { RebaseState, Worktree } from '@forkui/git';
import { createWriteGuard } from '@forkui/policy';
import { runChecks, SandboxPathError, type Sandbox } from '@forkui/sandbox';

export type AgentMode = 'edit' | 'rebase';

export type AgentOutcome = { kind: 'finished'; summary: string } | { kind: 'pinned'; reason: string };

export type ToolEvent = { tool: string; input: unknown; ok: boolean; note?: string };

export type ToolContext = {
  sandbox: Sandbox;
  worktree: Worktree;
  config: ForkuiConfig;
  mode: AgentMode;
  /** Tenant test/spec paths the agent may write (edit mode: the new intent's compiled test). */
  writableTenantTests?: string[];
  /** Rebase mode: the base the tenant is being rebased onto (for fixups). */
  ontoRef?: string;
  onEvent?: (e: ToolEvent) => void;
};

const MAX_READ = 200_000;
const MAX_LIST = 1000;
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'blame', 'grep']);

function describeRebase(state: RebaseState): string {
  if (state.status === 'done') return `Rebase complete. HEAD is ${state.head.slice(0, 10)}. Run the checks next.`;
  return [
    `Rebase stopped with conflicts while applying "${state.stoppedAt.subject}" (${state.stoppedAt.sha.slice(0, 10)}).`,
    `Conflicted files: ${state.files.join(', ') || '(none listed; check git status)'}.`,
    'Resolve them (write the final content, no conflict markers), then call rebase_continue.',
  ].join('\n');
}

/** The tool surface given to agents. No shell: every action is a named, guarded operation. */
export function createTools(ctx: ToolContext): { tools: ToolSet; outcome: () => AgentOutcome | null } {
  const { sandbox, worktree, config } = ctx;
  const guard = createWriteGuard(config, { writableTenantTests: ctx.writableTenantTests ?? [] });
  let outcome: AgentOutcome | null = null;
  const emit = (e: ToolEvent) => ctx.onEvent?.(e);

  const guarded = async (name: string, input: unknown, fn: () => Promise<string>): Promise<string> => {
    try {
      const out = await fn();
      emit({ tool: name, input, ok: true });
      return out;
    } catch (e) {
      const msg = e instanceof SandboxPathError ? e.message : `Error: ${(e as Error).message}`;
      emit({ tool: name, input, ok: false, note: msg });
      return msg;
    }
  };

  const denyWrite = (name: string, path: string, input: unknown): string | null => {
    const reason = guard(path);
    if (!reason) return null;
    emit({ tool: name, input, ok: false, note: reason });
    return `Refused: ${reason}.`;
  };

  const tools: ToolSet = {
    list_files: tool({
      description: 'List tracked and untracked files in the repo, optionally filtered by a glob (e.g. "src/**/*.tsx").',
      inputSchema: z.object({ glob: z.string().optional() }),
      execute: (input) =>
        guarded('list_files', input, async () => {
          const out = (await worktree.git(['ls-files', '--cached', '--others', '--exclude-standard'])).stdout;
          const match = input.glob ? picomatch(input.glob, { dot: true }) : () => true;
          const files = [...new Set(out.split('\n').filter(Boolean))].filter((f) => match(f));
          const shown = files.slice(0, MAX_LIST).join('\n');
          return files.length > MAX_LIST ? `${shown}\n… ${files.length - MAX_LIST} more` : shown || '(no files)';
        }),
    }),

    read_file: tool({
      description: 'Read a UTF-8 text file (path relative to repo root).',
      inputSchema: z.object({ path: z.string() }),
      execute: (input) =>
        guarded('read_file', input, async () => {
          const c = await sandbox.readFile(input.path);
          if (c === null) return `Not found: ${input.path}`;
          return c.length > MAX_READ ? c.slice(0, MAX_READ) + `\n… truncated (${c.length} chars)` : c;
        }),
    }),

    search: tool({
      description: 'Search file contents with an extended regex (git grep). Returns path:line:text.',
      inputSchema: z.object({ pattern: z.string(), glob: z.string().optional() }),
      execute: (input) =>
        guarded('search', input, async () => {
          const args = ['grep', '-n', '-I', '-E', '--untracked', '-e', input.pattern];
          if (input.glob) args.push('--', input.glob);
          const r = await worktree.git(args, { allowFail: true });
          if (r.code === 1) return 'No matches.';
          if (r.code !== 0) return `Error: ${r.stderr.trim()}`;
          const lines = r.stdout.split('\n').filter(Boolean);
          return lines.slice(0, 300).join('\n') + (lines.length > 300 ? `\n… ${lines.length - 300} more` : '');
        }),
    }),

    write_file: tool({
      description: 'Create or overwrite a file with the full given content.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async (input) =>
        denyWrite('write_file', input.path, { path: input.path }) ??
        guarded('write_file', { path: input.path }, async () => {
          await sandbox.writeFile(input.path, input.content);
          return `Wrote ${input.path} (${input.content.length} chars).`;
        }),
    }),

    edit_file: tool({
      description: 'Replace exactly one occurrence of old_string with new_string in a file. old_string must be unique.',
      inputSchema: z.object({ path: z.string(), old_string: z.string().min(1), new_string: z.string() }),
      execute: async (input) =>
        denyWrite('edit_file', input.path, { path: input.path }) ??
        guarded('edit_file', { path: input.path }, async () => {
          const c = await sandbox.readFile(input.path);
          if (c === null) return `Not found: ${input.path}`;
          const count = c.split(input.old_string).length - 1;
          if (count !== 1) return `old_string must occur exactly once in ${input.path}; found ${count}. Add more context.`;
          await sandbox.writeFile(input.path, c.replace(input.old_string, () => input.new_string));
          return `Edited ${input.path}.`;
        }),
    }),

    delete_file: tool({
      description: 'Delete a file.',
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) =>
        denyWrite('delete_file', input.path, input) ??
        guarded('delete_file', input, async () => ((await sandbox.removeFile(input.path)) ? `Deleted ${input.path}.` : `Not found: ${input.path}`)),
    }),

    git: tool({
      description: `Run a read-only git command. Allowed subcommands: ${[...READ_ONLY_GIT].join(', ')}. Example: {"args": ["diff", "base/v1", "base/v2", "--stat"]}`,
      inputSchema: z.object({ args: z.array(z.string()).min(1) }),
      execute: (input) =>
        guarded('git', input, async () => {
          const [sub, ...rest] = input.args;
          if (!sub || !READ_ONLY_GIT.has(sub)) return `Refused: only ${[...READ_ONLY_GIT].join(', ')} are allowed.`;
          if (rest.some((a) => /^--(output|ext-diff|exec|upload-pack|textconv|no-index|open-files-in-pager|git-dir|work-tree)/.test(a) || /^-O/.test(a)))
            return 'Refused: that option is not allowed.';
          const safety = ['diff', 'log', 'show'].includes(sub) ? ['--no-ext-diff', '--no-textconv'] : [];
          const r = await worktree.git(['--no-pager', sub, ...safety, ...rest], { allowFail: true });
          const out = (r.stdout + (r.code ? `\n${r.stderr}` : '')).trim();
          return out.length > MAX_READ ? out.slice(0, MAX_READ) + '\n… truncated' : out || '(no output)';
        }),
    }),

    run_checks: tool({
      description: `Run the vendor's checks (${config.checks.map((c) => c.name).join(', ')}). Optionally pass names to run a subset.`,
      inputSchema: z.object({ names: z.array(z.string()).optional() }),
      execute: (input) =>
        guarded('run_checks', input, async () => {
          const selected = input.names?.length ? config.checks.filter((c) => input.names!.includes(c.name)) : config.checks;
          if (!selected.length) return `No such checks. Available: ${config.checks.map((c) => c.name).join(', ')}`;
          const results = await runChecks(sandbox, selected);
          return results
            .map((r) => (r.ok ? `PASS ${r.name}` : `FAIL ${r.name}${r.timedOut ? ' (timed out)' : ''}\n${r.output.slice(-3000)}`))
            .join('\n\n');
        }),
    }),

    finish: tool({
      description: 'Call when the task is complete and checks pass. Give a short summary per intent for the customer admin.',
      inputSchema: z.object({ summary: z.string() }),
      execute: async (input) => {
        outcome = { kind: 'finished', summary: input.summary };
        emit({ tool: 'finish', input, ok: true });
        return 'Recorded. Stop now.';
      },
    }),

    pin: tool({
      description:
        'Call instead of finish if an intent genuinely cannot be satisfied on this base without changing protected files. Explain in plain language a non-technical customer admin understands.',
      inputSchema: z.object({ reason: z.string() }),
      execute: async (input) => {
        outcome = { kind: 'pinned', reason: input.reason };
        emit({ tool: 'pin', input, ok: true });
        return 'Recorded. Stop now.';
      },
    }),
  };

  if (ctx.mode === 'rebase') {
    tools.rebase_continue = tool({
      description: 'Stage all changes and continue the in-progress rebase. Returns the next conflict, or that the rebase is complete.',
      inputSchema: z.object({}),
      execute: (input) =>
        guarded('rebase_continue', input, async () => {
          if (!(await worktree.rebaseInProgress())) return 'No rebase in progress.';
          await worktree.git(['add', '-A']);
          const left = await worktree.conflictedFiles();
          if (left.length) return `Still conflicted: ${left.join(', ')}`;
          return describeRebase(await worktree.continueRebase());
        }),
    });

    tools.amend_intent = tool({
      description:
        'After the rebase completes: fold your current uncommitted changes into the commit of the given intent id (keeps one commit per intent).',
      inputSchema: z.object({ intent_id: z.string() }),
      execute: (input) =>
        guarded('amend_intent', input, async () => {
          if (await worktree.rebaseInProgress()) return 'Finish the rebase first (rebase_continue).';
          if (!ctx.ontoRef) return 'Error: no base ref configured.';
          const log = (
            await worktree.git(['log', '--format=%H%x1f%(trailers:key=Forkui-Intent-Id,valueonly,separator=)', `${ctx.ontoRef}..HEAD`])
          ).stdout;
          const sha = log
            .split('\n')
            .map((l) => l.split('\x1f'))
            .find(([, id]) => id?.trim() === input.intent_id)?.[0];
          if (!sha) return `No commit for intent "${input.intent_id}" on top of the base.`;
          await worktree.git(['add', '-A']);
          const staged = (await worktree.git(['diff', '--cached', '--name-only'])).stdout.trim();
          if (!staged) return 'Nothing to amend.';
          await worktree.git(['-c', 'user.name=forkui', '-c', 'user.email=forkui@localhost', 'commit', '-q', `--fixup=${sha}`]);
          const r = await worktree.git(
            ['-c', 'user.name=forkui', '-c', 'user.email=forkui@localhost', 'rebase', '-q', '-i', '--autosquash', ctx.ontoRef],
            { allowFail: true },
          );
          if (r.code !== 0 && (await worktree.rebaseInProgress()))
            return describeRebase({ status: 'conflict', files: await worktree.conflictedFiles(), stoppedAt: { sha: '', subject: 'autosquash' } });
          return `Amended intent ${input.intent_id}.`;
        }),
    });
  }

  return { tools, outcome: () => outcome };
}
