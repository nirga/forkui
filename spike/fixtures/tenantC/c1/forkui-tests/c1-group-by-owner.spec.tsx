// Acceptance test for tenant C, commit c1:
// "Above the deals table, show one card per sales rep (owner) with their total and their deals."
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { App } from '../src/App';
import { mockApi } from '../src/test/mockApi';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('one card per owner with their total and deal count', async () => {
  mockApi();
  render(<App />);
  const dana = await screen.findByRole('region', { name: /Dana/ });
  expect(within(dana).getByText('Total: $32,000')).toBeTruthy();
  expect(within(dana).getByText('2 deals')).toBeTruthy();
  const lee = screen.getByRole('region', { name: /Lee/ });
  expect(within(lee).getByText('Total: $5,000')).toBeTruthy();
  expect(within(lee).getByText('1 deal')).toBeTruthy();
});
