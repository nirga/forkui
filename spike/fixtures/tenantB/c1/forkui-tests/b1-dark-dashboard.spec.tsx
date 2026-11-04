// Acceptance test for tenant B, commit b1:
// "Make the dashboard dark, make the pipeline card a wide purple hero card, and add a Win rate card."
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from '../src/App';
import { mockApi } from '../src/test/mockApi';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('dashboard shows win rate (won / closed)', async () => {
  mockApi();
  render(<App />);
  expect(await screen.findByText('Win rate')).toBeTruthy();
  expect(screen.getByText('50%')).toBeTruthy(); // 1 won, 1 lost
});

test('dashboard uses the dark theme with a hero pipeline card', async () => {
  mockApi();
  render(<App />);
  const label = await screen.findByText('Open pipeline');
  expect(label.closest('.card-hero')).toBeTruthy();
  expect(label.closest('.cards-dark')).toBeTruthy();
});
