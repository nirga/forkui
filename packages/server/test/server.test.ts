import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHandler, signToken } from '@forkui/node';
import { createApp, ForkuiServices, type EditResult, type Job, type RolloutTenantResult } from '../src/index.ts';
import { scriptedModel, setupStore, v2, priorityTestStable } from '../../engine/test/fixture.ts';
import { tmp } from '../../../test/helpers.ts';

const SECRET = 'server-test-secret-server-test-secret!!';
let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

async function setup(models: Record<string, ReturnType<typeof scriptedModel>>) {
  const s = await setupStore(); // vendor repo with v1 (we only use its vendor dir here)
  cleanups.push(s.t.cleanup);
  const data = tmp('server-data');
  cleanups.push(data.cleanup);
  const svc = await ForkuiServices.create({
    dataDir: data.dir,
    secret: SECRET,
    resolveModel: (spec) => {
      const m = models[spec];
      if (!m) throw new Error(`no mock for ${spec}`);
      return m;
    },
  });
  await svc.importBase({ version: 'v1', ref: 'refs/heads/main', repoPath: s.vendor.dir });
  const app = createApp(svc);
  const key = { 'x-forkui-key': SECRET };
  const editor = async (tenant: string) => ({
    authorization: `Bearer ${await signToken({ typ: 'editor', t: tenant, u: 'dana', c: true }, SECRET)}`,
    'content-type': 'application/json',
  });
  const waitJob = async <R,>(id: string, headers: Record<string, string>, path = `/v1/jobs/${id}`): Promise<Job<R>> => {
    for (;;) {
      const res = await app.request(path, { headers });
      if (!res.ok) throw new Error(`job poll ${res.status}: ${await res.text()}`);
      const j = (await res.json()) as Job<R>;
      if (j.status === 'done' || j.status === 'failed') return j;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { s, svc, app, key, editor, waitJob };
}

const editScript = () =>
  scriptedModel('primary', [
    { tool: 'write_file', input: { path: 'src/table.mjs', content: "export const columns = ['Name', 'Stage', 'Priority', 'Amount'];\n" } },
    { tool: 'write_file', input: { path: 'forkui-tests/c1.spec.mjs', content: priorityTestStable } },
    { tool: 'run_checks', input: {} },
    { tool: 'finish', input: { summary: 'Added Priority after Stage.' } },
  ]);

describe('forkui server', () => {
  test('auth: key routes need the key, editor routes need an editor token', async () => {
    const { app, editor } = await setup({});
    expect((await app.request('/v1/tenants/acme/release')).status).toBe(401);
    expect((await app.request('/v1/tenants/acme/release', { headers: { 'x-forkui-key': 'nope' } })).status).toBe(401);
    expect((await app.request('/v1/me')).status).toBe(401);
    const preview = await signToken({ typ: 'preview', t: 'acme', r: 'x' }, SECRET);
    expect((await app.request('/v1/me', { headers: { authorization: `Bearer ${preview}` } })).status).toBe(401);
    const me = (await (await app.request('/v1/me', { headers: await editor('acme') })).json()) as { base: string; current: null };
    expect(me).toMatchObject({ tenantId: 'acme', base: 'v1', current: null, customizations: [] });
  });

  test('an unpublished edit never goes live on its own; discard reverts the branch', async () => {
    const { s, svc, app, key, editor, waitJob } = await setup({});
    const edit = editScript();
    (svc.engine as { resolveModel: unknown }).resolveModel = () => edit;
    const h = await editor('acme');
    const { jobId } = (await (
      await app.request('/v1/me/edits', { method: 'POST', headers: h, body: JSON.stringify({ title: 'Add Priority', request: 'Show priority after stage' }) })
    ).json()) as { jobId: string };
    const job = await waitJob<EditResult>(jobId, h, `/v1/me/jobs/${jobId}`);
    expect(job.result!.report.outcome).toBe('committed');

    // Vendor ships an unrelated change; the previewed-but-unpublished edit must stay unpublished.
    s.vendor.commit({ 'src/footer.mjs': 'export const footer = 1;\n' }, 'v2');
    await svc.importBase({ version: 'v2', ref: 'refs/heads/main', repoPath: s.vendor.dir });
    const ro = svc.rollout('v2');
    const done = await svc.jobs.wait(ro.id);
    expect(done.result).toEqual([{ tenantId: 'acme', outcome: 'clean', releaseId: null }]);
    expect((await app.request('/v1/tenants/acme/release', { headers: key })).status).toBe(404);

    // The old preview no longer matches the branch (it was rebased): publishing it is refused.
    const pub = await app.request(`/v1/me/releases/${job.result!.releaseId}/publish`, { method: 'POST', headers: h });
    expect(pub.status).toBe(409);

    // Discard is refused too now (the branch moved on), but works right after an edit.
    expect((await app.request(`/v1/me/edits/${jobId}/discard`, { method: 'POST', headers: h })).status).toBe(404);
  });

  test('discard right after an edit moves the branch back', async () => {
    const { svc, app, editor, waitJob } = await setup({});
    const edit = editScript();
    (svc.engine as { resolveModel: unknown }).resolveModel = () => edit;
    const h = await editor('acme');
    const { jobId } = (await (
      await app.request('/v1/me/edits', { method: 'POST', headers: h, body: JSON.stringify({ title: 'Add Priority', request: 'x' }) })
    ).json()) as { jobId: string };
    const job = await waitJob<EditResult>(jobId, h, `/v1/me/jobs/${jobId}`);
    expect((await app.request(`/v1/me/edits/${jobId}/discard`, { method: 'POST', headers: await editor('other') })).status).toBe(404);
    expect((await app.request(`/v1/me/edits/${jobId}/discard`, { method: 'POST', headers: h })).status).toBe(200);
    expect(await svc.store.tenantHead('acme')).toBe(job.result!.report.previousHead);
    expect((await svc.store.listIntents('acme'))).toHaveLength(0);
  });

  test('editor UI is served with a strict CSP and its script parses', async () => {
    const { app } = await setup({});
    const html = await app.request('/editor');
    expect(html.headers.get('content-security-policy')).toMatch(/default-src 'none'; script-src 'self'/);
    expect(await html.text()).toContain('<script src="/editor.js"');
    const js = await (await app.request('/editor.js')).text();
    expect(() => new Function(js)).not.toThrow();
    expect(js).not.toMatch(/innerHTML/);
  });

  test('edit -> preview -> publish -> served by @forkui/node; v2 bundle upload -> rollout carries it over', async () => {
    const rebase = scriptedModel('primary-rebase', [
      { tool: 'delete_file', input: { path: 'src/table.mjs' } },
      { tool: 'write_file', input: { path: 'src/deals/dealTable.mjs', content: "export const dealColumns = ['Name', 'Status', 'Priority', 'Amount'];\n" } },
      { tool: 'rebase_continue', input: {} },
      { tool: 'run_checks', input: {} },
      { tool: 'finish', input: { summary: 'Priority now follows Status.' } },
    ]);
    let phase: 'edit' | 'rebase' = 'edit';
    const edit = editScript();
    const { s, svc, app, key, editor, waitJob } = await setup({});
    // Route model by phase (same spec string for both jobs).
    (svc.engine as { resolveModel: unknown }).resolveModel = () => (phase === 'edit' ? edit : rebase);

    // 1. Tenant admin requests a change through the editor API.
    const h = await editor('acme');
    const { jobId } = (await (
      await app.request('/v1/me/edits', { method: 'POST', headers: h, body: JSON.stringify({ title: 'Add Priority', request: 'Show priority after stage' }) })
    ).json()) as { jobId: string };
    const job = await waitJob<EditResult>(jobId, h, `/v1/me/jobs/${jobId}`);
    expect(job.status, job.error).toBe('done');
    expect(job.result!.report.outcome).toBe('committed');
    const releaseId = job.result!.releaseId!;
    expect(job.result!.previewGrant).toBeTruthy();

    // Another tenant cannot see the job.
    expect((await app.request(`/v1/me/jobs/${jobId}`, { headers: await editor('other') })).status).toBe(404);

    // 2. Not live until published.
    expect((await app.request('/v1/tenants/acme/release', { headers: key })).status).toBe(404);
    expect((await app.request(`/v1/me/releases/${releaseId}/publish`, { method: 'POST', headers: await editor('other') })).status).toBe(404);
    expect((await app.request(`/v1/me/releases/${releaseId}/publish`, { method: 'POST', headers: h })).status).toBe(200);

    // 3. The vendor's middleware serves it, talking to this server.
    const viaApp = ((u: string, init?: RequestInit) => app.request(new URL(u).pathname, init)) as unknown as typeof fetch;
    const mw = createHandler<{ t: string }>({ secret: SECRET, server: 'http://forkui', fetch: viaApp, tenant: (c) => c.t, manifestTtlMs: 0 });
    const page = await mw(new Request('http://app/', { headers: { accept: 'text/html' } }), { t: 'acme' });
    expect(await page!.text()).toBe('<table><th>Name</th><th>Stage</th><th>Priority</th><th>Amount</th></table>');
    const asset = await mw(new Request('http://app/assets/app-0123abcd.js'), { t: 'acme' });
    expect(asset!.headers.get('cache-control')).toMatch(/immutable/);
    expect(await mw(new Request('http://app/', { headers: { accept: 'text/html' } }), { t: 'nobody' })).toBeNull();

    // 4. Vendor ships v2 the way `forkui release` does: upload a git bundle, then start a rollout.
    s.vendor.commit(v2, 'v2', ['src/table.mjs']);
    const bundle = execFileSync('git', ['bundle', 'create', '-', 'main'], { cwd: s.vendor.dir });
    const imp = await app.request('/v1/bases?version=v2&ref=refs/heads/main', { method: 'POST', headers: key, body: bundle });
    expect(imp.status).toBe(201);
    phase = 'rebase';
    const ro = (await (await app.request('/v1/rollouts', { method: 'POST', headers: { ...key, 'content-type': 'application/json' }, body: JSON.stringify({ version: 'v2' }) })).json()) as Job;
    const done = await waitJob<RolloutTenantResult[]>(ro.id, key);
    expect(done.status, done.error).toBe('done');
    expect(done.result).toEqual([{ tenantId: 'acme', outcome: 'resolved', releaseId: expect.stringMatching(/^rel_/) }]);
    const page2 = await mw(new Request('http://app/', { headers: { accept: 'text/html' } }), { t: 'acme' });
    expect(await page2!.text()).toBe('<table><th>Name</th><th>Status</th><th>Priority</th><th>Amount</th></table>');
    const tenants = (await (await app.request('/v1/tenants', { headers: key })).json()) as object[];
    expect(tenants).toEqual([{ tenantId: 'acme', base: 'v2', current: done.result![0]!.releaseId, pinned: null }]);
    void readFileSync;
  });
});

describe('editor progress wording', () => {
  test('humanizes job log lines without file names', async () => {
    const { EDITOR_JS } = await import('../src/editor.ts');
    // Pull humanize() out of the served script and exercise it.
    const src = EDITOR_JS.slice(EDITOR_JS.indexOf('  const screen = '), EDITOR_JS.indexOf('  const LABEL = '));
    const humanize = new Function(`${src}; return humanize;`)() as (l: string) => string | null;
    expect(humanize('16:19:47   · read_file src/DealsTable.tsx')).toBe('Looking at the deals table');
    expect(humanize('16:19:47   · read_file src/test/fixtures.ts')).toBe('Studying how the app works');
    expect(humanize('16:19:47   · read_file forkui.config.json')).toBe('Studying how the app works');
    expect(humanize('16:19:47   · edit_file src/components/deals/DealTable.tsx')).toBe('Updating the deal table');
    expect(humanize('16:19:47   · write_file forkui-tests/c1.spec.tsx')).toBe('Writing a check that keeps this working after updates');
    expect(humanize('16:19:47   · edit_file src/styles.css')).toBe('Updating the styling');
    expect(humanize('16:19:47 created tenant on base v1')).toBeNull();
  });
});
