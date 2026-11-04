import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../App';
import { mockApi } from '../test/mockApi';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('renders dashboard and deals table', async () => {
  mockApi();
  render(<App />);
  expect(await screen.findByText('Website revamp')).toBeTruthy();
  expect(screen.getByText('Open pipeline')).toBeTruthy();
  expect(screen.getByText('$32,000')).toBeTruthy();
  expect(screen.getByText('Avg open deal')).toBeTruthy();
  expect(screen.getAllByRole('row')).toHaveLength(5);
});

test('search filters the deals table', async () => {
  mockApi();
  render(<App />);
  await screen.findByText('Website revamp');
  fireEvent.change(screen.getByLabelText('Search deals'), { target: { value: 'globex' } });
  expect(screen.getAllByRole('row')).toHaveLength(2);
});
