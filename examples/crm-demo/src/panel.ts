import { USERS } from './data.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function panelHtml(o: { modelOk: boolean; model: string; current?: string }) {
  const users = USERS.map(
    (u) => `<a class="user${u.id === o.current ? ' current' : ''}" href="/demo/login?as=${u.id}">
      <strong>${esc(u.name)}</strong><span>${esc(u.orgName)} · ${u.isAdmin ? 'admin (can customize)' : 'member'}</span></a>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>forkui demo</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#111827}
main{max-width:860px;margin:0 auto;padding:32px 20px}
h1{margin:0 0 4px} h2{margin:28px 0 10px;font-size:17px}
.muted{color:#6b7280}.users{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.user{display:block;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;text-decoration:none;color:inherit}
.user:hover{border-color:#6941c6}.user.current{border-color:#6941c6;box-shadow:0 0 0 2px #6941c633}
.user span{display:block;font-size:13px;color:#6b7280}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px}
.warn{background:#fef3f2;border-color:#fecdca;color:#b42318}
button{font:600 14px system-ui;padding:9px 14px;border-radius:8px;border:none;background:#111827;color:#fff;cursor:pointer}
button:disabled{opacity:.5}
pre{background:#0b1020;color:#d1d5db;border-radius:10px;padding:12px;font:12px ui-monospace,monospace;max-height:300px;overflow:auto;white-space:pre-wrap}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb}
td,th{padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:left;font-size:14px}
ol li{margin:4px 0}
</style></head><body><main>
<h1>forkui demo</h1>
<p class="muted">You're looking at <b>Acme CRM</b>, a SaaS product. Its customers (Acme Inc., Globex Logistics, Initech) can each reshape their copy of the app, and keep their changes through the vendor's updates.</p>
${o.modelOk ? '' : `<div class="card warn"><b>No model credentials.</b> Put your key in <code>.env</code> at the repo root (<code>ANTHROPIC_API_KEY=…</code>) and refresh this page (no restart needed). Model: <code>${esc(o.model)}</code></div>`}
<h2>1 · Sign in as a customer</h2>
<div class="users">${users}</div>
<h2>2 · Try it</h2>
<div class="card"><ol>
<li>Sign in as <b>Dana</b> (Acme admin). Click <b>Customize</b> (bottom right).</li>
<li>Ask for something, e.g. <i>“Show each deal's priority as a column right after Stage, high priority in red”</i> or <i>“Add a Win rate card to the dashboard”</i>.</li>
<li>When it's ready, <b>Preview</b> it (only you see it), then <b>Publish</b>.</li>
<li>Sign in as <b>Sam</b> (also Acme): Sam sees the change. Sign in as <b>Lee</b> (Globex): Lee sees the standard app.</li>
<li>Now be the vendor: <b>Ship v2</b> below. v2 rewrites the table, renames fields and moves the API. Watch Acme's customization get carried over.</li>
</ol></div>
<h2>3 · Vendor: ship a new version</h2>
<div class="card"><p>Running: <b id="version">…</b>. <span class="muted">This does what the vendor's CI does: build &amp; deploy, then <code>forkui release</code>.</span></p>
<button id="ship">Ship v2</button></div>
<h2>Customers</h2>
<table id="tenants"><tr><td class="muted">No customizations yet.</td></tr></table>
<h2>forkui log</h2>
<pre id="log">(nothing yet)</pre>
</main><script src="/demo/panel.js"></script></body></html>`;
}

export const PANEL_JS = `(() => {
  const $ = (id) => document.getElementById(id);
  async function refresh() {
    const s = await fetch('/demo/state').then((r) => r.json());
    $('version').textContent = 'Acme CRM ' + s.vendorVersion + (s.shipping ? ' (shipping v2…)' : '');
    $('ship').disabled = s.vendorVersion === 'v2' || s.shipping;
    const rows = s.tenants.map((t) => {
      const tr = document.createElement('tr');
      const cells = [t.orgName, 'on ' + t.base, t.pinned ? 'paused: ' + t.pinned.reason : t.current ? 'customized (live)' : 'standard app', t.customizations.join('; ') || '—'];
      for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); }
      return tr;
    });
    if (rows.length) { const h = document.createElement('tr'); for (const c of ['Customer', 'Base', 'Status', 'Customizations']) { const th = document.createElement('th'); th.textContent = c; h.append(th); } $('tenants').replaceChildren(h, ...rows); }
    if (s.log.length) { $('log').textContent = s.log.join('\\n'); }
  }
  $('ship').onclick = async () => { $('ship').disabled = true; await fetch('/demo/ship', { method: 'POST' }); refresh(); };
  refresh(); setInterval(refresh, 2000);
})();`;

export const BADGE_JS = `(() => {
  fetch('/demo/me').then((r) => r.json()).then((u) => {
    const a = document.createElement('a');
    a.href = '/demo';
    a.textContent = u ? u.name + ' · ' + u.orgName + (u.isAdmin ? ' (admin)' : '') + ' — switch user' : 'Not signed in — open demo panel';
    a.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147482000;background:#fff;border:1px solid #e5e7eb;border-radius:999px;padding:8px 14px;font:500 13px system-ui;color:#111827;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.12)';
    document.body.append(a);
  });
})();`;
