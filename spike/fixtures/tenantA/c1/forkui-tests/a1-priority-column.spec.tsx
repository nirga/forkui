// Acceptance test for tenant A, commit a1:
// "Show each deal's priority as a column in the deals table, right after Stage, colored red for high."
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { App } from '../src/App';
import { mockApi } from '../src/test/mockApi';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('deals table has a Priority column after Stage', async () => {
  mockApi();
  render(<App />);
  await screen.findByText('Website revamp');
  const table = screen.getByRole('table');
  const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim().toLowerCase());
  const stageIdx = headers.findIndex((h) => h === 'stage' || h === 'status');
  expect(stageIdx).toBeGreaterThanOrEqual(0);
  expect(headers[stageIdx + 1]).toBe('priority');
});

test('high priority is shown in red', async () => {
  mockApi();
  render(<App />);
  const row = (await screen.findByText('Website revamp')).closest('tr')!;
  const badge = within(row).getByText('high');
  expect(badge.getAttribute('style') ?? '').toMatch(/color:\s*(#d92d20|rgb\(217,\s*45,\s*32\))/i);
});
