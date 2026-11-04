import { randomBytes } from 'node:crypto';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type Job<R = unknown> = {
  id: string;
  kind: string;
  tenantId: string | null;
  /** What the job is about (e.g. a feature id). */
  ref?: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  log: string[];
  result?: R;
  error?: string;
};

/** In-process job queue. Jobs for the same tenant run one at a time; different tenants run in parallel (bounded). */
export class JobQueue {
  private jobs = new Map<string, Job>();
  private tails = new Map<string, Promise<unknown>>();
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly concurrency = 4) {}

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(tenantId?: string): Job[] {
    return [...this.jobs.values()].filter((j) => !tenantId || j.tenantId === tenantId).reverse();
  }

  /**
   * `coordinator` jobs (e.g. a rollout that waits on per-tenant jobs) don't take a concurrency slot,
   * so they can never deadlock the queue.
   */
  enqueue<R>(
    kind: string,
    tenantId: string | null,
    run: (log: (line: string) => void) => Promise<R>,
    opts: { coordinator?: boolean; ref?: string } = {},
  ): Job<R> {
    const job: Job<R> = {
      id: `job_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
      kind,
      tenantId,
      ...(opts.ref ? { ref: opts.ref } : {}),
      status: 'queued',
      createdAt: new Date().toISOString(),
      log: [],
    };
    this.jobs.set(job.id, job as Job);
    const key = tenantId ?? `_global_${job.id}`;
    const prev = this.tails.get(key) ?? Promise.resolve();
    const done = prev.then(async () => {
      if (!opts.coordinator) await this.slot();
      job.status = 'running';
      try {
        job.result = await run((line) => job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`));
        job.status = 'done';
      } catch (e) {
        job.status = 'failed';
        job.error = (e as Error).message;
      } finally {
        job.finishedAt = new Date().toISOString();
        if (!opts.coordinator) this.release();
      }
    });
    this.tails.set(key, done);
    return job;
  }

  /** Resolves when the job finishes (for tests and the CLI). */
  async wait(id: string, timeoutMs = 30 * 60_000): Promise<Job> {
    const start = Date.now();
    for (;;) {
      const j = this.jobs.get(id);
      if (!j) throw new Error(`unknown job ${id}`);
      if (j.status === 'done' || j.status === 'failed') return j;
      if (Date.now() - start > timeoutMs) throw new Error(`job ${id} timed out`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async slot() {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
  }

  private release() {
    this.running--;
    this.waiting.shift()?.();
  }
}
