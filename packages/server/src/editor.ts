/** The editor UI served inside <Customize />'s iframe: a chat with the customization assistant. Dependency-free; all data rendered with textContent. */

export const EDITOR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Customize</title>
<link rel="stylesheet" href="/editor.css">
</head>
<body>
<header>
  <div><h1>Customize</h1><div id="subtitle" class="muted"></div></div>
  <div class="head-actions"><button id="close" class="ghost" aria-label="Close">✕</button></div>
</header>
<div id="bar"></div>
<main id="messages" aria-live="polite"><p class="empty">Loading…</p></main>
<form id="composer">
  <textarea id="input" rows="2" placeholder="Describe a change… (Enter to send, Shift+Enter for a new line)"></textarea>
  <button id="send" type="submit">Send</button>
</form>
<script src="/editor.js" defer></script>
</body>
</html>`;

export const EDITOR_CSS = `
:root { --fg:#111827; --muted:#6b7280; --line:#e5e7eb; --soft:#f3f4f6; --accent:#6941c6; --accent-soft:#f4f0ff; --bad:#b42318; --bad-soft:#fef3f2; --ok:#067647; --ok-soft:#ecfdf3; }
* { box-sizing: border-box; }
html, body { height:100%; }
body { margin:0; font:14px/1.45 system-ui, sans-serif; color:var(--fg); background:#fff; display:flex; flex-direction:column; }
header { display:flex; justify-content:space-between; align-items:center; padding:12px 14px; border-bottom:1px solid var(--line); }
h1 { font-size:15px; margin:0; }
.muted { color:var(--muted); font-size:12px; }
.head-actions { display:flex; gap:4px; }
#pending:empty { display:none; }
#pending { padding:10px 14px; background:var(--accent-soft); border-bottom:1px solid #e4dcff; }
#pending .label { font-size:12px; color:var(--accent); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
#pending .title { font-weight:600; margin:2px 0 8px; }
#messages { flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:10px; }
.msg { max-width:88%; padding:9px 12px; border-radius:14px; white-space:pre-wrap; word-wrap:break-word; }
.user { align-self:flex-end; background:var(--fg); color:#fff; border-bottom-right-radius:4px; }
.assistant { align-self:flex-start; background:var(--soft); border-bottom-left-radius:4px; }
.notice { align-self:center; color:var(--muted); font-size:12px; text-align:center; max-width:100%; }
.card { align-self:stretch; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#fff; }
.card h3 { margin:6px 0 4px; font-size:14px; }
.card ul { margin:4px 0 0; padding-left:18px; }
.card .k { font-size:12px; color:var(--muted); margin-top:6px; }
.card.superseded { opacity:.55; }
.bad { background:var(--bad-soft); color:var(--bad); }
.good { background:var(--ok-soft); color:var(--ok); }
.steps { list-style:none; margin:6px 0 0; padding:0; font-size:13px; color:var(--muted); }
.steps li::before { content:'✓ '; color:var(--ok); }
.steps li.now::before { content:''; display:inline-block; width:10px; height:10px; margin-right:6px; border:2px solid var(--accent); border-right-color:transparent; border-radius:50%; animation:spin .8s linear infinite; vertical-align:-1px; }
@keyframes spin { to { transform:rotate(360deg); } }
.typing { align-self:flex-start; color:var(--muted); font-size:13px; }
.row { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
button { font:600 13px system-ui; padding:7px 12px; border-radius:8px; border:none; background:var(--fg); color:#fff; cursor:pointer; }
button.secondary { background:#fff; color:var(--fg); border:1px solid var(--line); }
button.accent { background:var(--accent); }
button.ghost { background:none; color:var(--muted); padding:4px 8px; font-weight:500; }
button:disabled { opacity:.5; cursor:default; }
.chips { display:flex; flex-direction:column; gap:6px; margin-top:6px; }
.chip { text-align:left; background:#fff; color:var(--fg); border:1px solid var(--line); font-weight:500; }
#composer { display:flex; gap:8px; padding:10px 12px; border-top:1px solid var(--line); background:#fff; }
#input { flex:1; resize:none; font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:10px; max-height:140px; }

.list { display:flex; flex-direction:column; gap:8px; }
.feature { text-align:left; background:#fff; color:var(--fg); border:1px solid var(--line); border-radius:12px; padding:10px 12px; font-weight:400; display:block; width:100%; }
.feature:hover { border-color:var(--accent); }
.feature .top { display:flex; justify-content:space-between; gap:8px; align-items:center; }
.feature .name { font-weight:600; }
.feature .last { color:var(--muted); font-size:12px; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pill { font:600 11px system-ui; padding:2px 8px; border-radius:999px; white-space:nowrap; background:var(--soft); color:var(--muted); }
.pill.live { background:var(--ok-soft); color:var(--ok); }
.pill.preview, .pill.building { background:var(--accent-soft); color:var(--accent); }
.pill.paused { background:var(--bad-soft); color:var(--bad); }
.bar { padding:10px 14px; border-bottom:1px solid var(--line); }
.bar .title { font-weight:600; display:flex; gap:8px; align-items:center; margin:4px 0 2px; }
.bar.previewing { background:var(--accent-soft); }
.empty { color:var(--muted); text-align:center; padding:24px 8px; }
#composer.hidden { display:none; }
`;

export const EDITOR_JS = `(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  const parentOrigin = params.get('origin');
  const previewing = params.get('preview') === '1';
  history.replaceState(null, '', location.pathname); // keep the token out of the URL
  const $ = (id) => document.getElementById(id);
  const post = (msg) => parentOrigin && parent.postMessage(msg, parentOrigin);
  $('close').onclick = () => post({ type: 'forkui:close' });
  const remember = (id) => { try { id ? sessionStorage.setItem('forkui:feature', id) : sessionStorage.removeItem('forkui:feature'); } catch {} };
  const remembered = () => { try { return sessionStorage.getItem('forkui:feature'); } catch { return null; } };

  async function api(path, init) {
    const r = await fetch('/v1/me' + path, Object.assign({}, init, { headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }));
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
    return body;
  }
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'onclick') e.onclick = v; else if (k === 'class') e.className = v; else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }

  // Plain-language progress from the job log (the admin isn't technical: no file names).
  const screen = (p) => {
    const base = (p || '').split('/').pop() || '';
    if (!/^src\\//.test(p || '') || !/^[A-Z]/.test(base) || /\\.(test|spec)\\./.test(base)) return null;
    return base.replace(/\\.[a-z]+$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  };
  function humanize(line) {
    const t = line.replace(/^\\d\\d:\\d\\d:\\d\\d /, '');
    let m;
    if (/^agent /.test(t)) return 'Figuring out what to change';
    if ((m = t.match(/^ +· read_file ?(.*)$/))) { const s = screen(m[1]); return s ? 'Looking at the ' + s : 'Studying how the app works'; }
    if (/^ +· (search|list_files|git)/.test(t)) return 'Studying how the app works';
    if ((m = t.match(/^ +· (write_file|edit_file|delete_file) (.*)$/))) {
      if (/forkui-tests\\//.test(m[2])) return 'Writing a check that keeps this working after updates';
      if (/\\.css$/.test(m[2])) return 'Updating the styling';
      const s = screen(m[2]);
      return s ? 'Updating the ' + s : 'Making the change';
    }
    if (/^ +· run_checks/.test(t)) return 'Testing the change';
    if (/^ +✗ /.test(t)) return 'Skipped something it isn\\'t allowed to touch';
    if (/^ +· finish/.test(t)) return 'Wrapping up';
    if (/^verify /.test(t)) return 'Double-checking everything still works';
    if (/^accepted/.test(t)) return 'All checks passed';
    if (/^build /.test(t)) return 'Building your preview';
    if (/^preview release/.test(t)) return 'Preview ready';
    return null;
  }

  const LABEL = { draft: 'Draft', building: 'Building…', preview: 'Preview', live: 'Live', off: 'Not live', paused: 'Paused' };
  const pill = (status) => el('span', { class: 'pill ' + status }, LABEL[status] || status);

  let view = { name: 'list' }; // or { name: 'feature', id } or { name: 'new' }
  let list = null, detail = null, sending = false;
  const jobs = {};

  function open(v) { view = v; remember(v.name === 'feature' ? v.id : null); detail = null; refresh(); if (v.name !== 'list') $('input').focus(); }
  function oops(text) { const n = el('div', { class: 'msg notice bad' }, text); $('messages').append(n); n.scrollIntoView(); }
  async function act(fn) { try { await fn(); } catch (e) { oops(e.message); } await refresh(); }
  async function preview() { const { grant } = await api('/preview-grant'); post({ type: 'forkui:preview', grant }); }

  // ---------- list view ----------
  function renderList() {
    $('composer').classList.add('hidden');
    $('bar').replaceChildren(el('div', { class: 'row', style: 'margin:0' }, el('button', { class: 'accent', ...(list.ready ? {} : { disabled: '' }), onclick: () => open({ name: 'new' }) }, '+ New feature')));
    $('bar').className = 'bar';
    const nodes = [];
    if (!list.ready) nodes.push(el('div', { class: 'msg notice' }, 'Customization isn\\'t set up yet. The app\\'s team needs to publish a first version to forkui.'));
    if (list.pinned) nodes.push(el('div', { class: 'msg notice bad' }, 'Your features are paused on the previous version of the app: ' + list.pinned.reason));
    if (!list.features.length) nodes.push(el('div', { class: 'empty' }, 'No features yet. Start one to change how the app works for your team.'));
    else nodes.push(el('div', { class: 'list' }, ...list.features.map((f) =>
      el('button', { class: 'feature', onclick: () => open({ name: 'feature', id: f.id }) },
        el('div', { class: 'top' }, el('span', { class: 'name' }, f.title), pill(f.status)),
        f.lastMessage ? el('div', { class: 'last' }, (f.lastMessage.role === 'user' ? 'You: ' : '') + f.lastMessage.text) : null))));
    $('messages').replaceChildren(...nodes);
  }

  // ---------- feature view ----------
  function actions(f) {
    const p = detail.pending;
    const mine = p && p.intentId === f.id;
    const back = el('button', { class: 'ghost', onclick: () => open({ name: 'list' }) }, '← All features');
    const title = el('div', { class: 'title' }, f.title, pill(f.status));
    const row = el('div', { class: 'row', style: 'margin-top:6px' });
    const notes = [];
    if (mine && previewing) {
      row.append(
        el('button', { class: 'accent', onclick: () => act(async () => { await api('/features/' + f.id + '/publish', { method: 'POST' }); post({ type: 'forkui:exit-preview' }); }) }, 'Publish for everyone'),
        el('button', { class: 'secondary', onclick: () => act(async () => { await api('/features/' + f.id + '/discard', { method: 'POST' }); post({ type: 'forkui:exit-preview' }); }) }, 'Discard'),
        el('button', { class: 'ghost', onclick: () => post({ type: 'forkui:exit-preview' }) }, 'Exit preview'));
      notes.push('You are previewing this version. Only you can see it.');
    } else if (mine) {
      row.append(
        el('button', { class: 'secondary', onclick: () => act(preview) }, 'Preview'),
        el('button', { class: 'accent', onclick: () => act(async () => { await api('/features/' + f.id + '/publish', { method: 'POST' }); post({ type: 'forkui:reload' }); }) }, 'Publish for everyone'),
        el('button', { class: 'ghost', onclick: () => act(() => api('/features/' + f.id + '/discard', { method: 'POST' })) }, 'Discard'));
      if (f.liveToo) notes.push('An earlier version is live for everyone; this new version is not published yet.');
    } else if (f.status === 'live') notes.push('Live for everyone in your organization. Chat below to change it.');
    else if (f.status === 'paused') notes.push('Paused: the app was updated and this feature could not be carried over yet.');
    else if (f.status === 'off') notes.push('Built, but not live (your organization is on the standard app).');
    else if (f.status === 'draft' && !f.busy)
      row.append(el('button', { class: 'ghost', onclick: () => act(async () => { await api('/features/' + f.id, { method: 'DELETE' }); open({ name: 'list' }); }) }, 'Delete draft'));
    return [back, title, ...notes.map((n) => el('div', { class: 'muted' }, n)), row.childNodes.length ? row : null];
  }

  function message(m, f) {
    if (m.role === 'user') return el('div', { class: 'msg user' }, m.text);
    if (m.kind === 'notice') return el('div', { class: 'msg notice' + (m.outcome === 'published' ? ' good' : '') }, m.text);
    if (m.kind === 'proposal') {
      const p = m.proposal;
      const card = el('div', { class: 'card' + (m.status === 'superseded' ? ' superseded' : '') },
        el('div', {}, m.text), el('h3', {}, p.title), el('div', { class: 'k' }, 'Done when:'),
        el('ul', {}, ...p.criteria.map((c) => el('li', {}, c))));
      if (m.status === 'proposed') {
        const other = detail.pending && detail.pending.intentId !== f.id;
        const verb = f.status === 'draft' ? 'Build it' : 'Build this version';
        card.append(el('div', { class: 'row' },
          el('button', { class: 'accent', ...(other || f.busy ? { disabled: '' } : {}), onclick: () => act(() => api('/features/' + f.id + '/build', { method: 'POST', body: JSON.stringify({ messageId: m.id }) })) }, verb),
          el('button', { class: 'ghost', onclick: () => $('input').focus() }, 'Change something')));
        if (other) card.append(el('div', { class: 'k' }, 'Publish or discard “' + detail.pending.title + '” first.'));
      } else if (m.status === 'superseded') card.append(el('div', { class: 'k' }, 'Replaced by a newer proposal'));
      return card;
    }
    if (m.kind === 'build') {
      const job = jobs[m.jobId];
      if (job && job.status === 'gone') return el('div', { class: 'msg assistant' }, m.text.replace(/…$/, ''));
      const steps = [];
      for (const l of (job ? job.log : [])) { const h = humanize(l); if (h && steps[steps.length - 1] !== h) steps.push(h); }
      const running = !job || job.status === 'queued' || job.status === 'running';
      const ul = el('ul', { class: 'steps' }, ...steps.slice(-8).map((s, i, a) => el('li', { class: running && i === a.length - 1 ? 'now' : '' }, s)));
      if (running && !steps.length) ul.append(el('li', { class: 'now' }, 'Getting started'));
      return el('div', { class: 'msg assistant' }, m.text, ul);
    }
    if (m.kind === 'result') {
      const ok = m.outcome === 'committed';
      const box = el('div', { class: 'msg assistant' + (ok ? '' : ' bad') }, m.text);
      if (ok && detail.pending && detail.pending.releaseId === m.releaseId && !previewing)
        box.append(el('div', { class: 'row' }, el('button', { class: 'secondary', onclick: () => act(preview) }, 'Preview')));
      return box;
    }
    return el('div', { class: 'msg assistant' }, m.text);
  }

  function welcome() {
    const ex = ['Add a Priority column to the deals table, high priority in red', 'Add a Win rate card to the dashboard', 'Add a Pipeline view with a column per stage'];
    return el('div', { class: 'msg assistant' }, 'What would you like to change? Describe it like you would to a colleague. I\\'ll propose it, build it, and you can preview it before anyone else sees it.',
      el('div', { class: 'chips' }, ...ex.map((t) => el('button', { class: 'chip', onclick: () => { $('input').value = t; $('input').focus(); } }, t))));
  }

  function renderFeature() {
    $('composer').classList.remove('hidden');
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (view.name === 'new' || !detail) {
      $('bar').className = 'bar';
      $('bar').replaceChildren(el('button', { class: 'ghost', onclick: () => open({ name: 'list' }) }, '← All features'), el('div', { class: 'title' }, 'New feature'));
      box.replaceChildren(welcome());
      $('send').disabled = sending;
      return;
    }
    const f = detail.feature;
    $('bar').className = 'bar' + (previewing && detail.pending && detail.pending.intentId === f.id ? ' previewing' : '');
    $('bar').replaceChildren(...actions(f));
    const nodes = detail.messages.map((m) => message(m, f));
    const last = detail.messages[detail.messages.length - 1];
    if (f.busy && last && last.role === 'user') nodes.push(el('div', { class: 'typing' }, 'Thinking…'));
    if (!nodes.length) nodes.push(el('div', { class: 'msg assistant' }, 'This feature was created before chats existed. Tell me how you\\'d like to change it.'));
    box.replaceChildren(...nodes);
    if (atBottom) box.scrollTop = box.scrollHeight;
    $('send').disabled = sending || f.busy;
  }

  async function refresh() {
    try {
      if (view.name === 'list') { list = await api('/features'); return renderList(); }
      if (view.name === 'new') return renderFeature();
      detail = await api('/features/' + view.id);
      for (const m of detail.messages)
        if (m.kind === 'build' && m.jobId && (!jobs[m.jobId] || ['queued', 'running'].includes(jobs[m.jobId].status)))
          jobs[m.jobId] = await api('/jobs/' + m.jobId).catch((e) => (/no job/.test(e.message) ? { status: 'gone', log: [] } : jobs[m.jobId]));
      renderFeature();
    } catch (e) {
      if (/no such feature/.test(e.message)) return open({ name: 'list' });
      $('messages').replaceChildren(el('div', { class: 'msg notice bad' }, 'Session expired. Close and reopen Customize.'));
    }
  }

  $('composer').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text || sending) return;
    sending = true;
    $('input').value = '';
    try {
      if (view.name === 'new') {
        const r = await api('/features', { method: 'POST', body: JSON.stringify({ text }) });
        sending = false;
        return open({ name: 'feature', id: r.featureId });
      }
      detail.messages.push({ role: 'user', kind: 'text', text });
      detail.feature.busy = true;
      renderFeature();
      await api('/features/' + view.id + '/messages', { method: 'POST', body: JSON.stringify({ text }) });
    } catch (err) { oops(err.message); }
    sending = false;
    refresh();
  };
  $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); } });

  if (!token) { $('messages').replaceChildren(el('div', { class: 'msg notice' }, 'Open this from the Customize button in your app.')); return; }
  api('').then((me) => { $('subtitle').textContent = me.tenantId; }).catch(() => {});
  // Where to start: the feature being previewed, else the last one open, else the list.
  api('/features').then((l) => {
    list = l;
    const start = previewing && l.pending ? l.pending.intentId : remembered();
    if (start && l.features.some((f) => f.id === start)) open({ name: 'feature', id: start });
    else open({ name: 'list' });
  }).catch(() => refresh());
  setInterval(refresh, 1500);
})();`;
