import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { verifyToken, type TokenClaims } from '@forkui/node';
import { ConflictError, ForkuiServices, StaleReleaseError } from './services.ts';
import { EDITOR_CSS, EDITOR_HTML, EDITOR_JS } from './editor.ts';

type Env = { Variables: { claims: TokenClaims } };

const editBody = z.object({
  intentId: z.string().optional(),
  title: z.string().min(1).max(200),
  request: z.string().min(1).max(4000),
  spec: z.string().min(1).max(8000).optional(),
});

/** The forkui HTTP API. Server-to-server routes use `x-forkui-key`; editor routes use a signed editor token. */
export function createApp(svc: ForkuiServices) {
  const secret = svc.opts.secret;
  const app = new Hono<Env>();
  const bad = (c: Context, status: 400 | 401 | 403 | 404 | 409, error: string) => c.json({ error }, status);

  app.get('/health', (c) => c.json({ ok: true }));

  // ---- editor UI (loaded in <Customize />'s iframe) ----
  const frameAncestors = svc.opts.appOrigins?.length ? svc.opts.appOrigins.join(' ') : '*';
  const editorHeaders = {
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors ${frameAncestors}`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
  app.get('/editor', (c) => c.html(EDITOR_HTML, 200, editorHeaders));
  app.get('/editor.js', (c) => c.body(EDITOR_JS, 200, { ...editorHeaders, 'content-type': 'text/javascript; charset=utf-8' }));
  app.get('/editor.css', (c) => c.body(EDITOR_CSS, 200, { ...editorHeaders, 'content-type': 'text/css; charset=utf-8' }));

  // ---- server-to-server (middleware, CLI) ----
  const key = new Hono<Env>();
  key.use('*', async (c, next) => {
    if (c.req.header('x-forkui-key') !== secret) return bad(c, 401, 'bad key');
    await next();
  });

  key.get('/tenants/:t/release', async (c) => {
    const s = await svc.tenants.get(c.req.param('t'));
    const m = s.current ? await svc.artifacts.getRelease(s.current) : null;
    return m ? c.json(m) : bad(c, 404, 'no release');
  });
  key.get('/releases/:id', async (c) => {
    const m = await svc.artifacts.getRelease(c.req.param('id'));
    return m ? c.json(m) : bad(c, 404, 'no release');
  });
  key.get('/blobs/:hash', async (c) => {
    const b = await svc.artifacts.getBlob(c.req.param('hash'));
    if (!b) return bad(c, 404, 'no blob');
    return c.body(b as unknown as ArrayBuffer, 200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
  });
  key.post('/bases', async (c) => {
    const version = c.req.query('version');
    const ref = c.req.query('ref') ?? 'HEAD';
    if (!version) return bad(c, 400, 'version required');
    const sha = c.req.query('sha');
    const bundle = new Uint8Array(await c.req.arrayBuffer());
    if (!bundle.length && !sha) return bad(c, 400, 'a git bundle body or a known ?sha= is required');
    try {
      const base = await svc.importBase(bundle.length ? { version, ref, bundle } : { version, ref, sha: sha! });
      return c.json(base, base.existing ? 200 : 201);
    } catch (e) {
      return bad(c, 409, (e as Error).message);
    }
  });
  key.get('/bases', async (c) => c.json(await svc.store.listBases()));
  key.post('/rollouts', async (c) => {
    const { version } = z.object({ version: z.string() }).parse(await c.req.json());
    return c.json(svc.rollout(version), 202);
  });
  key.get('/tenants', async (c) => {
    const out = [];
    for (const t of await svc.store.listTenants()) {
      const s = await svc.tenants.get(t.tenantId);
      out.push({ tenantId: t.tenantId, base: (await svc.store.tenantBase(t.tenantId)).version, current: s.current, pinned: s.pinned });
    }
    return c.json(out);
  });
  key.get('/jobs/:id', (c) => {
    const j = svc.jobs.get(c.req.param('id'));
    return j ? c.json(j) : bad(c, 404, 'no job');
  });

  // ---- editor (tenant admins, via signed editor token) ----
  const me = new Hono<Env>();
  me.use('*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    const claims = await verifyToken(token, secret, 'editor');
    if (!claims?.c) return bad(c, 401, 'invalid editor token');
    c.set('claims', claims);
    await next();
  });
  me.get('/', async (c) => {
    const { t } = c.get('claims');
    const exists = !!(await svc.store.resolve(`refs/heads/tenants/${t}`));
    const state = await svc.tenants.get(t);
    const intents = exists ? await svc.store.listIntents(t) : [];
    return c.json({
      tenantId: t,
      base: exists ? (await svc.store.tenantBase(t)).version : ((await svc.store.latestBase())?.version ?? null),
      current: state.current,
      pinned: state.pinned,
      history: state.history.slice(-20).reverse(),
      customizations: intents.map((i) => ({ id: i.trailers?.intentId, title: i.subject, intent: i.trailers?.intent, author: i.author })),
      jobs: svc.jobs.list(t).slice(0, 10).map((j) => ({ id: j.id, kind: j.kind, status: j.status, createdAt: j.createdAt })),
    });
  });
  me.post('/edits', async (c) => {
    const parsed = editBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return bad(c, 400, parsed.error.issues.map((i) => i.message).join('; '));
    const { t, u } = c.get('claims');
    const b = parsed.data;
    const job = svc.requestEdit(t, {
      title: b.title,
      request: b.request,
      ...(b.spec ? { spec: b.spec } : {}),
      ...(b.intentId ? { intentId: b.intentId } : {}),
      ...(u ? { author: { name: u, email: `${u}@${t}.forkui` } } : {}),
    });
    return c.json({ jobId: job.id }, 202);
  });
  me.get('/jobs/:id', (c) => {
    const j = svc.jobs.get(c.req.param('id'));
    if (!j || j.tenantId !== c.get('claims').t) return bad(c, 404, 'no job');
    return c.json(j);
  });
  me.post('/releases/:id/publish', async (c) => {
    const { t, u } = c.get('claims');
    try {
      return c.json(await svc.publish(t, c.req.param('id'), u ?? 'editor'));
    } catch (e) {
      return bad(c, e instanceof StaleReleaseError ? 409 : 404, (e as Error).message);
    }
  });
  me.post('/edits/:jobId/discard', async (c) => {
    try {
      await svc.discard(c.get('claims').t, c.req.param('jobId'));
      return c.json({ ok: true });
    } catch (e) {
      return bad(c, e instanceof StaleReleaseError ? 409 : 404, (e as Error).message);
    }
  });
  me.post('/unpublish', async (c) => {
    const { t, u } = c.get('claims');
    return c.json(await svc.publish(t, null, u ?? 'editor'));
  });
  // ---- features: one conversation per customization ----
  const who = (c: Context<Env>) => {
    const { t, u } = c.get('claims');
    return { t, u: u ?? 'admin' };
  };
  const fail = (c: Context, e: unknown) =>
    bad(c, e instanceof ConflictError || e instanceof StaleReleaseError ? 409 : 404, (e as Error).message);
  const textBody = z.object({ text: z.string().trim().min(1).max(4000) });

  me.get('/features', async (c) => c.json(await svc.listFeatures(who(c).t)));
  me.post('/features', async (c) => {
    const body = textBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return bad(c, 400, 'text required');
    const { t, u } = who(c);
    return c.json(await svc.createFeature(t, u, body.data.text), 202);
  });
  me.get('/features/:id', async (c) => {
    const f = await svc.getFeature(who(c).t, c.req.param('id'));
    return f ? c.json(f) : bad(c, 404, 'no such feature');
  });
  me.delete('/features/:id', async (c) => {
    try {
      await svc.deleteFeature(who(c).t, c.req.param('id'));
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });
  me.post('/features/:id/messages', async (c) => {
    const body = textBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return bad(c, 400, 'text required');
    const { t, u } = who(c);
    if (!(await svc.getFeature(t, c.req.param('id')))) return bad(c, 404, 'no such feature');
    const job = await svc.featureMessage(t, u, c.req.param('id'), body.data.text);
    return c.json({ jobId: job.id }, 202);
  });
  me.post('/features/:id/build', async (c) => {
    const body = z.object({ messageId: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return bad(c, 400, 'messageId required');
    const { t, u } = who(c);
    try {
      return c.json({ jobId: (await svc.featureBuild(t, u, c.req.param('id'), body.data.messageId)).id }, 202);
    } catch (e) {
      return fail(c, e);
    }
  });
  for (const action of ['publish', 'discard'] as const)
    me.post(`/features/:id/${action}`, async (c) => {
      const { t, u } = who(c);
      try {
        if (action === 'publish') await svc.featurePublish(t, u, c.req.param('id'));
        else await svc.featureDiscard(t, u, c.req.param('id'));
        return c.json({ ok: true });
      } catch (e) {
        return fail(c, e);
      }
    });
  me.get('/preview-grant', async (c) => {
    const grant = await svc.previewGrant(c.get('claims').t);
    return grant ? c.json({ grant }) : bad(c, 404, 'nothing to preview');
  });

  // Editor routes first: Hono runs middleware in registration order, and the key check below covers /v1/*.
  app.route('/v1/me', me);
  app.route('/v1', key);

  return app;
}
