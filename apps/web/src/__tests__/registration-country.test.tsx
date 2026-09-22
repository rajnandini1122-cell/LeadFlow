import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockApi, resetApiMocks } from './helpers/mock-api';
import { AuthProvider } from '../features/auth/auth-context';
import { RegisterPage } from '../features/auth/register-page';
import { DEFAULT_COUNTRY, countryOptions } from '../lib/countries';

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
 * before the test can type a single character — which is how this suite first
 * rendered an empty document.
 */
function acceptRegistration(): void {
  mockApi.apiPost.mockImplementation((path: string) =>
    path === '/auth/register'
      ? Promise.resolve({
          tokens: { accessToken: 'a', refreshToken: 'r' },
          user: {
            id: 'u1',
            email: 'priya@example.test',
            fullName: 'Priya Sharma',
            organization: {
              id: 'o1',
              name: 'Kestrel',
              locale: 'en-IN',
              currency: 'INR',
              timezone: 'Asia/Kolkata',
            },
            permissions: [],
          },
        })
      : Promise.reject(new Error('no session')),
  );
}

/** The registration POST, whatever else the provider attempted around it. */
function registrationCall(): [string, Record<string, unknown>] {
  const call = mockApi.apiPost.mock.calls.find(([path]) => path === '/auth/register');
  if (!call) throw new Error('registration was never posted');

  return call as [string, Record<string, unknown>];
}

/**
 * The country a new organization is created in.
 *
 * Not a cosmetic preference: it decides how every phone number the tenant
 * later types is read into its canonical form, and therefore whether the same
 * customer entered twice is recognised as one person. The form never asked,
 * so every organization created on the web silently took the server's default
 * — correct for the market this opens in, wrong for everybody else, and
 * invisible either way.
 */
describe('the country list', () => {
  it('comes from the browser region data rather than a list in source', () => {
    const options = countryOptions();

    // A hand-kept list drifts from what the API accepts; this one cannot,
    // because the server validates against the same ICU data.
    expect(options.length).toBeGreaterThan(200);
    expect(options.map((option) => option.code)).toEqual(
      expect.arrayContaining(['IN', 'US', 'GB', 'DE', 'AE']),
    );
  });

  it('excludes the code that means "no country"', () => {
    // ZZ is ISO's own "unknown region". ICU names it, so it passes every other
    // check and would otherwise be offered as somewhere to be.
    expect(countryOptions().map((option) => option.code)).not.toContain('ZZ');
  });

  it('reads in alphabetical order by name', () => {
    const names = countryOptions().map((option) => option.name);

    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
  });
});

describe('Registration', () => {
  beforeEach(() => resetApiMocks());
  afterEach(() => resetApiMocks());

  /*
   * Values set directly rather than typed.
   *
   * These cases are about what the form SUBMITS, not about typing, and sixty
   * synthetic keystrokes across five fields is enough work under a loaded
   * suite to time the test out on its own.
   */
  const fillRequiredFields = (): void => {
    const fill = (label: RegExp, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };

    fill(/organization name/i, 'Kestrel Interiors');
    fill(/first name/i, 'Priya');
    fill(/last name/i, 'Sharma');
    fill(/work email/i, 'priya@example.test');
    fill(/^password/i, 'correct-horse-battery');
  };

  it('offers a country, defaulting to where this deployment sells', () => {
    renderRegister();

    const field = screen.getByLabelText(/country/i) as HTMLSelectElement;

    expect(field.value).toBe(DEFAULT_COUNTRY);
    expect(field.value).toBe('IN');
  });

  it('sends the country with the registration', async () => {
    const user = userEvent.setup();
    acceptRegistration();

    renderRegister();
    fillRequiredFields();
    await user.selectOptions(screen.getByLabelText(/country/i), 'DE');
    await user.click(screen.getByRole('button', { name: /create organization/i }));

    await waitFor(() => expect(mockApi.apiPost).toHaveBeenCalled());

    const [path, body] = registrationCall();
    expect(path).toBe('/auth/register');
    // The chosen country reaches the API, rather than the founder's choice
    // being collected and then dropped on the way.
    expect(body['country']).toBe('DE');
  });

  it('sends the default when the founder leaves it alone', async () => {
    const user = userEvent.setup();
    acceptRegistration();

    renderRegister();
    fillRequiredFields();
    await user.click(screen.getByRole('button', { name: /create organization/i }));

    await waitFor(() => expect(mockApi.apiPost).toHaveBeenCalled());

    const [, body] = registrationCall();
    // Explicit rather than absent, so what the form showed is what the tenant
    // gets — the two defaults agreeing is not something to leave to chance.
    expect(body['country']).toBe('IN');
  });
});
