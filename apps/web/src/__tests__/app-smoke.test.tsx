import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app';
/**
 * Smoke test: does the application actually MOUNT and paint something?
 *
 * This exists because a passing build is not evidence that the page renders.
 * The app once shipped a green `vite build` while `npm run dev` served a blank
 * page — a crash-on-mount is invisible to the compiler.
 *
 * SCOPE, honestly stated: Vitest transforms modules through Vite's own runner,
 * which performs CommonJS interop. It therefore does NOT reproduce the
 * browser's stricter native-ESM loading, and would not by itself have caught
 * the CJS/ESM resolution failure that caused that blank page — verified by
 * removing the alias and watching this suite still pass. What it does catch is
 * any error thrown while rendering the tree, which is the larger and more
 * frequent class. Module-resolution changes still need one real browser load.
 */
describe('App smoke test', () => {
  beforeEach(() => {
    // No session: the restore call on mount must 401 so the app settles on
    // the login screen rather than hanging in its loading state.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts without throwing and renders visible content', async () => {
    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.innerHTML.length).toBeGreaterThan(0);
    });
  });

  it('lands on the login screen when there is no session', async () => {
    render(<App />);

    // The single most important assertion here: real, user-visible text.
    // A blank page passes any "did it throw?" check but fails this one.
    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: 'LeadFlow' })).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    expect(screen.getByText('No lead left behind.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
