import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelIntegrationsPage } from '../features/settings/channel-integrations-page';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';

/**
 * The switch that lets WhatsApp enquiries become leads on their own.
 *
 * This is not a display preference like the other toggles on this screen: it
 * assigns real leads to real salespeople and creates a follow-up for each,
 * which is easy to turn on and hard to undo. So these tests check the COPY as
 * carefully as the behaviour — an owner has to be able to predict what
 * switching it on does before they do it, and the two things most likely to
 * surprise them are "does every message become a lead?" and "what happens to
 * the ones that don't?".
 */

const NOT_CONNECTED = {
  channel: 'WHATSAPP' as const,
  status: 'NOT_CONNECTED' as const,
  enabled: false,
  id: null,
  displayName: null,
  connectable: true,
  connectedAt: null,
  connectedBy: null,
  lastMessageAt: null,
};

const TOGGLE = /automatically create leads from whatsapp buying enquiries/i;

/**
 * The toggle, once the organization query has SETTLED.
 *
 * The control renders immediately in a disabled, unchecked state while the
 * query is in flight, so asserting straight after `findByRole` reads the
 * loading state rather than the organization's. That made the "unchecked" case
 * pass for the wrong reason — false while pending is indistinguishable from
 * false because the setting is off. Waiting for it to become enabled is what
 * proves the data arrived first.
 */
async function settledToggle(): Promise<HTMLElement> {
  const toggle = await screen.findByRole('checkbox', { name: TOGGLE });
  await waitFor(() => expect(toggle).toBeEnabled());
  return toggle;
}

/** Answers the two calls this page makes, and only those. */
function mockApi(options: { whatsappAutoLeadEnabled?: boolean; canManage?: boolean } = {}): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((path: string) => {
    if (path === '/organizations/current') {
      return Promise.resolve({
        settings: {
          whatsappAutoLeadEnabled: options.whatsappAutoLeadEnabled ?? false,
          sharedUnassignedQueue: false,
          omnichannelEnabled: true,
        },
      } as never);
    }
    // An ARRAY: `/channel-integrations` returns IntegrationView[], and the page
    // maps over it.
    if (path === '/channel-integrations') {
      return Promise.resolve([NOT_CONNECTED] as never);
    }
    return Promise.resolve({ items: [], connected: false } as never);
  });

  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: () => options.canManage ?? true,
  } as never);
}

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ChannelIntegrationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('The WhatsApp auto-lead toggle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders unchecked when the organization has it off', async () => {
    mockApi({ whatsappAutoLeadEnabled: false });
    renderPage();

    // Off is the default, and an owner must be able to see that it is off
    // rather than assume.
    expect(await settledToggle()).not.toBeChecked();
  });

  it('renders checked when the organization has it on', async () => {
    mockApi({ whatsappAutoLeadEnabled: true });
    renderPage();

    expect(await settledToggle()).toBeChecked();
  });

  it('persists through the existing organization-settings endpoint', async () => {
    mockApi({ whatsappAutoLeadEnabled: false });
    const patch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue({} as never);

    renderPage();
    const user = userEvent.setup();
    await user.click(await settledToggle());

    /*
     * The SAME endpoint every other organization setting uses. That is what
     * makes this change validated, permission-checked and audited identically
     * to the rest — a dedicated route would have had to re-earn all three.
     */
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/organizations/current', {
        settings: { whatsappAutoLeadEnabled: true },
      }),
    );
  });

  it('can be switched back off', async () => {
    mockApi({ whatsappAutoLeadEnabled: true });
    const patch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue({} as never);

    renderPage();
    const user = userEvent.setup();
    await user.click(await settledToggle());

    // Explicit false, not an omitted key. Somebody switching this off is
    // usually reacting to leads they did not want.
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/organizations/current', {
        settings: { whatsappAutoLeadEnabled: false },
      }),
    );
  });

  it('is read-only for somebody who cannot manage the organization', async () => {
    mockApi({ whatsappAutoLeadEnabled: false, canManage: false });
    renderPage();

    // The API refuses a sales rep regardless; disabling the control means they
    // are not invited to try and then shown an error.
    expect(await screen.findByRole('checkbox', { name: TOGGLE })).toBeDisabled();
  });

  it('says it only fires on a buying signal, and what happens to the rest', async () => {
    mockApi({ whatsappAutoLeadEnabled: false });
    renderPage();

    await screen.findByRole('checkbox', { name: TOGGLE });
    const text = document.body.textContent ?? '';

    // The two questions an owner will have before switching it on.
    expect(text).toMatch(/only when an inbound whatsapp message contains a buying signal/i);
    expect(text).toMatch(/remain in the inbox and review queue/i);
  });

  it('warns that an existing active lead is not duplicated', async () => {
    mockApi({ whatsappAutoLeadEnabled: false });
    renderPage();

    await screen.findByRole('checkbox', { name: TOGGLE });
    const text = document.body.textContent ?? '';

    // Real behaviour of the conversion pipeline, stated up front rather than
    // discovered when a customer's second message does not appear as a lead.
    expect(text).toMatch(/no second one is created/i);
    expect(text).toMatch(/nothing is dropped/i);
  });

  it('says WhatsApp only, and why', async () => {
    mockApi({ whatsappAutoLeadEnabled: false });
    renderPage();

    await screen.findByRole('checkbox', { name: TOGGLE });
    const text = document.body.textContent ?? '';

    /*
     * "Why not Instagram?" is the immediate next question, and the honest
     * answer is a data constraint: those channels carry no phone number, so
     * there is nothing to de-duplicate a second enquiry against.
     */
    expect(text).toMatch(/instagram and messenger do not provide a phone number/i);
  });

  it('never claims a lead is created from every message', async () => {
    mockApi({ whatsappAutoLeadEnabled: true });
    renderPage();

    await screen.findByRole('checkbox', { name: TOGGLE });
    const text = document.body.textContent ?? '';

    // The overclaim this feature is most likely to drift into.
    expect(text).not.toMatch(/every (inbound )?message becomes a lead/i);
    expect(text).not.toMatch(/all messages become leads/i);
  });
});
