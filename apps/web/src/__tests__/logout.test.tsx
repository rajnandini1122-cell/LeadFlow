import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../features/auth/auth-context';
import * as apiClient from '../lib/api-client';

/**
 * Where signing out lands you.
 *
 * Regression cover for a real bug: `logout` cleared the session but never
 * navigated, so the route guard fired on the next render and dropped the user
 * on the login screen. Signing out and immediately being asked to sign in
 * reads as the sign-out having failed.
 */

function Marketing(): React.JSX.Element {
  return <h1>Never lose another lead</h1>;
}

function Login(): React.JSX.Element {
  return <h1>Sign in to LeadFlow</h1>;
}

function Dashboard(): React.JSX.Element {
  const { logout, status } = useAuth();

  return (
    <div>
      <p>Dashboard for {status}</p>
      <button type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </div>
  );
}

function renderApp(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Marketing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/dashboard" element={<Dashboard />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Signing out', () => {
  beforeEach(() => {
    // Session restore fails, then the logout POST succeeds. The restore
    // outcome does not matter here — what matters is where logout leaves you.
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({} as never);
    vi.spyOn(apiClient, 'apiGet').mockRejectedValue(new Error('no session'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns to the public site, not the login screen', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Never lose another lead' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('heading', { name: 'Sign in to LeadFlow' })).toBeNull();
  });

  it('calls the logout endpoint so the server revokes the session', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    // Clearing local state alone would leave a working refresh cookie behind.
    await waitFor(() => {
      expect(apiClient.apiPost).toHaveBeenCalledWith('/auth/logout');
    });
  });

  it('still leaves the session cleared when the server call fails', async () => {
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    // The user asked to leave. A failed network call must not trap them in a
    // session they have already abandoned.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Never lose another lead' })).toBeInTheDocument();
    });
  });
});
