import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from '../App';
import { mockApi } from '../test/mockApi';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('renders dashboard and deals table', async () => {
  mockApi();
  render(<App />);
  expect(await screen.findByText('Website revamp')).toBeTruthy();
  expect(screen.getByText('Open pipeline')).toBeTruthy();
  expect(screen.getByText('$32,000')).toBeTruthy(); // 12000 + 20000 open
  expect(screen.getAllByRole('row')).toHaveLength(5);
});
