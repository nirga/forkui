#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { dev, doctor, release, tenants } from './commands.ts';
import { init, uninstall } from './init.ts';

const HELP = `forkui — per-customer forks of your frontend that survive your releases

  forkui init [--model provider:model] [--yes] [--no-install]   set up this repo (one line per surface)
  forkui dev [--port 4400]                                      run a local forkui server
  forkui release [version]                                      publish HEAD and carry every customer onto it
  forkui doctor [--no-checks]                                   check this repo is ready
  forkui tenants                                                list customers and their status
  forkui uninstall                                              remove forkui from this repo
`;

const out = { log: (s: string) => console.log(s) };

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string' },
      escalate: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'no-install': { type: 'boolean' },
      'no-checks': { type: 'boolean' },
      port: { type: 'string' },
      url: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, arg] = positionals;
  const root = process.cwd();
  const url = values.url;

  switch (cmd) {
    case 'init': {
      let model = values.model;
      if (!model) {
        if (values.yes || !process.stdin.isTTY) throw new Error('Pass --model, e.g. --model anthropic:claude-sonnet-5-5 or --model openai:gpt-5.4');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        model = (await rl.question('Which model should edit your code? (provider:model, e.g. anthropic:claude-sonnet-5-5, openai:gpt-5.4, ollama:qwen3-coder)\n> ')).trim();
        rl.close();
      }
      const branch = (() => {
        try {
          return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        } catch {
          return 'main';
        }
      })();
      const r = init(root, { model, escalateTo: values.escalate ?? null, branch });
      const d = r.detection;
      out.log(`Detected: ${[d.vite && 'Vite', d.react && 'React', d.typescript && 'TypeScript', d.testRunner, d.server && `${d.server.kind} server (${d.server.file})`, d.pm].filter(Boolean).join(', ')}`);
      for (const f of r.created) out.log(`  + ${f}`);
      for (const f of r.edited) out.log(`  ~ ${f}`);
      if (r.unchanged) out.log('  Already set up; nothing changed.');
      for (const m of r.manual) out.log(`\n! ${m}`);
      if (!values['no-install'] && !r.unchanged) {
        const pm = d.pm;
        out.log(`\nInstalling with ${pm}…`);
        execFileSync(pm, ['install'], { cwd: root, stdio: 'inherit' });
      }
      out.log(`\nNext:
  1. Review the diff (git diff). The two resolvers in your server decide who is which customer and who may customize.
  2. npx forkui dev       (local forkui server; publishes your current commit as the first base release, and prints
                          FORKUI_URL / FORKUI_SECRET for your app server)
  3. npx forkui doctor    (verifies everything)
  4. For a deployed forkui server: run \`npx forkui release\` once to publish your first base release (customers can't
     customize until one exists). After that, .github/workflows/forkui.yml releases on every push. Set the
     FORKUI_URL and FORKUI_SECRET repo secrets.`);
      return;
    }
    case 'dev':
      await dev(root, { port: Number(values.port ?? 4400) }, out);
      return; // server keeps the process alive
    case 'release':
      await release(root, { ...(arg ? { version: arg } : {}), ...(url ? { url } : {}) }, out);
      return;
    case 'doctor':
      await doctor(root, { checks: !values['no-checks'], ...(url ? { url } : {}) }, out);
      return;
    case 'tenants':
      await tenants(url ? { url } : {}, out);
      return;
    case 'uninstall':
      for (const f of uninstall(root)) out.log(`  - ${f}`);
      out.log('forkui removed. Run your package manager to drop the packages.');
      return;
    default:
      out.log(HELP);
      if (cmd && cmd !== 'help' && !values.help) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`forkui: ${(e as Error).message}`);
  process.exitCode = 1;
});
