import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelIntegrationsPage } from '../features/settings/channel-integrations-page';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';

/**
 * Managing WhatsApp templates from settings.
 *
 * LeadFlow discovers templates; it cannot create one and cannot approve one.
 * The assertions below are mostly about that boundary: nothing is invented
 * locally, Meta's status is shown as Meta reported it, and a disconnected
 * channel says so rather than presenting an empty list as though it meant
 * "you have no templates".
 */

const TEMPLATE = {
  name: 'order_ready',
  language: 'en_US',
  category: 'UTILITY',
  status: 'APPROVED' as const,
  supported: true,
  unsupportedReason: null,
  headerText: null,
  bodyText: 'Hi {{1}}, your order {{2}} is ready for collection.',
  footerText: null,
  buttons: [],
  headerParameterCount: 0,
  bodyParameterCount: 2,
  syncedAt: new Date().toISOString(),
};

function integration(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'WHATSAPP',
    id: 'i-1',
    status: 'CONNECTED',
    enabled: true,
    displayName: 'Acme Sales',
    connectedAt: new Date().toISOString(),
    disconnectedAt: null,
    lastActivityAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    connectedBy: { id: 'u-1', fullName: 'Tony' },
    accessTokenHint: '1234',
    connectable: true,
    ...overrides,
  };
}

function mockApi(options: {
  integrations?: Record<string, unknown>[];
  templates?: { items: unknown[]; connected: boolean };
}): void {
  const integrations = options.integrations ?? [integration()];
  const templates = options.templates ?? { items: [TEMPLATE], connected: true };

  vi.spyOn(apiClient, 'apiGet').mockImplementation((path: string) => {
    if (path.includes('/templates')) return Promise.resolve(templates as never);
    if (path.includes('/channel-integrations')) return Promise.resolve(integrations as never);
    // Organization settings, for the shared-queue card that shares this page.
    return Promise.resolve({
      settings: { omnichannelEnabled: true, sharedUnassignedQueue: true },
    } as never);
  });
}

/** An owner, so the management actions are rendered at all. */
function mockOwner(): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: () => true,
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

describe('WhatsApp template settings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockOwner();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the loaded templates with what Meta said about them', async () => {
    mockApi({});
    renderPage();

    expect(await screen.findByText('order_ready')).toBeInTheDocument();
    expect(screen.getByText('APPROVED')).toBeInTheDocument();
    expect(screen.getByText('UTILITY')).toBeInTheDocument();
    expect(screen.getByText(/your order \{\{2\}\} is ready/i)).toBeInTheDocument();
  });

  it('shows a template Meta has not approved, rather than hiding it', async () => {
    // Hiding it would leave an owner wondering where their template went.
    mockApi({ templates: { items: [{ ...TEMPLATE, status: 'REJECTED' }], connected: true } });
    renderPage();

    expect(await screen.findByText('REJECTED')).toBeInTheDocument();
  });

  it('explains why an unsupported template cannot be used', async () => {
    mockApi({
      templates: {
        items: [
          {
            ...TEMPLATE,
            supported: false,
            unsupportedReason: 'This template has an image header, which LeadFlow cannot send.',
          },
        ],
        connected: true,
      },
    });
    renderPage();

    expect(await screen.findByText(/image header/i)).toBeInTheDocument();
  });

  it('says WhatsApp must be connected first, rather than showing an empty list', async () => {
    mockApi({ integrations: [integration({ status: 'NOT_CONNECTED', id: null })] });
    renderPage();

    expect(await screen.findByText(/connect whatsapp before loading templates/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh templates/i })).not.toBeInTheDocument();
  });

  it('does not offer to create a template, because LeadFlow cannot', async () => {
    mockApi({});
    renderPage();

    await screen.findByText('order_ready');
    expect(screen.queryByRole('button', { name: /create template/i })).not.toBeInTheDocument();
    expect(screen.getByText(/created and approved in Meta/i)).toBeInTheDocument();
  });

  describe('Refresh templates', () => {
    it('calls the sync endpoint and reports what was loaded', async () => {
      const user = userEvent.setup();
      const post = vi
        .spyOn(apiClient, 'apiPost')
        .mockResolvedValue({ total: 3, supported: 3, approved: 2 } as never);

      mockApi({});
      renderPage();

      await user.click(await screen.findByRole('button', { name: /refresh templates/i }));

      await waitFor(() =>
        expect(post).toHaveBeenCalledWith('/channel-integrations/whatsapp/templates/sync'),
      );
      expect(await screen.findByText(/loaded 3 templates, 2 ready to send/i)).toBeInTheDocument();
    });

    it('disables the button while the sync is in flight', async () => {
      const user = userEvent.setup();
      vi.spyOn(apiClient, 'apiPost').mockImplementation(
        () => new Promise(() => undefined) as never,
      );

      mockApi({});
      renderPage();

      const button = await screen.findByRole('button', { name: /refresh templates/i });
      await user.click(button);

      expect(await screen.findByRole('button', { name: /refreshing/i })).toBeDisabled();
    });

    it('shows an actionable failure without a provider body', async () => {
      const user = userEvent.setup();
      vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
        new apiClient.ApiError(
          'CONFLICT',
          'Add your WhatsApp Business Account ID in settings before loading templates.',
          409,
        ),
      );

      mockApi({});
      renderPage();

      await user.click(await screen.findByRole('button', { name: /refresh templates/i }));

      expect(await screen.findByText(/business account id/i)).toBeInTheDocument();
    });
  });
});
