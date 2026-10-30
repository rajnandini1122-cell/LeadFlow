import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelIntegrationsPage } from '../features/settings/channel-integrations-page';
import * as apiClient from '../lib/api-client';
import * as platform from '../lib/platform';
import * as authContext from '../features/auth/auth-context';

/**
 * Settings → Channels → WhatsApp → Webhook setup.
 *
 * Configuring Meta app 1596224018290106 (2026-10-30), the screen asked for a
 * Phone number ID and token but never said WHERE Meta should send messages, so
 * the callback URL had to be dug out of the source. This box states it, and
 * deliberately never states the deployment-wide verify token.
 */

const NOT_CONNECTED = {
  channel: 'WHATSAPP' as const,
  id: null,
  status: 'NOT_CONNECTED' as const,
  enabled: false,
  displayName: null,
  connectedAt: null,
  disconnectedAt: null,
  lastActivityAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  connectedBy: null,
  accessTokenHint: null,
  connectable: true,
};

function renderPage(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
  } as never);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <MemoryRouter>
        <ChannelIntegrationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Production's address, as the Android build carries it (the web build's
  // relative "/api/v1" resolves to the same thing on leadflow.cravionventures.com).
  vi.spyOn(platform, 'apiBaseUrl').mockReturnValue('https://leadflow.cravionventures.com/api/v1');
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) =>
    url === '/channel-integrations'
      ? Promise.resolve([NOT_CONNECTED, { ...NOT_CONNECTED, channel: 'INSTAGRAM', connectable: false }] as never)
      : Promise.resolve({ settings: { sharedUnassignedQueue: false } } as never),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WhatsApp webhook setup', () => {
  it('shows the exact callback URL and the field to subscribe', async () => {
    renderPage(['org.view', 'org.update']);

    const box = (await screen.findByRole('heading', { name: 'Webhook setup' })).closest('section') as HTMLElement;
    expect(within(box).getByLabelText('Callback URL')).toHaveValue(
      'https://leadflow.cravionventures.com/api/v1/webhooks/whatsapp',
    );
    expect(within(box).getByText('messages', { selector: 'code' })).toBeInTheDocument();
    expect(box).toHaveTextContent(/Verify and save/);
  });

  it('copies the callback URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage(['org.view', 'org.update']);

    const box = (await screen.findByRole('heading', { name: 'Webhook setup' })).closest('section') as HTMLElement;
    await userEvent.click(within(box).getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith('https://leadflow.cravionventures.com/api/v1/webhooks/whatsapp');
    expect(await within(box).findByText('Callback URL copied.')).toBeInTheDocument();
  });

  it('says the verify token is administrator-managed, and shows no secret field', async () => {
    renderPage(['org.view', 'org.update']);

    const box = (await screen.findByRole('heading', { name: 'Webhook setup' })).closest('section') as HTMLElement;
    expect(box).toHaveTextContent(/Managed by your LeadFlow administrator, and never shown here/);
    // The only input in the box is the read-only URL — no token, no secret.
    const inputs = within(box).getAllByRole('textbox');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveAttribute('readonly');
  });

  it('is not shown to someone who cannot manage channels', async () => {
    renderPage(['org.view']);

    await screen.findByRole('heading', { name: /channel integrations/i });
    expect(screen.queryByRole('heading', { name: 'Webhook setup' })).not.toBeInTheDocument();
  });
});
