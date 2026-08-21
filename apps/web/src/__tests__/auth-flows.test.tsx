import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiError, mockApi, resetApiMocks } from './helpers/mock-api';
import { renderRoute } from './helpers/render';
import { ForgotPasswordPage } from '../features/auth/forgot-password-page';
import { ResetPasswordPage } from '../features/auth/reset-password-page';
import { AcceptInvitationPage } from '../features/auth/accept-invitation-page';

/**
 * Component coverage for the unauthenticated credential screens.
 *
 * SCOPE, stated honestly: these run in jsdom against a stubbed api-client, so
 * they cover screen behaviour — validation, loading, error and success states,
 * and the branch each API status drives. They are NOT browser end-to-end tests;
 * there is no real network, no real navigation and no real rendering engine.
 * The API contracts themselves are covered by the 132 API e2e tests.
 */
describe('Forgot password screen', () => {
  beforeEach(() => resetApiMocks());
  afterEach(() => resetApiMocks());

  it('shows a generic confirmation that does not reveal whether the account exists', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockResolvedValue({ message: 'sent' });

    renderRoute(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'nobody@example.test');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    // "If an account exists" — never "no account found", which would hand back
    // the enumeration oracle the API works to avoid.
    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent(/if an account exists/i);
    expect(confirmation.textContent).not.toMatch(/not found|no account|does not exist/i);
  });

  it('surfaces the development link when the API returns one', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockResolvedValue({ message: 'sent', resetToken: 'dev-token-123' });

    renderRoute(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'someone@example.test');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText(/development only/i)).toBeInTheDocument();
    expect(screen.getByText(/dev-token-123/)).toBeInTheDocument();
  });

  it('shows a field error for an invalid email', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockRejectedValue(
      apiError(400, 'Validation failed', { email: ['must be a valid email address'] }),
    );

    renderRoute(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'bad');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText(/must be a valid email address/i)).toBeInTheDocument();
  });

  it('disables the button while submitting', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockImplementation(() => new Promise(() => undefined));

    renderRoute(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'someone@example.test');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    const button = screen.getByRole('button', { name: /sending/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});

describe('Reset password screen', () => {
  const renderReset = () =>
    renderRoute(<ResetPasswordPage />, {
      path: '/reset-password/:token',
      url: '/reset-password/abc123',
    });

  beforeEach(() => resetApiMocks());
  afterEach(() => resetApiMocks());

  it('rejects a mismatched confirmation without calling the API', async () => {
    const user = userEvent.setup();
    renderReset();

    await user.type(screen.getByLabelText(/^new password/i), 'AVeryLongPassword1');
    await user.type(screen.getByLabelText(/confirm/i), 'ADifferentPassword1');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    // Confirmation is purely a UI concern — the API cannot know what was meant.
    expect(mockApi.apiPost).not.toHaveBeenCalled();
  });

  it('rejects a password below the minimum length without calling the API', async () => {
    const user = userEvent.setup();
    renderReset();

    await user.type(screen.getByLabelText(/^new password/i), 'short');
    await user.type(screen.getByLabelText(/confirm/i), 'short');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(mockApi.apiPost).not.toHaveBeenCalled();
  });

  it('confirms success and explains that other sessions ended', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockResolvedValue({ reset: true });

    renderReset();

    await user.type(screen.getByLabelText(/^new password/i), 'AVeryLongPassword1');
    await user.type(screen.getByLabelText(/confirm/i), 'AVeryLongPassword1');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText(/password updated/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/signed out everywhere else/i);
  });

  it.each([
    [404, 'This password reset link is not valid. Please request a new one.'],
    [410, 'This password reset link has expired. Please request a new one.'],
  ])('offers a new link when the API returns %i', async (status, message) => {
    const user = userEvent.setup();
    mockApi.apiPost.mockRejectedValue(apiError(status, message));

    renderReset();

    await user.type(screen.getByLabelText(/^new password/i), 'AVeryLongPassword1');
    await user.type(screen.getByLabelText(/confirm/i), 'AVeryLongPassword1');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    // A dead link needs a route forward, not just an error.
    expect(await screen.findByText(/no longer valid/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request a new link/i })).toBeInTheDocument();
  });

  it('keeps the user on the form when only the password was rejected', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockRejectedValue(
      apiError(400, 'Validation failed', { password: ['is too common'] }),
    );

    renderReset();

    await user.type(screen.getByLabelText(/^new password/i), 'AVeryLongPassword1');
    await user.type(screen.getByLabelText(/confirm/i), 'AVeryLongPassword1');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    // The link is still good, so sending them to "request a new link" would be
    // wrong — they just need to pick a different password.
    expect(await screen.findByText(/is too common/i)).toBeInTheDocument();
    expect(screen.queryByText(/no longer valid/i)).not.toBeInTheDocument();
  });
});

describe('Invitation acceptance screen', () => {
  const renderInvite = () =>
    renderRoute(<AcceptInvitationPage />, {
      path: '/invite/:token',
      url: '/invite/tok123',
    });

  beforeEach(() => resetApiMocks());
  afterEach(() => resetApiMocks());

  it('shows the organization and role before asking for anything', async () => {
    mockApi.apiGet.mockResolvedValue({
      organizationName: 'Northwind Supply',
      role: 'MANAGER',
      email: 'newhire@example.test',
      hasAccount: false,
      expiresAt: null,
    });

    renderInvite();

    expect(await screen.findByText(/join northwind supply/i)).toBeInTheDocument();
    expect(screen.getByText(/invited as manager/i)).toBeInTheDocument();
    expect(screen.getByText('newhire@example.test')).toBeInTheDocument();
  });

  it('asks a new user for a name and password', async () => {
    mockApi.apiGet.mockResolvedValue({
      organizationName: 'Northwind Supply',
      role: 'SALES_REP',
      email: 'newhire@example.test',
      hasAccount: false,
      expiresAt: null,
    });

    renderInvite();

    expect(await screen.findByLabelText(/first name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/choose a password/i)).toBeInTheDocument();
  });

  it('does NOT ask an existing user for a password', async () => {
    mockApi.apiGet.mockResolvedValue({
      organizationName: 'Northwind Supply',
      role: 'SALES_REP',
      email: 'existing@example.test',
      hasAccount: true,
      expiresAt: null,
    });

    renderInvite();

    // Asking would either be ignored or imply their existing password is being
    // reset by whoever forwarded the link.
    expect(await screen.findByText(/already have an account/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/choose a password/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept invitation/i })).toBeInTheDocument();
  });

  it('explains a dead invitation instead of showing a broken form', async () => {
    mockApi.apiGet.mockRejectedValue(
      apiError(404, 'This invitation link is no longer valid. Ask an administrator to send a new one.'),
    );

    renderInvite();

    expect(await screen.findByText(/invitation unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/no longer valid/i);
    expect(screen.getByRole('link', { name: /go to sign in/i })).toBeInTheDocument();
  });

  it('confirms acceptance and points at sign in', async () => {
    const user = userEvent.setup();
    mockApi.apiGet.mockResolvedValue({
      organizationName: 'Northwind Supply',
      role: 'SALES_REP',
      email: 'newhire@example.test',
      hasAccount: false,
      expiresAt: null,
    });
    mockApi.apiPost.mockResolvedValue({ accepted: true });

    renderInvite();

    await user.type(await screen.findByLabelText(/first name/i), 'Jordan');
    await user.type(screen.getByLabelText(/last name/i), 'Blake');
    await user.type(screen.getByLabelText(/choose a password/i), 'AVeryLongPassword1');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText(/you're in/i)).toBeInTheDocument();
    });
  });
});
