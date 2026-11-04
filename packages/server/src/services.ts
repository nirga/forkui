import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultModelResolver, planTurn, type ChatTurn, type FeatureContext, type ModelResolver } from '@forkui/agent';
import { assertTenantId, isValidIntentId } from '@forkui/core';
import { buildRelease, editTenant, rebaseTenant, type EditReport, type EngineDeps, type RebaseReport } from '@forkui/engine';
import { GitStore } from '@forkui/git';
import { signToken } from '@forkui/node';
import { DependencyCache, LocalDriver, type SandboxDriver } from '@forkui/sandbox';
import { JobQueue } from './jobs.ts';
import { FeatureStore, FsArtifactStore, TenantStateStore, type ChatMessage, type PendingChange } from './storage.ts';

export type ServerOptions = {
  dataDir: string;
  secret: string;
  resolveModel?: ModelResolver;
  driver?: SandboxDriver;
  concurrency?: number;
  /** Origins allowed to embed the editor iframe (your app's origins). Default: any. */
  appOrigins?: string[];
  /** Your product's name, as the assistant should call it. */
  productName?: string;
};

export class StaleReleaseError extends Error {
  override name = 'StaleReleaseError';
}

/** A request that conflicts with the current state (e.g. a second unpublished change). */
export class ConflictError extends Error {
  override name = 'ConflictError';
}

const msgId = () => `m_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
const now = () => new Date().toISOString();

export type EditResult = { report: EditReport; releaseId?: string; previewGrant?: string };
export type RolloutTenantResult = { tenantId: string; outcome: RebaseReport['outcome'] | 'error'; releaseId?: string | null; reason?: string };

/** Everything the HTTP layer needs, wired together. Usable without HTTP (CLI `dev`, tests). */
export class ForkuiServices {
  readonly artifacts: FsArtifactStore;
  readonly tenants: TenantStateStore;
  readonly jobs: JobQueue;
  readonly features: FeatureStore;
  private constructor(
    readonly opts: ServerOptions,
    readonly store: GitStore,
    readonly engine: EngineDeps,
  ) {
    this.artifacts = new FsArtifactStore(join(opts.dataDir, 'artifacts'));
    this.tenants = new TenantStateStore(join(opts.dataDir, 'state'));
    this.jobs = new JobQueue(opts.concurrency ?? 4);
    this.features = new FeatureStore(join(opts.dataDir, 'state'));
  }

  static async create(opts: ServerOptions): Promise<ForkuiServices> {
    if (opts.secret.length < 32) throw new Error('FORKUI_SECRET must be at least 32 characters');
    const store = await GitStore.init(join(opts.dataDir, 'store'));
    const driver = opts.driver ?? new LocalDriver({ envAllow: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'npm_config_cache'] });
    const engine: EngineDeps = {
      store,
      driver,
      deps: new DependencyCache(join(opts.dataDir, 'deps'), driver),
      resolveModel: opts.resolveModel ?? defaultModelResolver,
    };
    return new ForkuiServices(opts, store, engine);
  }

  /**
   * Import a base release from a git bundle (what `forkui release` uploads), a local repo path,
   * or a commit the store already has (`sha`, no upload). Idempotent for the same commit.
   */
  async importBase(o: { version: string; ref: string; bundle?: Uint8Array; repoPath?: string; sha?: string }) {
    if (!o.bundle && !o.repoPath) {
      if (!o.sha) throw new Error('importBase needs a bundle, a repoPath or a known sha');
      return this.store.tagBase(o.sha, o.version);
    }
    let source = o.repoPath;
    let tmp: string | null = null;
    if (o.bundle) {
      tmp = join(this.opts.dataDir, 'incoming', `${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
      await mkdir(join(this.opts.dataDir, 'incoming'), { recursive: true });
      await writeFile(tmp, o.bundle);
      source = tmp;
    }
    try {
      return await this.store.importBase(source!, o.ref, o.version);
    } finally {
      if (tmp) await rm(tmp, { force: true });
    }
  }

  private engineFor(log: (l: string) => void): EngineDeps {
    return {
      ...this.engine,
      onEvent: (e) => {
        if (e.type === 'phase') log(`${e.phase}${e.detail ? ` (${e.detail})` : ''}`);
        else if (e.type === 'tool') {
          const input = e.event.input as { path?: string; glob?: string; pattern?: string } | undefined;
          const what = input?.path ?? input?.glob ?? input?.pattern ?? '';
          log(`  ${e.event.ok ? '·' : '✗'} ${e.event.tool}${what ? ` ${what}` : ''}${e.event.note ? `: ${e.event.note}` : ''}`);
        }
      },
    };
  }

  /**
   * Queue a tenant edit. On success the result is a *preview* release and becomes the tenant's pending change;
   * publishing is a separate step. Only one unpublished change at a time.
   */
  requestEdit(
    tenantId: string,
    req: {
      intentId?: string;
      title: string;
      request: string;
      spec?: string;
      criteria?: string[];
      author?: { name: string; email: string };
      revise?: { previous: { request: string; spec: string } };
    },
  ) {
    assertTenantId(tenantId);
    return this.jobs.enqueue<EditResult>('edit', tenantId, async (log) => {
      if ((await this.tenants.get(tenantId)).pending) throw new ConflictError('There is already an unpublished change. Publish or discard it first.');
      if (!(await this.store.resolve(`refs/heads/tenants/${tenantId}`))) {
        const latest = await this.store.latestBase();
        if (!latest) throw new Error('No base release yet. Run `forkui release` first.');
        await this.store.createTenant(tenantId, latest.version);
        log(`created tenant on base ${latest.version}`);
      }
      const intents = await this.store.listIntents(tenantId);
      const used = new Set(intents.map((i) => i.trailers?.intentId));
      let n = intents.length + 1;
      while (used.has(`c${n}`)) n++;
      const intentId = req.intentId ?? `c${n}`;
      if (!isValidIntentId(intentId)) throw new Error(`Invalid intent id ${intentId}`);
      const criteria = req.criteria ?? [];
      const spec = req.spec ?? (criteria.length ? criteria.map((c) => `- ${c}`).join('\n') : req.request);
      const engine = this.engineFor(log);
      const report = await editTenant(engine, {
        tenantId,
        intentId,
        title: req.title,
        request: req.request,
        spec,
        ...(req.author ? { author: req.author } : {}),
        ...(req.revise ? { revise: req.revise } : {}),
      });
      if (report.outcome !== 'committed') return { report };
      const release = await buildRelease(engine, this.artifacts, { tenantId, sha: report.head! });
      const previewGrant = await signToken({ typ: 'preview', t: tenantId, r: release.releaseId }, this.opts.secret, 3600);
      await this.tenants.update(tenantId, (st) => {
        st.pending = {
          intentId,
          title: req.title,
          request: req.request,
          criteria: criteria.length ? criteria : [spec],
          sha: report.head!,
          releaseId: release.releaseId,
          by: req.author?.name ?? 'editor',
          at: now(),
        };
      });
      log(`preview release ${release.releaseId}`);
      return { report, releaseId: release.releaseId, previewGrant };
    }, req.intentId ? { ref: req.intentId } : {});
  }

  /** A fresh preview grant for the tenant's pending change. */
  async previewGrant(tenantId: string): Promise<string | null> {
    const p = (await this.tenants.get(tenantId)).pending;
    return p ? signToken({ typ: 'preview', t: tenantId, r: p.releaseId }, this.opts.secret, 3600) : null;
  }

  /** Publish the pending change. */
  async publishPending(tenantId: string, by: string) {
    const p = (await this.tenants.get(tenantId)).pending;
    if (!p) throw new ConflictError('Nothing to publish');
    return this.publish(tenantId, p.releaseId, by);
  }

  /** Remove the pending change from the branch (it was never live). */
  async discardPending(tenantId: string): Promise<PendingChange> {
    const st = await this.tenants.get(tenantId);
    const p = st.pending;
    if (!p) throw new ConflictError('Nothing to discard');
    const parent = await this.store.resolve(`${p.sha}^`);
    if (!parent) throw new Error('Cannot find the previous version');
    await this.store.updateTenant(tenantId, parent, p.sha);
    await this.tenants.update(tenantId, (s2) => {
      s2.pending = null;
    });
    return p;
  }

  /** Make a release live. Only a release of the tenant's current branch head can be published. */
  async publish(tenantId: string, releaseId: string | null, by: string) {
    if (releaseId) {
      const m = await this.artifacts.getRelease(releaseId);
      if (!m || m.tenantId !== tenantId) throw new Error('No such release for this tenant');
      if (m.sha !== (await this.store.tenantHead(tenantId)))
        throw new StaleReleaseError('This preview is out of date (newer changes or an update landed since). Make the change again.');
    }
    const st = await this.tenants.publish(tenantId, releaseId, by);
    if (releaseId && st.pending?.releaseId === releaseId)
      return this.tenants.update(tenantId, (s2) => {
        s2.pending = null;
      });
    return st;
  }

  /** Undo an unpublished edit (legacy route; same as discardPending for that job's change). */
  async discard(tenantId: string, jobId: string) {
    const job = this.jobs.get(jobId);
    const result = job?.tenantId === tenantId ? (job.result as EditResult | undefined) : undefined;
    const pending = (await this.tenants.get(tenantId)).pending;
    if (!result?.report.head || !pending || pending.sha !== result.report.head) throw new Error('Nothing to discard');
    await this.discardPending(tenantId);
  }

  /** Carry every tenant to a base release: rebase, build, publish. Pinned tenants keep their current release. */
  rollout(version: string) {
    return this.jobs.enqueue<RolloutTenantResult[]>('rollout', null, async (log) => {
      const tenants = await this.store.listTenants();
      log(`carrying ${tenants.length} customer${tenants.length === 1 ? '' : 's'} onto ${version}`);
      // One job per tenant: serialized with that tenant's edits, run in parallel across tenants
      // (bounded by the queue's concurrency).
      const jobs = tenants.map(({ tenantId }) => ({
        tenantId,
        job: this.jobs.enqueue<RolloutTenantResult>('rebase', tenantId, async (tlog) => {
          const engine = this.engineFor((l) => {
            tlog(l);
            log(`[${tenantId}] ${l}`);
          });
          const report = await rebaseTenant(engine, tenantId, version);
          if (report.outcome === 'pinned') {
            await this.tenants.update(tenantId, (s) => {
              s.pinned = { toVersion: version, reason: report.reason ?? 'Could not be carried over', at: new Date().toISOString() };
            });
            return { tenantId, outcome: 'pinned', reason: report.reason ?? '' };
          }
          const before = await this.tenants.update(tenantId, (s) => {
            s.pinned = null;
          });
          if (report.outcome === 'up-to-date') return { tenantId, outcome: 'up-to-date', releaseId: before.current };
          const head = await this.store.tenantHead(tenantId);
          const intents = await this.store.listIntents(tenantId);
          // The pending (unpublished) change is the top commit. Keep it a preview: rebuild it, never publish it.
          const pending = before.pending ? intents.at(-1) : undefined;
          if (before.pending && pending?.trailers?.intentId === before.pending.intentId) {
            const preview = await buildRelease(engine, this.artifacts, { tenantId, sha: head });
            await this.tenants.update(tenantId, (s) => {
              s.pending = { ...before.pending!, sha: head, releaseId: preview.releaseId };
            });
          }
          // Only republish tenants that were live. An unpublished preview or a "standard app" choice
          // must not go live just because the vendor shipped.
          if (!before.current) return { tenantId, outcome: report.outcome, releaseId: null };
          const liveSha = before.pending ? await this.store.resolve(`${head}^`) : head;
          const liveIntents = before.pending ? intents.length - 1 : intents.length;
          if (!liveSha || liveIntents === 0) {
            await this.tenants.publish(tenantId, null, `rollout ${version}`); // nothing live left: vendor's own deploy
            return { tenantId, outcome: report.outcome, releaseId: null };
          }
          const release = await buildRelease(engine, this.artifacts, { tenantId, sha: liveSha });
          await this.tenants.publish(tenantId, release.releaseId, `rollout ${version}`);
          return { tenantId, outcome: report.outcome, releaseId: release.releaseId };
        }),
      }));
      return Promise.all(
        jobs.map(async ({ tenantId, job }) => {
          const done = await this.jobs.wait(job.id);
          const r = (done.result as RolloutTenantResult | undefined) ?? { tenantId, outcome: 'error' as const, reason: done.error ?? 'unknown error' };
          log(`[${tenantId}] => ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`);
          return r;
        }),
      );
    }, { coordinator: true });
  }
  // ---------------- features ----------------
  // A feature = one named customization. Its conversation lives in FeatureStore; everything built lives in git:
  // its versions are the branch commits with Forkui-Intent-Id = feature id (a revision adds a commit on top).

  private async modelSpec(tenantId: string): Promise<string> {
    const exists = await this.store.resolve(`refs/heads/tenants/${tenantId}`);
    const base = exists ? await this.store.tenantBase(tenantId) : await this.store.latestBase();
    if (!base) throw new Error('No base release yet.');
    return (await this.store.readConfig(base.version)).agent.model;
  }

  /** Current (latest) built version of every feature, from git. */
  private async builtVersions(tenantId: string) {
    const exists = await this.store.resolve(`refs/heads/tenants/${tenantId}`);
    const intents = exists ? await this.store.listIntents(tenantId) : [];
    const out = new Map<string, { title: string; request: string; criteria: string[]; shas: string[]; specPath?: string }>();
    for (const i of intents) {
      const id = i.trailers?.intentId;
      if (!id) continue;
      const spec = i.trailers?.spec ? await this.store.readFile(i.sha, i.trailers.spec) : null;
      const criteria = spec
        ? spec.split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)
        : [i.trailers!.intent];
      const prev = out.get(id);
      out.set(id, {
        title: i.subject,
        request: i.trailers!.intent,
        criteria,
        shas: [...(prev?.shas ?? []), i.sha],
        ...(i.trailers?.spec ? { specPath: i.trailers.spec } : {}),
      });
    }
    return out;
  }

  static NOT_READY =
    "Customization isn't set up yet: the app's team needs to publish a first version to forkui (npx forkui release). Try again after that.";

  /** All features with their status. */
  async listFeatures(tenantId: string) {
    // Snapshot running jobs BEFORE reading state: a job that finishes in between is then either still
    // "busy" here, or its state change is already visible below. (The reverse order shows stale state as settled.)
    const running = this.jobs.list(tenantId).filter((j) => j.status === 'queued' || j.status === 'running');
    const st = await this.tenants.get(tenantId);
    const built = await this.builtVersions(tenantId);
    const live = st.current ? await this.artifacts.getRelease(st.current) : null;
    const records = new Map((await this.features.list(tenantId)).map((r) => [r.id, r]));
    const ids = new Set([...records.keys(), ...built.keys()]);
    const out = [];
    for (const id of ids) {
      const r = records.get(id);
      const b = built.get(id);
      let isLive = false;
      if (live && b) for (const sha of b.shas) if (sha !== st.pending?.sha && (await this.store.isAncestor(sha, live.sha))) isLive = true;
      const building = running.some((j) => j.ref === id && j.kind === 'edit');
      const thinking = running.some((j) => j.ref === id && j.kind === 'plan');
      const status: FeatureContext['status'] | 'building' = building
        ? 'building'
        : st.pending?.intentId === id
          ? 'preview'
          : b && st.pinned
            ? 'paused'
            : isLive
              ? 'live'
              : b
                ? 'off'
                : 'draft';
      const last = r?.messages.at(-1);
      out.push({
        id,
        title: r?.title ?? b?.title ?? 'Untitled',
        status,
        liveToo: isLive && st.pending?.intentId === id, // a revision is in preview while an older version is live
        busy: building || thinking,
        createdBy: r?.createdBy ?? null,
        updatedAt: r?.updatedAt ?? null,
        lastMessage: last ? { role: last.role, text: last.text.slice(0, 140) } : null,
        built: b ? { title: b.title, request: b.request, criteria: b.criteria } : null,
      });
    }
    out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const ready = !!(await this.store.latestBase());
    return { features: out, pending: st.pending ?? null, live: !!st.current, pinned: st.pinned, ready };
  }

  async getFeature(tenantId: string, id: string) {
    const all = await this.listFeatures(tenantId);
    const feature = all.features.find((f) => f.id === id);
    if (!feature) return null;
    const r = await this.features.get(tenantId, id);
    return { feature, messages: r?.messages ?? [], pending: all.pending, pinned: all.pinned };
  }

  private async newFeatureId(tenantId: string): Promise<string> {
    const taken = new Set([...(await this.features.list(tenantId)).map((r) => r.id), ...(await this.builtVersions(tenantId)).keys()]);
    let n = taken.size + 1;
    while (taken.has(`f${n}`)) n++;
    return `f${n}`;
  }

  private say(tenantId: string, id: string, m: Omit<ChatMessage, 'id' | 'at' | 'role'> & { role?: ChatMessage['role'] }) {
    return this.features.update(tenantId, id, (r) => {
      r.messages.push({ id: msgId(), at: now(), role: 'assistant', ...m });
    });
  }

  /** Start a new feature with its first message. */
  async createFeature(tenantId: string, userId: string, text: string) {
    assertTenantId(tenantId);
    const id = await this.newFeatureId(tenantId);
    const title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    await this.features.update(tenantId, id, () => {}, () => ({ id, title, createdBy: userId, createdAt: now(), updatedAt: now(), messages: [] }));
    const job = await this.featureMessage(tenantId, userId, id, text);
    return { featureId: id, jobId: job.id };
  }

  async deleteFeature(tenantId: string, id: string) {
    if ((await this.builtVersions(tenantId)).has(id))
      throw new ConflictError('This feature is built. Discard its preview, or ask for its removal in the chat.');
    await this.features.remove(tenantId, id);
  }

  /** The admin said something in a feature's chat: the planner replies or proposes its (new) definition. */
  async featureMessage(tenantId: string, userId: string, id: string, text: string, product = this.opts.productName ?? 'this app') {
    assertTenantId(tenantId);
    const built = (await this.builtVersions(tenantId)).get(id);
    await this.features.update(
      tenantId,
      id,
      (r) => {
        r.messages.push({ id: msgId(), at: now(), role: 'user', kind: 'text', text, author: userId });
      },
      () => ({ id, title: built?.title ?? text.slice(0, 60), createdBy: userId, createdAt: now(), updatedAt: now(), messages: [] }),
    );
    return this.jobs.enqueue(
      'plan',
      tenantId,
      async () => {
        if (!(await this.store.latestBase())) return this.say(tenantId, id, { kind: 'notice', text: ForkuiServices.NOT_READY });
        try {
          const r = (await this.features.get(tenantId, id))!;
          const conversation: ChatTurn[] = r.messages.slice(-30).map((m) => ({
            role: m.role,
            text:
              m.kind === 'proposal' && m.proposal
                ? `${m.text} [Proposed: ${m.proposal.title}. Done when: ${m.proposal.criteria.join('; ')}]`
                : m.role === 'user' && m.author
                  ? `(${m.author}) ${m.text}`
                  : m.text,
          }));
          const list = await this.listFeatures(tenantId);
          const me = list.features.find((f) => f.id === id);
          const result = await planTurn({
            model: await this.engine.resolveModel(await this.modelSpec(tenantId)),
            product,
            conversation,
            feature:
              me?.built && me.status !== 'draft'
                ? { ...me.built, status: me.status === 'building' ? 'preview' : (me.status as FeatureContext['status']) }
                : null,
            otherFeatures: list.features.filter((f) => f.id !== id).map((f) => f.title),
          });
          if (result.kind === 'reply') await this.say(tenantId, id, { kind: 'text', text: result.text });
          else
            await this.features.update(tenantId, id, (rec) => {
              for (const m of rec.messages) if (m.kind === 'proposal' && m.status === 'proposed') m.status = 'superseded';
              if (!built) rec.title = result.proposal.title; // drafts take the proposal's name
              rec.messages.push({ id: msgId(), at: now(), role: 'assistant', kind: 'proposal', text: result.text, proposal: result.proposal, status: 'proposed' });
            });
        } catch (e) {
          await this.say(tenantId, id, { kind: 'notice', text: `I couldn't reach the AI model: ${(e as Error).message}` });
        }
      },
      { ref: id },
    );
  }

  /** Build an approved proposal: a new feature, a revision of a live one, or a replacement of its preview. */
  async featureBuild(tenantId: string, userId: string, id: string, messageId: string) {
    const r = await this.features.get(tenantId, id);
    const msg = r?.messages.find((m) => m.id === messageId && m.kind === 'proposal');
    if (!msg?.proposal || msg.status !== 'proposed') throw new ConflictError('That proposal is no longer open.');
    const st = await this.tenants.get(tenantId);
    if (st.pending && st.pending.intentId !== id)
      throw new ConflictError(`Publish or discard “${st.pending.title}” first. One unpublished feature at a time.`);
    if (st.pending?.intentId === id) await this.discardPending(tenantId); // the new version replaces the preview
    const previous = (await this.builtVersions(tenantId)).get(id);
    const job = this.requestEdit(tenantId, {
      intentId: id,
      title: msg.proposal.title,
      request: msg.proposal.request,
      criteria: msg.proposal.criteria,
      author: { name: userId, email: `${userId}@${tenantId}.forkui` },
      ...(previous ? { revise: { previous: { request: previous.request, spec: previous.criteria.map((c) => `- ${c}`).join('\n') } } } : {}),
    });
    await this.features.update(tenantId, id, (rec) => {
      const m = rec.messages.find((x) => x.id === messageId);
      if (m) m.status = 'building';
      rec.title = msg.proposal!.title;
      rec.messages.push({ id: msgId(), at: now(), role: 'assistant', kind: 'build', text: `Working on “${msg.proposal!.title}”…`, jobId: job.id });
    });
    void this.jobs.wait(job.id).then(async (done) => {
      const res = done.result as EditResult | undefined;
      const built = done.status === 'done' && res?.report.outcome === 'committed';
      // A failed or rejected build reopens its proposal, so the admin can retry with one click.
      await this.features.update(tenantId, id, (rec) => {
        const m = rec.messages.find((x) => x.id === messageId);
        if (m) m.status = built ? 'done' : 'proposed';
      });
      if (done.status === 'failed' || !res)
        return this.say(tenantId, id, { kind: 'result', outcome: 'failed', text: `Something went wrong: ${done.error ?? 'unknown error'}`, jobId: job.id });
      const summary = res.report.attempts.map((a) => a.agent?.outcome).find((o) => o?.kind === 'finished');
      if (res.report.outcome === 'committed')
        return this.say(tenantId, id, {
          kind: 'result',
          outcome: 'committed',
          text: `${summary?.kind === 'finished' ? summary.summary : 'Done.'} It's ready to preview. Only you can see it until you publish.`,
          jobId: job.id,
          ...(res.releaseId ? { releaseId: res.releaseId } : {}),
        });
      return this.say(tenantId, id, {
        kind: 'result',
        outcome: res.report.outcome,
        text:
          res.report.outcome === 'pinned'
            ? res.report.reason ?? "I couldn't make that change safely."
            : `I couldn't make that change safely. ${res.report.reason ?? ''} You can rephrase it and try again.`,
        jobId: job.id,
      });
    });
    return job;
  }

  async featurePublish(tenantId: string, userId: string, id: string) {
    const p = (await this.tenants.get(tenantId)).pending;
    if (p?.intentId !== id) throw new ConflictError('This feature has nothing waiting to be published.');
    await this.publishPending(tenantId, userId);
    await this.say(tenantId, id, { kind: 'notice', outcome: 'published', text: `${userId} published “${p.title}” for everyone in your organization.` });
  }

  async featureDiscard(tenantId: string, userId: string, id: string) {
    const p = (await this.tenants.get(tenantId)).pending;
    if (p?.intentId !== id) throw new ConflictError('This feature has nothing waiting to be published.');
    await this.discardPending(tenantId);
    const stillBuilt = (await this.builtVersions(tenantId)).has(id);
    await this.say(tenantId, id, {
      kind: 'notice',
      outcome: 'discarded',
      text: stillBuilt ? `${userId} discarded the new version. The published version stays as it was.` : `${userId} discarded it. Nothing changed for your team.`,
    });
  }
}
