import fs from 'node:fs';
import path from 'node:path';
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'results');
const kv = (f) => {
  const o = {};
  if (!fs.existsSync(f)) return o;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
};
const rows = [];
for (const name of fs.readdirSync(dir).sort()) {
  const d = path.join(dir, name);
  const [tenant, strategy, model, trial] = name.split('-');
  const o = kv(path.join(d, 'outcome.txt'));
  const m = kv(path.join(d, 'meta.txt'));
  const c = kv(path.join(d, 'check.txt'));
  const fin = fs.existsSync(path.join(d, 'final-message.txt')) ? fs.readFileSync(path.join(d, 'final-message.txt'), 'utf8') : '';
  const checkTxt = fs.existsSync(path.join(d, 'check.txt')) ? fs.readFileSync(path.join(d, 'check.txt'), 'utf8') : '';
  rows.push({
    tenant, strategy, model, trial,
    outcome: o.OUTCOME ?? 'running',
    cost: m.COST_USD ? Number(m.COST_USD) : 0,
    secs: m.WALL_SECONDS ? Number(m.WALL_SECONDS) : 0,
    turns: m.TURNS ?? '',
    tests: c.TESTS_PASSED ?? '',
    tampered: /TAMPERED/.test(checkTxt),
    pinMsg: fin.trim().startsWith('PIN:') ? fin.trim().slice(0, 160).replace(/\n/g, ' ') : '',
  });
}
console.log('| run | outcome | tests | turns | secs | cost $ | notes |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows)
  console.log(`| ${r.tenant}-${r.strategy}-${r.model}-${r.trial} | ${r.outcome} | ${r.tests} | ${r.turns} | ${r.secs} | ${r.cost.toFixed(2)} | ${r.tampered ? 'TAMPERED ' : ''}${r.pinMsg} |`);
const groups = {};
for (const r of rows) {
  const k = `${r.tenant} ${r.strategy} ${r.model}`;
  (groups[k] ??= []).push(r);
}
console.log('\n| tenant / strategy / model | n | clean | agent-resolved | pinned | failed | avg secs | avg $ |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [k, rs] of Object.entries(groups)) {
  const n = (o) => rs.filter((r) => r.outcome === o).length;
  const avg = (f) => (rs.reduce((s, r) => s + f(r), 0) / rs.length);
  console.log(`| ${k} | ${rs.length} | ${n('clean')} | ${n('agent_resolved')} | ${n('pinned')} | ${n('failed')} | ${avg((r) => r.secs).toFixed(0)} | ${avg((r) => r.cost).toFixed(2)} |`);
}
console.log(`\nTotal cost: $${rows.reduce((s, r) => s + r.cost, 0).toFixed(2)}`);
