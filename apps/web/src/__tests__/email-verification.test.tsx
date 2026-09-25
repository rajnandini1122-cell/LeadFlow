import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ERROR_CODES, type ErrorCode } from '@leadflow/api-types';
import { mockApi, resetApiMocks } from './helpers/mock-api';
import { ApiError } from '../lib/api-client';
import { AuthProvider } from '../features/auth/auth-context';
import { RegisterPage } from '../features/auth/register-page';
import { VerifyEmailPage } from '../features/auth/verify-email-page';

/**
 * The screens a person actually meets when their email has to be confirmed.
 *
 * SCOPE, stated honestly: jsdom against a stubbed api-client, so these cover
 * screen behaviour — which branch each server code drives, what the copy says,
 * and what is NOT said. The contracts themselves are covered by
 * `apps/api/test/email-verification.e2e-spec.ts`.
 */

/**
 * The server's refusal, carrying the CODE the screens branch on.
 *
 * Typed as `ErrorCode` rather than `string` deliberately: a screen that
 * branched on a code the API cannot actually emit would be dead code that
 * looks like coverage, and the compiler catches the typo here.
 */
function verificationError(code: ErrorCode, status: number, message = 'refused'): ApiError {
  return new ApiError(code, message, status);
}

function renderVerify(token: string | undefined, wrapper: (node: ReactNode) => ReactNode = (n) => n) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  const url = token === undefined ? '/verify-email' : `/verify-email/${token}`;

  return render(
    wrapper(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
            <Route path="/login" element={<p>Sign in page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

describe('The verification link screen', () => {
  beforeEach(() => resetApiMocks());
  afterEach(() => resetApiMocks());

  it('says something from the very first render', () => {
    mockApi.apiPost.mockImplementation(() => new Promise(() => undefined));

    renderVerify('a-token');

    // Never a blank screen while the request is in flight — this page is
    // reached by tapping a link in an email, with no context at all.
    expect(screen.getByRole('status')).toHaveTextContent(/checking your verification link/i);
  });

  it('confirms the address it verified', async () => {
    mockApi.apiPost.mockResolvedValue({ email: 'vera@example.test' });

    renderVerify('a-token');

    expect(await screen.findByText(/email confirmed/i)).toBeInTheDocument();
    expect(screen.getByText('vera@example.test')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
  });

  it('posts the token from the URL', async () => {
    mockApi.apiPost.mockResolvedValue({ email: 'vera@example.test' });

    renderVerify('token-from-the-email');

    await waitFor(() => expect(mockApi.apiPost).toHaveBeenCalled());
    expect(mockApi.apiPost).toHaveBeenCalledWith('/auth/verify-email', {
      token: 'token-from-the-email',
    });
  });

  it('treats an already-verified account as good news, not an error', async () => {
    mockApi.apiPost.mockRejectedValue(
      verificationError(ERROR_CODES.EMAIL_VERIFICATION_ALREADY_COMPLETED, 409),
    );

    renderVerify('a-spent-token');

    /*
     * The commonest cause is somebody clicking twice, or a mail client
     * prefetching the URL before they tap it. Their account is verified, so
     * telling them something went wrong would be a lie about it.
     */
    expect(await screen.findByText(/already confirmed/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
  });

  it('offers a new link when the old one expired, and says how long they last', async () => {
    mockApi.apiPost.mockRejectedValue(verificationError(ERROR_CODES.EMAIL_VERIFICATION_EXPIRED, 409));

    renderVerify('a-stale-token');

    expect(await screen.findByText(/that link has expired/i)).toBeInTheDocument();
    expect(screen.getByText(/24 hours/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send a new link/i })).toBeInTheDocument();
  });

  it('offers a new link when the token was never valid', async () => {
    mockApi.apiPost.mockRejectedValue(verificationError(ERROR_CODES.EMAIL_VERIFICATION_INVALID, 404));

    renderVerify('nonsense');

    expect(await screen.findByText(/not valid/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send a new link/i })).toBeInTheDocument();
  });

  it('falls back to the resend form for an unrecognised failure', async () => {
    // A 500, a network drop, anything unmapped. A dead end with no way
    // forward is the one outcome this screen must never produce.
    mockApi.apiPost.mockRejectedValue(new Error('network down'));

    renderVerify('a-token');

    expect(await screen.findByRole('button', { name: /send a new link/i })).toBeInTheDocument();
  });

  it('asks for the address when the page is reached with no token', () => {
    renderVerify(undefined);

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    // Nothing to redeem, so nothing is posted.
    expect(mockApi.apiPost).not.toHaveBeenCalled();
  });

  it('spends the token ONCE even under StrictMode double mounting', async () => {
    mockApi.apiPost.mockResolvedValue({ email: 'vera@example.test' });

    renderVerify('single-use-token', (node) => <StrictMode>{node}</StrictMode>);

    await screen.findByText(/email confirmed/i);

    /*
     * The token is single-use. Without the guard in the page, development
     * StrictMode spends it on the first mount and the second reports "already
     * verified" — so a perfectly good link looks broken to every developer,
     * and the bug lives only where it cannot be seen in production.
     */
    expect(mockApi.apiPost).toHaveBeenCalledTimes(1);
  });
});

describe('Asking for another verification link', () => {
  beforeEach(() => resetApiMocks());
  afterEach(() => resetApiMocks());

  it('sends the address and confirms without revealing whether it exists', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockResolvedValue({ message: 'sent' });

    renderVerify(undefined);

    await user.type(screen.getByLabelText(/email/i), 'nobody@example.test');
    await user.click(screen.getByRole('button', { name: /send a new link/i }));

    const confirmation = await screen.findByRole('status');

    /*
     * Phrased as what WILL happen, and identical whatever the address. The
     * server answers the same way for an account that exists, one already
     * verified and one that never existed; a screen that narrowed that down
     * would hand back the enumeration oracle the API works to close.
     */
    expect(confirmation).toHaveTextContent(/if that address needs confirming/i);
    expect(confirmation.textContent).not.toMatch(/not found|no account|does not exist|already/i);
  });

  it('posts to the resend endpoint with the typed address', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockResolvedValue({ message: 'sent' });

    renderVerify(undefined);

    await user.type(screen.getByLabelText(/email/i), 'vera@example.test');
    await user.click(screen.getByRole('button', { name: /send a new link/i }));

    await waitFor(() =>
      expect(mockApi.apiPost).toHaveBeenCalledWith('/auth/verify-email/resend', {
        email: 'vera@example.test',
      }),
    );
  });

  it('reports a failure to send rather than claiming success', async () => {
    const user = userEvent.setup();
    mockApi.apiPost.mockRejectedValue(new Error('network down'));

    renderVerify(undefined);

    await user.type(screen.getByLabelText(/email/i), 'vera@example.test');
    await user.click(screen.getByRole('button', { name: /send a new link/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not send/i);
    expect(screen.queryByText(/on its way/i)).not.toBeInTheDocument();
  });

  it('does not submit twice on a double click', async () => {
    const user = userEvent.setup();
    let resolve: (value: unknown) => void = () => undefined;
    mockApi.apiPost.mockImplementation(() => new Promise((r) => (resolve = r)));

    renderVerify(undefined);

    await user.type(screen.getByLabelText(/email/i), 'vera@example.test');
    const button = screen.getByRole('button', { name: /send a new link/i });
    await user.click(button);
    await user.click(button);

    expect(mockApi.apiPost).toHaveBeenCalledTimes(1);
    resolve({ message: 'sent' });
  });
});

/** The register page reads auth state, so it needs the provider around it. */
function renderRegister(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <RegisterPage />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Answers the registration call, and ONLY that call.
 *
 * The provider silently tries to refresh a session on mount. A blanket mock
 * answers that too, so the page decides it is already signed in and redirects
 * before anything can be typed.
 */
function respondToRegistration(body: Record<string, unknown>): void {
  mockApi.apiPost.mockImplementation((path: string) =>
    path === '/auth/register' ? Promise.resolve(body) : Promise.reject(new Error('no session')),
  );
}

const unverifiedResponse = {
  verified: false,
  verificationEmailSent: true,
  user: {
    id: 'u1',
    email: 'vera@example.test',
    fullName: 'Vera Verify',
    organization: {
      id: 'o1',
      name: 'Kestrel',
      locale: 'en-IN',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    },
    permissions: [],
  },
};

describe('Registering', () => {
  beforeEach(() => resetApiMocks());
  afterEach(() => resetApiMocks());

  const fillAndSubmit = async (): Promise<void> => {
    const user = userEvent.setup();
    const { fireEvent } = await import('@testing-library/react');

    // Set directly rather than typed: these cases are about what happens
    // AFTER submitting, and sixty synthetic keystrokes is enough work under a
    // loaded suite to time the test out on its own.
    const fill = (label: RegExp, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };

    fill(/organization name/i, 'Kestrel Interiors');
    fill(/first name/i, 'Vera');
    fill(/last name/i, 'Verify');
    fill(/work email/i, 'vera@example.test');
    fill(/^password/i, 'correct-horse-battery');

    await user.click(screen.getByRole('button', { name: /create organization/i }));
  };

  it('stops on "check your email" instead of opening the dashboard', async () => {
    respondToRegistration(unverifiedResponse);

    renderRegister();
    await fillAndSubmit();

    /*
     * THE regression test for the reported defect: registering used to land
     * straight in the Dashboard, with nobody having proved they owned the
     * address they typed.
     */
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
    expect(screen.queryByText(/dashboard/i)).not.toBeInTheDocument();
  });

  it('names the address it wrote to, and how long the link lasts', async () => {
    respondToRegistration(unverifiedResponse);

    renderRegister();
    await fillAndSubmit();

    await screen.findByText(/check your email/i);
    expect(screen.getByText('vera@example.test')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/24\s*hours/i);
  });

  it('says the account exists when the email could not be sent', async () => {
    respondToRegistration({ ...unverifiedResponse, verificationEmailSent: false });

    renderRegister();
    await fillAndSubmit();

    /*
     * Silence here would leave somebody waiting for an email that was never
     * even accepted for delivery. The account really was created, so the copy
     * says so and points at the fix rather than implying the signup failed.
     */
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/account was created/i);
    expect(alert).toHaveTextContent(/could not send/i);
  });

  it('offers a way to get another link', async () => {
    respondToRegistration(unverifiedResponse);

    renderRegister();
    await fillAndSubmit();

    await screen.findByText(/check your email/i);
    expect(screen.getByRole('link', { name: /send a new link/i })).toHaveAttribute(
      'href',
      '/verify-email',
    );
  });

  it('never claims the message was delivered', async () => {
    respondToRegistration(unverifiedResponse);

    renderRegister();
    await fillAndSubmit();

    const status = await screen.findByRole('status');

    // The provider accepting a message is not an inbox receiving it, and
    // nothing in this system can know the difference.
    expect(status.textContent).not.toMatch(/delivered|arrived|received/i);
  });
});
