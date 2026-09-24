import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiError, mockApi, resetApiMocks } from './helpers/mock-api';
import { AuthProvider } from '../features/auth/auth-context';
import { LoginPage } from '../features/auth/login-page';

/**
 * Signing in when the account belongs to more than one organization.
 *
 * Covers a production outage: the chooser rendered, clicking a card produced
 * HTTP 200, and the chooser rendered again — forever. Two things had to be
 * true for that, and both are asserted here.
 *
 * The server side (the real cause) was a field named `organizationId` being
 * stripped from the request body by the tenant-isolation interceptor. The
 * client half is that the selection must actually travel as
 * `targetOrganizationId`, which is what the payload assertions below pin.
 *
 * Rendered through the REAL AuthProvider rather than a stubbed `useAuth`, so
 * the field mapping inside `login()` is exercised rather than mocked past. Only
 * the api-client is stubbed.
 */
describe('Organization chooser', () => {
  const OWNER_ORG = {
    id: '01920000-0000-7000-8000-00000000000a',
    name: 'Cravion Ventures OPC Pvt Ltd',
    slug: 'cravion-ventures-opc',
    role: 'OWNER',
  };

  const PLATFORM_ORG = {
    id: '01920000-0000-7000-8000-00000000000b',
    name: 'CRAVION VENTURES (OPC) PRIVATE LIMITED',
    slug: 'cravion-ventures',
    role: 'PLATFORM_OWNER',
  };

  const authenticatedResponse = (organization: typeof OWNER_ORG) => ({
    requiresOrganizationSelection: false,
    tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' },
    user: {
      id: 'user-1',
      email: 'shvbhosale@outlook.test',
      fullName: 'Test Owner',
      mobile: null,
      avatarUrl: null,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        locale: 'en-IN',
        country: 'IN',
        status: 'ACTIVE',
      },
      role: organization.role,
      permissions: [],
    },
  });

  const chooserResponse = {
    requiresOrganizationSelection: true,
    organizations: [OWNER_ORG, PLATFORM_ORG],
  };

  const renderLogin = (): void => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/dashboard" element={<p>Dashboard</p>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  /** Fills the credentials form and submits it. */
  const signIn = async (): Promise<void> => {
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'shvbhosale@outlook.test');
    await user.type(screen.getByLabelText('Password'), 'CorrectHorse!2026');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
  };

  /**
   * Finds an organization card by name.
   *
   * Matched with a predicate rather than a RegExp. The real platform
   * organization is "CRAVION VENTURES (OPC) PRIVATE LIMITED", and those
   * parentheses are a capture group — built into a pattern they match nothing,
   * and the test then fails on the click instead of on the assertion.
   */
  const card = (name: string) =>
    screen.getByRole('button', {
      name: (accessibleName: string) => accessibleName.includes(name),
    });

  /** Every POST made to the login endpoint, in order. */
  const loginCalls = () =>
    mockApi.apiPost.mock.calls.filter((call) => call[0] === '/auth/login');

  /**
   * Scripts the login endpoint, leaving every other call to fail.
   *
   * Specifically `/auth/refresh`: the provider probes for an existing session
   * on mount, and an unauthenticated start is SUPPOSED to be a 401. A blanket
   * `mockResolvedValue` answers that probe with a valid session too, which
   * lands the test on the dashboard before it has typed anything — how the
   * first version of this file failed all eleven tests at once.
   */
  const scriptLogin = (...responses: Array<() => Promise<unknown>>): void => {
    let next = 0;

    mockApi.apiPost.mockImplementation((url: string) => {
      if (url !== '/auth/login') {
        // Includes the startup refresh. No stored session in these tests.
        return Promise.reject(apiError(401, 'Unauthorized'));
      }

      const responder = responses[Math.min(next, responses.length - 1)];
      next += 1;
      return responder ? responder() : Promise.reject(apiError(500, 'unscripted login call'));
    });
  };

  const chooser = () => Promise.resolve(chooserResponse);
  const signedInAs = (organization: typeof OWNER_ORG) => () =>
    Promise.resolve(authenticatedResponse(organization));
  const refused = (status: number, message: string) => () =>
    Promise.reject(apiError(status, message));

  beforeEach(() => {
    resetApiMocks();
    mockApi.apiGet.mockRejectedValue(apiError(401, 'Unauthorized'));
  });

  afterEach(() => resetApiMocks());

  describe('a single-organization account', () => {
    it('enters the app without showing a chooser', async () => {
      scriptLogin(signedInAs(OWNER_ORG));

      renderLogin();
      await signIn();

      expect(await screen.findByText('Dashboard')).toBeInTheDocument();
      expect(screen.queryByText('Choose an organization')).toBeNull();
      expect(loginCalls()).toHaveLength(1);
    });
  });

  describe('a multi-organization account', () => {
    it('renders the chooser with both memberships', async () => {
      scriptLogin(chooser);
      renderLogin();
      await signIn();

      expect(await screen.findByText('Choose an organization')).toBeInTheDocument();
      expect(screen.getByText(OWNER_ORG.name)).toBeInTheDocument();
      expect(screen.getByText(PLATFORM_ORG.name)).toBeInTheDocument();
      expect(screen.getByText('OWNER')).toBeInTheDocument();
      expect(screen.getByText('PLATFORM_OWNER')).toBeInTheDocument();
    });

    it('renders the cards as buttons that do not submit a form', async () => {
      scriptLogin(chooser);
      renderLogin();
      await signIn();

      await screen.findByText('Choose an organization');

      /*
       * `type="button"`, explicitly.
       *
       * A button inside a form defaults to `type="submit"`. These cards are not
       * in the credentials form today, but stating the type is what stops a
       * future layout change from turning a click into a silent re-submission
       * of the login instead of an organization choice.
       */
      expect(card(OWNER_ORG.name)).toHaveAttribute('type', 'button');
    });

    it('completes the login when the OWNER organization is chosen', async () => {
      scriptLogin(chooser, signedInAs(OWNER_ORG));

      renderLogin();
      await signIn();
      await screen.findByText('Choose an organization');

      await userEvent.click(card(OWNER_ORG.name));

      expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    });

    it('completes the login when the PLATFORM_OWNER organization is chosen', async () => {
      scriptLogin(chooser, signedInAs(PLATFORM_ORG));

      renderLogin();
      await signIn();
      await screen.findByText('Choose an organization');

      await userEvent.click(card(PLATFORM_ORG.name));

      expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    });

    it('sends the choice as targetOrganizationId, the name that survives stripping', async () => {
      scriptLogin(chooser, signedInAs(PLATFORM_ORG));

      renderLogin();
      await signIn();
      await screen.findByText('Choose an organization');

      await userEvent.click(card(PLATFORM_ORG.name));
      await screen.findByText('Dashboard');

      const selection = loginCalls()[1]?.[1] as Record<string, unknown>;

      /*
       * THE regression assertion on the client side.
       *
       * `organizationId` is deleted from every request body by the server's
       * tenant-field interceptor, so sending that name meant the choice never
       * arrived and the chooser came back. The name is the fix.
       */
      expect(selection['targetOrganizationId']).toBe(PLATFORM_ORG.id);
      expect(selection).not.toHaveProperty('organizationId');
    });

    it('calls the login endpoint exactly twice: once to sign in, once to choose', async () => {
      scriptLogin(chooser, signedInAs(OWNER_ORG));

      renderLogin();
      await signIn();
      await screen.findByText('Choose an organization');

      await userEvent.click(card(OWNER_ORG.name));
      await screen.findByText('Dashboard');

      /*
       * Two, not three.
       *
       * A card that re-submitted the credentials form as well as choosing would
       * produce an extra call — the failure mode originally suspected, and the
       * one that would burn through the login rate limit. The first call
       * carries no selection; the second carries exactly one.
       */
      expect(loginCalls()).toHaveLength(2);
      expect(loginCalls()[0]?.[1]).not.toHaveProperty('targetOrganizationId');
      expect(loginCalls()[1]?.[1]).toHaveProperty('targetOrganizationId');
    });

    it('sends the credentials once per choice, not once per card rendered', async () => {
      scriptLogin(chooser, signedInAs(OWNER_ORG));

      renderLogin();
      await signIn();
      await screen.findByText('Choose an organization');

      // Rendering two cards must not itself cost two requests.
      expect(loginCalls()).toHaveLength(1);
    });
  });

  describe('fail-closed', () => {
    it('stays on the chooser and shows the reason when a choice is refused', async () => {
      scriptLogin(chooser, refused(403, 'You do not have access to that organization.'));

      renderLogin();
      await signIn();
      await screen.findByText('Choose an organization');

      await userEvent.click(card(PLATFORM_ORG.name));

      // No navigation, no session, and the refusal is visible rather than
      // swallowed — which is what made the original bug so hard to read.
      expect(
        await screen.findByText('You do not have access to that organization.'),
      ).toBeInTheDocument();
      expect(screen.queryByText('Dashboard')).toBeNull();
      expect(screen.getByText('Choose an organization')).toBeInTheDocument();
    });

    it('lets the user try the other organization after a refusal', async () => {
      scriptLogin(
        chooser,
        refused(403, 'You do not have access to that organization.'),
        signedInAs(OWNER_ORG),
      );

      renderLogin();
      await signIn();
      await screen.findByText('Choose an organization');

      await userEvent.click(card(PLATFORM_ORG.name));
      await screen.findByText('You do not have access to that organization.');

      await userEvent.click(card(OWNER_ORG.name));

      expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    });

    it('does not sign in on a server error', async () => {
      scriptLogin(chooser, refused(500, 'Something went wrong.'));

      renderLogin();
      await signIn();
      await screen.findByText('Choose an organization');

      await userEvent.click(card(OWNER_ORG.name));

      await waitFor(() => expect(screen.queryByText('Dashboard')).toBeNull());
      expect(screen.getByText('Choose an organization')).toBeInTheDocument();
    });
  });
});
