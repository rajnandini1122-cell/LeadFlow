import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RegisterPage } from '../features/auth/register-page';
import * as authContext from '../features/auth/auth-context';
import { ApiError } from '../lib/api-client';

/**
 * What the registration form SENDS, and what it does with a refusal.
 *
 * Both halves of a reported production defect live here. The page showed
 * "Request validation failed." and highlighted nothing, because the server
 * filed every field's message under one key the form could not look up. The API
 * suite asserts the server now returns per-field details; this asserts the form
 * renders them, and that the payload it sends is the one RegisterDto accepts.
 */
describe('Registration form', () => {
  const register = vi.fn();

  beforeEach(() => {
    register.mockReset();
    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      register,
      loginWithGoogle: vi.fn(),
      registerWithGoogle: vi.fn(),
      status: 'anonymous',
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderPage = (): void => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <RegisterPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  const fillForm = async (): Promise<void> => {
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/organization name/i), 'Acme Supplies');
    await user.type(screen.getByLabelText(/first name/i), 'Asha');
    await user.type(screen.getByLabelText(/last name/i), 'Nair');
    await user.type(screen.getByLabelText(/work email/i), 'asha@acme.test');
    await user.type(screen.getByLabelText(/password/i), 'Str0ng-Passphrase!2026');
  };

  it('sends exactly the fields RegisterDto accepts', async () => {
    register.mockResolvedValue(undefined);
    renderPage();

    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /create organization/i }));

    await waitFor(() => expect(register).toHaveBeenCalled());

    const payload = register.mock.calls[0]?.[0] as Record<string, unknown>;

    /*
     * The KEYS are the assertion.
     *
     * The API runs `forbidNonWhitelisted`, so one extra key here is a 400 on a
     * correctly filled form — the worst version of this bug, because nothing
     * the person types can fix it. The API suite asserts the same list from the
     * other side.
     */
    expect(Object.keys(payload).sort()).toEqual([
      'country',
      'email',
      'firstName',
      'lastName',
      'organizationName',
      'password',
    ]);

    // And the country really is a code the server will accept, not a label.
    expect(payload['country']).toMatch(/^[A-Z]{2}$/);
  });

  it('shows the server’s field-level message next to the field', async () => {
    register.mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Request validation failed.', 400, {
        password: ['must be at least 12 characters'],
      }),
    );

    renderPage();
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /create organization/i }));

    /*
     * The assertion the defect would have failed. Before the fix the details
     * arrived under `_`, this lookup found nothing, and the person was left
     * with a generic banner on a six-field form.
     */
    expect(await screen.findByText('must be at least 12 characters')).toBeInTheDocument();
  });

  it('shows a message for every rejected field at once', async () => {
    register.mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Request validation failed.', 400, {
        organizationName: ['must be at least 2 characters'],
        email: ['must be a valid email address'],
        password: ['must be at least 12 characters'],
      }),
    );

    renderPage();
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /create organization/i }));

    // Somebody who mistyped three fields should be told about three.
    expect(await screen.findByText('must be at least 2 characters')).toBeInTheDocument();
    expect(screen.getByText('must be a valid email address')).toBeInTheDocument();
    expect(screen.getByText('must be at least 12 characters')).toBeInTheDocument();
  });

  it('still shows the summary message for an error with no field details', async () => {
    register.mockRejectedValue(
      new ApiError('CONFLICT', 'That email address is already registered.', 409),
    );

    renderPage();
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /create organization/i }));

    // Not every refusal belongs to a field — a duplicate email is about the
    // request as a whole, and the banner is still the right place for it.
    expect(
      await screen.findByText('That email address is already registered.'),
    ).toBeInTheDocument();
  });
});
