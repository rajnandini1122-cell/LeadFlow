import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiError, mockApi, resetApiMocks } from './helpers/mock-api';
import { renderRoute } from './helpers/render';
import { SecurityPage } from '../features/settings/security-page';

const SESSIONS = [
  {
    id: '01a01d8b-0000-7000-8000-000000000001',
    platform: 'WEB',
    deviceName: null,
    ipAddress: '203.0.113.4',
    organization: { id: 'org-1', name: 'Northwind Supply' },
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    current: true,
  },
  {
    id: '01a01d8b-0000-7000-8000-000000000002',
    platform: 'ANDROID',
    deviceName: 'Pixel 8',
    ipAddress: '198.51.100.7',
    organization: { id: 'org-1', name: 'Northwind Supply' },
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    current: false,
  },
];

describe('Security page — change password', () => {
  beforeEach(() => {
    resetApiMocks();
    mockApi.apiGet.mockResolvedValue(SESSIONS);
  });
  afterEach(() => resetApiMocks());

  const fill = async (
    user: ReturnType<typeof userEvent.setup>,
    current: string,
    next: string,
    confirm: string,
  ): Promise<void> => {
    await user.type(screen.getByLabelText(/current password/i), current);
    await user.type(screen.getByLabelText(/^new password/i), next);
    await user.type(screen.getByLabelText(/confirm new password/i), confirm);
    await user.click(screen.getByRole('button', { name: /update password/i }));
  };

  it('rejects a mismatched confirmation without calling the API', async () => {
    const user = userEvent.setup();
    renderRoute(<SecurityPage />);

    await fill(user, 'OldPassword123', 'AVeryLongPassword1', 'ADifferentPassword1');

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(mockApi.apiPost).not.toHaveBeenCalled();
  });

  it('rejects a short new password without calling the API', async () => {
    const user = userEvent.setup();
    renderRoute(<SecurityPage />);

    await fill(user, 'OldPassword123', 'short', 'short');

    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(mockApi.apiPost).not.toHaveBeenCalled();
  });

  it('refuses reusing the current password', async () => {
    const user = userEvent.setup();
    renderRoute(<SecurityPage />);

    await fill(user, 'AVeryLongPassword1', 'AVeryLongPassword1', 'AVeryLongPassword1');

    expect(await screen.findByText(/different from your current one/i)).toBeInTheDocument();
    expect(mockApi.apiPost).not.toHaveBeenCalled();
  });

  it('reports a wrong current password against that field', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockRejectedValue(apiError(401, 'Email or password is incorrect.'));

    renderRoute(<SecurityPage />);
    await fill(user, 'WrongPassword123', 'AVeryLongPassword1', 'AVeryLongPassword1');

    // Attached to the field that was actually wrong, not shown as a generic
    // banner — otherwise the user re-types the new password instead.
    expect(await screen.findByText(/not your current password/i)).toBeInTheDocument();
  });

  it('confirms success and says other devices were signed out', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockResolvedValue({ changed: true });

    renderRoute(<SecurityPage />);
    await fill(user, 'OldPassword123', 'AVeryLongPassword1', 'AVeryLongPassword1');

    await waitFor(() => {
      expect(screen.getByText(/other devices have been signed out/i)).toBeInTheDocument();
    });

    expect(mockApi.apiPost).toHaveBeenCalledWith('/auth/change-password', {
      currentPassword: 'OldPassword123',
      newPassword: 'AVeryLongPassword1',
    });
  });
});

describe('Security page — sessions', () => {
  beforeEach(() => {
    resetApiMocks();
    mockApi.apiGet.mockResolvedValue(SESSIONS);
  });
  afterEach(() => resetApiMocks());

  it('lists sessions and marks the current device', async () => {
    renderRoute(<SecurityPage />);

    expect(await screen.findByText('Pixel 8')).toBeInTheDocument();
    expect(screen.getByText('Web browser')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
  });

  it('offers sign-out only for OTHER sessions', async () => {
    renderRoute(<SecurityPage />);
    await screen.findByText('Pixel 8');

    // One button for the Android session, none for the current one — signing
    // yourself out belongs to the Sign out control, not this list.
    const signOutButtons = screen.getAllByRole('button', { name: /^sign out$/i });
    expect(signOutButtons).toHaveLength(1);

    const currentRow = screen.getByText('This device').closest('li');
    expect(within(currentRow as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('revokes a session and confirms it', async () => {
    const user = userEvent.setup();
    mockApi.del.mockResolvedValue(undefined);

    renderRoute(<SecurityPage />);
    await screen.findByText('Pixel 8');

    await user.click(screen.getByRole('button', { name: /^sign out$/i }));

    await waitFor(() => {
      expect(mockApi.del).toHaveBeenCalledWith(
        '/auth/sessions/01a01d8b-0000-7000-8000-000000000002',
      );
    });

    expect(await screen.findByText(/that device has been signed out/i)).toBeInTheDocument();
  });

  it('shows an error state when sessions cannot be loaded', async () => {
    mockApi.apiGet.mockRejectedValue(apiError(500, 'boom'));

    renderRoute(<SecurityPage />);

    expect(await screen.findByText(/could not load this/i)).toBeInTheDocument();
  });
});
