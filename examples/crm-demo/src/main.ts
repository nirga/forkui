/**
 * forkui demo: a SaaS product (Acme CRM) whose customers customize their own copy.
 *   pnpm demo           start (sets everything up on first run)
 *   pnpm demo --reset   start from scratch
 * Needs a model key in ../../.env (e.g. ANTHROPIC_API_KEY=...).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import express, { type Request } from 'express';
import { forkui } from '@forkui/node';
import { defaultModelResolver, parseModelSpec } from '@forkui/agent';
import { startServer } from '@forkui/server';
import { DEALS, USERS, v2, type DemoUser } from './data.ts';
import { BADGE_JS, PANEL_JS, panelHtml } from './panel.ts';
import { setupVendor, shipV2, vendorReady, vendorVersion, type DemoPaths } from './setup.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
/**
 * Re-read .env so a key added while the demo runs is picked up without a restart.
 * (process.loadEnvFile never overwrites a variable that is already set, even to "", so parse it ourselves.)
 * Variables set in the real shell environment always win.
 */
const fromShell = new Set(Object.entries(process.env).filter(([, v]) => v).map(([k]) => k));
const loadEnv = () => {
  let text: string;
  try {
    text = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    return; // no .env
  }
  for (const [k, v] of Object.entries(parseEnv(text))) if (!fromShell.has(k)) process.env[k] = v;
};
loadEnv();

const APP_PORT = Number(process.env.DEMO_PORT ?? 3000);
const FORKUI_PORT = Number(process.env.DEMO_FORKUI_PORT ?? 4400);
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const FORKUI_URL = `http://localhost:${FORKUI_PORT}`;
const model = {
  model: process.env.FORKUI_MODEL ?? 'anthropic:claude-sonnet-5-5',
  escalateTo: process.env.FORKUI_ESCALATE_MODEL === 'none' ? null : (process.env.FORKUI_ESCALATE_MODEL ?? 'anthropic:claude-opus-5-5'),
};
const KEY_ENV: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY' };
const keyVar = KEY_ENV[parseModelSpec(model.model).provider];
const modelOk = () => {
  loadEnv();
  return !keyVar || !!process.env[keyVar];
};

const work = join(here, '..', '.demo');
const p: DemoPaths = {
  root,
  work,
  vendor: join(work, 'vendor'),
  examples: join(root, 'examples'),
  overlay: join(here, '..', 'overlay'),
  tarball: join(work, 'forkui-react.tgz'),
};
const log: string[] = [];
const say = (s: string) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${s}`;
  log.push(line);
  if (log.length > 400) log.shift();
  console.log(line);
};

if (process.argv.includes('--reset')) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const secretFile = join(work, 'secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(24).toString('hex'));
const secret = readFileSync(secretFile, 'utf8').trim();

if (!vendorReady(p)) setupVendor(p, model, say);

// ---- forkui server (normally a separate deployment: docker run ghcr.io/forkui/server) ----
const fk = await startServer({
  dataDir: join(work, 'forkui'),
  secret,
  port: FORKUI_PORT,
  hostname: 'localhost',
  appOrigins: [APP_ORIGIN],
  productName: 'Acme CRM',
  resolveModel: (spec) => {
    loadEnv();
    if (keyVar && !process.env[keyVar]) throw new Error(`No ${keyVar}: add it to .env at the repo root`);
    return defaultModelResolver(spec);
  },
});
if (!(await fk.svc.store.latestBase())) {
  await fk.svc.importBase({ version: 'v1', ref: 'HEAD', repoPath: p.vendor });
  say('forkui: published base release v1');
}

// ---- the vendor's app server (what you already have) ----
type Req = Request & { user?: DemoUser };
const app = express();
const cookie = (req: Request, name: string) =>
  (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

// Your auth (demo: a cookie naming the user).
app.use((req: Req, _res, next) => {
  req.user = USERS.find((u) => u.id === cookie(req, 'demo_user'));
  next();
});

// ---- the one line forkui adds ----
app.use(
  forkui<Req>({
    server: FORKUI_URL,
    secret,
    tenant: (req) => req.user?.orgId,
    canCustomize: (req) => req.user?.isAdmin === true,
    user: (req) => req.user?.id,
    manifestTtlMs: 1000,
    onError: (e) => say(`middleware: forkui unreachable, serving the base app (${(e as Error).message})`),
  }),
);

// Your API (unchanged by forkui). v1 and v2 both stay live for customers pinned to v1.
app.get('/api/deals', (req: Req, res) => (req.user ? res.json(DEALS[req.user.orgId] ?? []) : res.status(401).end()));
app.get('/api/v2/opportunities', (req: Req, res) => (req.user ? res.json(v2(DEALS[req.user.orgId] ?? [])) : res.status(401).end()));

// Demo controls.
let shipping = false;
app.get('/demo', (req: Req, res) => res.type('html').send(panelHtml({ modelOk: modelOk(), model: model.model, ...(req.user ? { current: req.user.id } : {}) })));
app.get('/demo/panel.js', (_req, res) => res.type('js').send(PANEL_JS));
app.get('/demo/badge.js', (_req, res) => res.type('js').send(BADGE_JS));
app.get('/demo/me', (req: Req, res) => res.json(req.user ?? null));
app.get('/demo/login', (req, res) => {
  const u = USERS.find((x) => x.id === req.query.as);
  if (!u) return res.status(400).send('unknown user');
  res.setHeader('set-cookie', [`demo_user=${u.id}; Path=/; SameSite=Lax`, 'forkui_preview=; Path=/; Max-Age=0']);
  res.redirect('/');
});
app.get('/demo/state', async (_req, res) => {
  const tenants = [];
  for (const t of await fk.svc.store.listTenants()) {
    const s = await fk.svc.tenants.get(t.tenantId);
    const intents = await fk.svc.store.listIntents(t.tenantId);
    tenants.push({
      tenantId: t.tenantId,
      orgName: USERS.find((u) => u.orgId === t.tenantId)?.orgName ?? t.tenantId,
      base: (await fk.svc.store.tenantBase(t.tenantId)).version,
      current: s.current,
      pinned: s.pinned,
      customizations: intents.map((i) => i.subject),
    });
  }
  res.json({ vendorVersion: vendorVersion(p), shipping, tenants, log: log.slice(-200) });
});
app.post('/demo/ship', async (_req, res) => {
  if (shipping || vendorVersion(p) === 'v2') return res.status(409).json({ error: 'already shipped' });
  shipping = true;
  res.status(202).json({ ok: true });
  try {
    say('vendor: building and deploying Acme CRM v2…');
    shipV2(p, model);
    say('vendor: v2 is live for customers without customizations');
    await fk.svc.importBase({ version: 'v2', ref: 'HEAD', repoPath: p.vendor });
    say('forkui release v2: carrying customer customizations onto v2…');
    const job = fk.svc.rollout('v2');
    let seen = 0;
    for (;;) {
      const j = fk.svc.jobs.get(job.id)!;
      for (const l of j.log.slice(seen)) say(`  ${l.slice(9)}`);
      seen = j.log.length;
      if (j.status === 'done' || j.status === 'failed') {
        say(j.status === 'done' ? 'forkui release v2: done' : `forkui release v2 failed: ${j.error}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    say(`ship failed: ${(e as Error).message}`);
  } finally {
    shipping = false;
  }
});

// Your static frontend (the vendor's own deploy, served to customers without a fork).
app.use(express.static(join(p.vendor, 'dist'), { index: false }));
app.get('*', (req: Req, res) => {
  if (!req.user) return res.redirect('/demo');
  res.sendFile(join(p.vendor, 'dist', 'index.html'));
});

app.listen(APP_PORT, 'localhost', () => {
  say(`Demo ready: ${APP_ORIGIN}/demo   (forkui server: ${FORKUI_URL}, model ${model.model}${modelOk() ? '' : ` — missing ${keyVar}, set it in .env`})`);
});

// Log editor jobs as they happen.
setInterval(() => {
  for (const j of fk.svc.jobs.list()) {
    const k = `${j.id}:${j.log.length}:${j.status}`;
    if (seenJobs.get(j.id) === k) continue;
    const prev = seenJobs.get(j.id)?.split(':')[1];
    for (const l of j.log.slice(prev ? Number(prev) : 0)) if (j.kind === 'edit') say(`[${j.tenantId}] ${l.slice(9)}`);
    if (j.kind === 'edit' && (j.status === 'done' || j.status === 'failed') && !seenJobs.get(j.id)?.endsWith(j.status))
      say(`[${j.tenantId}] edit ${j.status}${j.error ? `: ${j.error}` : ''}${(j.result as { report?: { outcome: string; reason?: string } })?.report ? ` → ${(j.result as { report: { outcome: string; reason?: string } }).report.outcome}${(j.result as { report: { reason?: string } }).report.reason ? `: ${(j.result as { report: { reason?: string } }).report.reason}` : ''}` : ''}`);
    seenJobs.set(j.id, k);
  }
}, 500);
const seenJobs = new Map<string, string>();
