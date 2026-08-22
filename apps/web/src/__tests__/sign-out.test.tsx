import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../app';
import * as apiClient from '../lib/api-client';

/**
 * Where signing out leaves you.
 *
 * It must end at the public home page, not at a password box. Landing on
 * /login reads as "signing out failed" — the user asked to leave, and being
 * shown another login form suggests they are still half-in. It is also the
 * only route from which the Android download is reachable, since a signed-in
 * visitor at `/` is sent to their dashboard instead.
 */

const USER = {
  id: 'u-1',
  email: 'owner@northwind.example',
  fullName: 'Dana Whitfield',
  status: 'ACTIVE',
  role: 'OWNER',
  permissions: ['org.view', 'org.update', 'lead.view.all', 'lead.update'],
  organization: {
    id: 'org-1',
    name: 'Northwind Supply',
    slug: 'northwind-supply',
    timezone: 'America/Chicago',
    currency: 'USD',
    locale: 'en-US',
    country: 'US',
  },
  organizations: [],
};

/**
 * A signed-in session.
 *
 * The restore call on mount succeeds, which is what puts the app into its
 * authenticated state without going through the login form.
 */
function mockSignedIn(): void {
  vi.spyOn(apiClient, 'apiPost').mockImplementation((path: string) => {
    if (path === '/auth/refresh') {
      return Promise.resolve({ tokens: { accessToken: 'access-1' }, user: USER } as never);
    }
    // Logout, and anything else, succeeds quietly.
    return Promise.resolve({} as never);
  });

  // Dashboard widgets and nav badges. The shapes only need to be complete
  // enough to render; this test is about where sign-out lands, not the numbers.
  vi.spyOn(apiClient, 'apiGet').mockImplementation((path: string) => {
    if (path === '/organizations/current') {
      return Promise.resolve({ settings: { omnichannelEnabled: true } } as never);
    }
    if (path.startsWith('/dashboard')) {
      return Promise.resolve({
        scope: 'ALL',
        timezone: 'America/Chicago',
        followUps: { overdue: 0, dueToday: 0, upcoming: 0 },
        pipeline: { activeValue: 0, activeCount: 0, byStage: [] },
        outcomes: { conversionRate: 0, won: 0, lost: 0, newThisWeek: 0, wonValue: 0 },
        contacts: 0,
        nextActions: [],
        recent: [],
      } as never);
    }
    // The home page's pricing table expects an array, and it is the page
    // sign-out lands on.
    if (path.startsWith('/plans')) return Promise.resolve([] as never);
    return Promise.resolve({ items: [], count: 0 } as never);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signing out', () => {
  it('lands on the public home page, not the login form', { timeout: 25000 }, async () => {
    const user = userEvent.setup();
    mockSignedIn();

    window.history.pushState({}, '', '/dashboard');
    render(<App />);

    const signOut = await screen.findByRole('button', { name: /sign out/i }, { timeout: 10000 });
    await user.click(signOut);

    await waitFor(
      () => {
        expect(
          screen.getByRole('heading', { name: 'Never lose another lead' }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    expect(window.location.pathname).toBe('/');
  });

  it('still lands home when the logout request fails', { timeout: 25000 }, async () => {
    const user = userEvent.setup();
    mockSignedIn();

    vi.spyOn(apiClient, 'apiPost').mockImplementation((path: string) => {
      if (path === '/auth/refresh') {
        return Promise.resolve({ tokens: { accessToken: 'access-1' }, user: USER } as never);
      }
      // The server is unreachable. The user still asked to leave.
      return Promise.reject(new Error('offline'));
    });

    window.history.pushState({}, '', '/dashboard');
    render(<App />);

    const signOut = await screen.findByRole('button', { name: /sign out/i }, { timeout: 10000 });
    await user.click(signOut);

    await waitFor(
      () => {
        expect(
          screen.getByRole('heading', { name: 'Never lose another lead' }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );
  });
});
