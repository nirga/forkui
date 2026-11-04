import { describe, expect, test } from 'vitest';
import { ConfigError, formatIntentMessage, parseConfig, parseIntentTrailers, refs } from '../src/index.ts';

describe('config', () => {
  test('applies defaults and always locks the config file', () => {
    const c = parseConfig(
      JSON.stringify({ version: 1, checks: [{ name: 'build', run: ['npm', 'run', 'build'] }], agent: { model: 'openai:gpt-5.4' } }),
    );
    expect(c.paths.tenantTests).toBe('forkui-tests');
    expect(c.paths.locked).toContain('forkui.config.json');
    expect(c.agent.model).toBe('openai:gpt-5.4');
    expect(c.agent.escalateTo).toBeNull();
    // No default provider: the vendor must choose a model.
    expect(() => parseConfig(JSON.stringify({ version: 1, checks: [{ name: 'b', run: ['x'] }] }))).toThrow(/agent/);
    expect(() => parseConfig(JSON.stringify({ version: 1, checks: [{ name: 'b', run: ['x'] }], agent: { model: 'no-provider' } }))).toThrow(ConfigError);
    expect(c.checks[0]!.timeoutMs).toBe(300_000);
  });

  test('reports schema issues with paths', () => {
    expect(() => parseConfig(JSON.stringify({ version: 2, checks: [] }))).toThrow(ConfigError);
    try {
      parseConfig(JSON.stringify({ version: 1, checks: [{ name: 'Bad Name', run: [] }] }));
    } catch (e) {
      expect((e as ConfigError).issues.join('\n')).toMatch(/checks\.0\.name/);
    }
  });

  test('rejects invalid JSON', () => {
    expect(() => parseConfig('{nope')).toThrow(/not valid JSON/);
  });
});

describe('trailers', () => {
  test('round-trips', () => {
    const msg = formatIntentMessage(
      'Add Priority column',
      { intentId: 'a1', intent: 'Show priority\nafter stage', spec: 'forkui-tests/a1.spec.md', test: 'forkui-tests/a1.spec.tsx' },
      'Longer body.',
    );
    expect(msg).toContain('Forkui-Intent: Show priority after stage');
    expect(parseIntentTrailers(msg)).toEqual({
      intentId: 'a1',
      intent: 'Show priority after stage',
      spec: 'forkui-tests/a1.spec.md',
      test: 'forkui-tests/a1.spec.tsx',
    });
  });

  test('returns null for non-intent commits and bad ids', () => {
    expect(parseIntentTrailers('Vendor release\n\nSome body')).toBeNull();
    expect(parseIntentTrailers('x\n\nForkui-Intent-Id: Bad Id\nForkui-Intent: y')).toBeNull();
    expect(() => formatIntentMessage('x', { intentId: '../x', intent: 'y' })).toThrow();
  });
});

describe('refs', () => {
  test('validates ids', () => {
    expect(refs.tenant('acme-co')).toBe('refs/heads/tenants/acme-co');
    expect(() => refs.tenant('../main')).toThrow();
    expect(() => refs.base('v1..2')).toThrow();
    expect(refs.base('v1.2.0')).toBe('refs/tags/base/v1.2.0');
  });
});
