// Acceptance test for tenant B, commit b2:
// "Add a Pipeline tab next to Overview that shows open and won deals as kanban columns by stage, with counts."
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from '../src/App';
import { mockApi } from '../src/test/mockApi';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('Pipeline tab shows kanban columns grouped by stage', async () => {
  mockApi();
  render(<App />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Pipeline' }));
  const proposal = screen.getByRole('region', { name: 'proposal' });
  expect(within(proposal).getByText('Website revamp')).toBeTruthy();
  expect(within(proposal).getByText(/proposal \(1\)/i)).toBeTruthy();
  const lead = screen.getByRole('region', { name: 'lead' });
  expect(within(lead).getByText('Data migration')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'lost' })).toBeNull();
});

test('Overview tab still shows the deals table', async () => {
  mockApi();
  render(<App />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
  expect(screen.getByRole('table')).toBeTruthy();
});
