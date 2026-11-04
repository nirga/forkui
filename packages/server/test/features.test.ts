import { afterEach, describe, expect, test } from 'vitest';
import { signToken } from '@forkui/node';
import { createApp, ForkuiServices } from '../src/index.ts';
import { scriptedModel, setupStore, priorityTestStable } from '../../engine/test/fixture.ts';
import { tmp } from '../../../test/helpers.ts';

const SECRET = 'feature-test-secret-feature-test-secret!';
let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

type Msg = { id: string; role: string; kind: string; text: string; status?: string; outcome?: string; author?: string };
type Feature = { id: string; title: string; status: string; liveToo: boolean; busy: boolean };
type Detail = { feature: Feature; messages: Msg[]; pending: { intentId: string; title: string } | null };

const propose = (title: string, criteria: string[]) =>
  scriptedModel('planner', [{ tool: 'propose', input: { message: `Here's the plan: ${title}.`, title, request: `Do: ${title}`, criteria } }]);
const edit = (cols: string[], testFile: string, testBody: string) =>
  scriptedModel('editor', [
    { tool: 'write_file', input: { path: 'src/table.mjs', content: `export const columns = ${JSON.stringify(cols)};\n` } },
    { tool: 'write_file', input: { path: testFile, content: testBody } },
    { tool: 'finish', input: { summary: `The table now shows ${cols.join(', ')}.` } },
  ]);
const ownerTest =
  "import assert from 'node:assert';\nimport { existsSync } from 'node:fs';\nconst m = await import(existsSync('src/deals/dealTable.mjs') ? '../src/deals/dealTable.mjs' : '../src/table.mjs');\nconst c = m.dealColumns ?? m.columns;\nassert.ok(c.includes('Owner'));\nassert.ok(c.includes('Priority'));\n";

async function setup() {
  const s = await setupStore();
  cleanups.push(s.t.cleanup);
  const data = tmp('feature-data');
  cleanups.push(data.cleanup);
  const queue: ReturnType<typeof scriptedModel>[] = [];
  const svc = await ForkuiServices.create({
    dataDir: data.dir,
    secret: SECRET,
    resolveModel: () => {
      const m = queue.shift();
      if (!m) throw new Error('no scripted model left');
      return m;
    },
  });
  await svc.importBase({ version: 'v1', ref: 'refs/heads/main', repoPath: s.vendor.dir });
  const app = createApp(svc);
  const headers = async (u = 'dana') => ({ authorization: `Bearer ${await signToken({ typ: 'editor', t: 'acme', u, c: true }, SECRET)}`, 'content-type': 'application/json' });
  const call = async (path: string, init: RequestInit = {}, u?: string) => app.request(`/v1/me${path}`, { ...init, headers: await headers(u) });
  const json = async <T,>(r: Response | Promise<Response>) => (await (await r).json()) as T;
  const detail = (id: string) => json<Detail>(call(`/features/${id}`));
  const settle = async (id: string) => {
    for (;;) {
      const d = await detail(id);
      if (!d.feature.busy && d.messages.at(-1)?.kind !== 'build') return d;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const build = async (id: string) => {
    const d = await detail(id);
    const p = [...d.messages].reverse().find((m) => m.kind === 'proposal' && m.status === 'proposed')!;
    return call(`/features/${id}/build`, { method: 'POST', body: JSON.stringify({ messageId: p.id }) });
  };
  const say = async (id: string, text: string, u?: string) => {
    expect((await call(`/features/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }, u)).status).toBe(202);
    return settle(id);
  };
  const create = async (text: string) => {
    const r = await json<{ featureId: string }>(call('/features', { method: 'POST', body: JSON.stringify({ text }) }));
    return { id: r.featureId, d: await settle(r.featureId) };
  };
  return { s, svc, queue, call, json, detail, settle, build, say, create };
}

describe('features', () => {
  test('create -> build -> preview -> publish -> revise a live feature -> discard the revision', async () => {
    const { svc, queue, call, json, settle, build, say, create } = await setup();

    queue.push(propose('Priority column', ['The deals table shows Priority right after Stage']));
    const { id, d: d0 } = await create('show priority in the table');
    expect(id).toBe('f1');
    expect(d0.feature).toMatchObject({ title: 'Priority column', status: 'draft' });
    expect(d0.messages.map((m) => m.kind)).toEqual(['text', 'proposal']);
    expect(d0.messages[0]!.author).toBe('dana');

    queue.push(edit(['Name', 'Stage', 'Priority', 'Amount'], 'forkui-tests/f1.spec.mjs', priorityTestStable));
    expect((await build(id)).status).toBe(202);
    let d = await settle(id);
    expect(d.feature.status).toBe('preview');
    expect(d.messages.at(-1)).toMatchObject({ kind: 'result', outcome: 'committed' });

    expect((await call(`/features/${id}/publish`, { method: 'POST' })).status).toBe(200);
    d = await settle(id);
    expect(d.feature.status).toBe('live');
    const liveBefore = (await svc.tenants.get('acme')).current;

    // Revise the live feature by chatting in it (another admin joins the conversation).
    queue.push(propose('Priority and Owner columns', ['Priority right after Stage', 'An Owner column']));
    d = await say(id, 'also add the owner please', 'lee');
    expect(d.messages.at(-2)).toMatchObject({ role: 'user', author: 'lee' });
    queue.push(edit(['Name', 'Stage', 'Priority', 'Amount', 'Owner'], 'forkui-tests/f1.spec.mjs', ownerTest));
    await build(id);
    d = await settle(id);
    expect(d.feature).toMatchObject({ status: 'preview', liveToo: true, title: 'Priority and Owner columns' });
    expect((await svc.store.listIntents('acme')).map((i) => i.trailers?.intentId)).toEqual(['f1', 'f1']); // a revision = a new commit, same feature
    expect((await svc.tenants.get('acme')).current).toBe(liveBefore); // the old version is still what everyone sees

    // Discard the revision: the published version stays.
    expect((await call(`/features/${id}/discard`, { method: 'POST' })).status).toBe(200);
    d = await settle(id);
    expect(d.feature.status).toBe('live');
    expect(d.messages.at(-1)!.text).toMatch(/published version stays/);
    expect(await svc.store.listIntents('acme')).toHaveLength(1);

    const list = await json<{ features: Feature[] }>(call('/features'));
    expect(list.features.map((f) => [f.id, f.status])).toEqual([['f1', 'live']]);
  });

  test('one unpublished feature at a time; drafts can be deleted, built features cannot', async () => {
    const { queue, call, build, create } = await setup();
    queue.push(propose('Priority column', ['Priority after Stage']));
    const a = await create('priority');
    queue.push(edit(['Name', 'Stage', 'Priority', 'Amount'], 'forkui-tests/f1.spec.mjs', priorityTestStable));
    await build(a.id);
    const { settle } = { settle: async () => {} };
    void settle;
    for (;;) {
      const r = (await (await call(`/features/${a.id}`)).json()) as Detail;
      if (r.feature.status === 'preview') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    queue.push(propose('Dark mode', ['The app is dark']));
    const b = await create('make it dark');
    expect(b.id).toBe('f2');
    const refused = await build(b.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Publish or discard “Priority column” first/);

    expect((await call(`/features/${b.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/features/${b.id}`)).status).toBe(404);
    expect((await call(`/features/${a.id}`, { method: 'DELETE' })).status).toBe(409);
  });

  test('rollout with a live feature and a pending revision: publishes the live version, rebuilds the preview', async () => {
    const { s, svc, queue, call, settle, build, say, create } = await setup();
    queue.push(propose('Priority column', ['Priority after Stage']));
    const { id } = await create('priority');
    queue.push(edit(['Name', 'Stage', 'Priority', 'Amount'], 'forkui-tests/f1.spec.mjs', priorityTestStable));
    await build(id);
    await settle(id);
    await call(`/features/${id}/publish`, { method: 'POST' });
    queue.push(propose('Priority and Owner columns', ['Priority after Stage', 'Owner column']));
    await say(id, 'add owner too');
    queue.push(edit(['Name', 'Stage', 'Priority', 'Amount', 'Owner'], 'forkui-tests/f1.spec.mjs', ownerTest));
    await build(id);
    const before = await settle(id);
    expect(before.feature.status).toBe('preview');
    const pendingBefore = (await svc.tenants.get('acme')).pending!;

    s.vendor.commit({ 'src/footer.mjs': 'export const footer = 1;\n' }, 'v2');
    await svc.importBase({ version: 'v2', ref: 'refs/heads/main', repoPath: s.vendor.dir });
    const done = await svc.jobs.wait(svc.rollout('v2').id);
    expect(done.status, done.error).toBe('done');

    const st = await svc.tenants.get('acme');
    const head = await svc.store.tenantHead('acme');
    const live = (await svc.artifacts.getRelease(st.current!))!;
    expect(live.sha).toBe(await svc.store.resolve(`${head}^`));
    expect(live.baseVersion).toBe('v2');
    expect(new TextDecoder().decode((await svc.artifacts.getBlob(live.files['/index.html']!))!)).not.toContain('Owner');
    expect(st.pending!.sha).toBe(head);
    expect(st.pending!.releaseId).not.toBe(pendingBefore.releaseId);
    const after = await settle(id);
    expect(after.feature).toMatchObject({ status: 'preview', liveToo: true });
  });

  test('planner replies and model errors show up in the feature chat', async () => {
    const { queue, say, create } = await setup();
    queue.push(scriptedModel('planner', [{ tool: 'reply', input: { text: 'Which table do you mean?' } }]));
    const { id, d } = await create('add a column');
    expect(d.messages.at(-1)).toMatchObject({ role: 'assistant', kind: 'text', text: 'Which table do you mean?' });
    expect(d.feature.status).toBe('draft');
    const d2 = await say(id, 'the deals one'); // no model left -> error notice
    expect(d2.messages.at(-1)!.text).toMatch(/couldn't reach the AI model/);
  });
});

describe('before the first release', () => {
  test('the editor says customization is not set up yet (without calling a model)', async () => {
    const data = tmp('noBase');
    cleanups.push(data.cleanup);
    const svc = await ForkuiServices.create({
      dataDir: data.dir,
      secret: SECRET,
      resolveModel: () => {
        throw new Error('model must not be called');
      },
    });
    const app = createApp(svc);
    const h = { authorization: `Bearer ${await signToken({ typ: 'editor', t: 'acme', u: 'dana', c: true }, SECRET)}`, 'content-type': 'application/json' };
    const list = (await (await app.request('/v1/me/features', { headers: h })).json()) as { ready: boolean };
    expect(list.ready).toBe(false);
    const { featureId } = (await (await app.request('/v1/me/features', { method: 'POST', headers: h, body: JSON.stringify({ text: 'hi' }) })).json()) as { featureId: string };
    for (;;) {
      const d = (await (await app.request(`/v1/me/features/${featureId}`, { headers: h })).json()) as Detail;
      if (!d.feature.busy && d.messages.length > 1) {
        expect(d.messages.at(-1)!.text).toMatch(/isn't set up yet/);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});

describe('rollouts', () => {
  test('run across tenants in parallel and report every tenant', async () => {
    const { s, svc } = await setup();
    for (const t of ['a1', 'b2', 'c3', 'd4']) await svc.store.createTenant(t, 'v1');
    s.vendor.commit({ 'src/footer.mjs': 'export const footer = 1;\n' }, 'v2');
    await svc.importBase({ version: 'v2', ref: 'refs/heads/main', repoPath: s.vendor.dir });
    const job = svc.rollout('v2');
    const done = await svc.jobs.wait(job.id);
    expect(done.status, done.error).toBe('done');
    const errs = (done.result as { outcome: string; reason?: string }[]).filter((r) => r.outcome === 'error');
    expect(errs.map((e) => e.reason)).toEqual([]);
    expect((done.result as { tenantId: string; outcome: string }[]).map((r) => [r.tenantId, r.outcome]).sort()).toEqual([
      ['a1', 'clean'],
      ['b2', 'clean'],
      ['c3', 'clean'],
      ['d4', 'clean'],
    ]);
    // They ran concurrently: more than one rebase job was running at once at some point.
    const rebases = svc.jobs.list().filter((j) => j.kind === 'rebase');
    const overlaps = rebases.some((a) => rebases.some((b) => a !== b && a.createdAt <= b.finishedAt! && b.createdAt <= a.finishedAt! && a.finishedAt !== undefined));
    expect(overlaps).toBe(true);
  });
});
