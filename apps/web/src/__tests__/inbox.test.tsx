import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxPage } from '../features/omnichannel/inbox-page';
import { ChannelIntegrationsPage } from '../features/settings/channel-integrations-page';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';

/**
 * The unified inbox and channel management.
 *
 * The assertions that matter are again the restraining ones: the integrations
 * screen must not imply a connection exists, and must not offer a Connect
 * button that does nothing. An owner who believes their WhatsApp number is live
 * stops watching their phone.
 */

const LINKED = {
  id: 'conv-linked',
  channel: 'WHATSAPP' as const,
  linkState: 'LINKED' as const,
  potentialLead: false,
  potentialLeadSignals: [],
  archivedAt: null,
  lastMessageAt: new Date().toISOString(),
  contact: { id: 'c-1', name: 'Rahul Patil', mobile: '+14155552671', email: null, companyName: 'XYZ Foods' },
  companyName: 'XYZ Foods',
  owner: { id: 'u-1', fullName: 'Tony' },
  lead: { id: 'lead-1', leadNumber: 'LD-000042', status: 'NEGOTIATION' },
  lastMessagePreview: 'Please send the quotation.',
};

const UNOWNED = {
  ...LINKED,
  id: 'conv-unowned',
  channel: 'INSTAGRAM' as const,
  linkState: 'UNLINKED' as const,
  contact: null,
  companyName: null,
  owner: null,
  lead: null,
  lastMessagePreview: 'Please share wholesale pricing.',
};

function mockAuth(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
  } as never);
}

function renderWith(node: React.JSX.Element): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Unified inbox', () => {
  beforeEach(() => {
    mockAuth(['lead.view.own', 'lead.update']);
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
      if (url === '/conversations/inbox') {
        return Promise.resolve({
          items: [LINKED, UNOWNED],
          hasMore: false,
          nextCursor: null,
        } as never);
      }
      if (url === '/conversations/inbox/counts') {
        return Promise.resolve({ all: 2, mine: 1, unassigned: 1, review: 1 } as never);
      }
      return Promise.resolve({ items: [], hasMore: false, nextCursor: null } as never);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows conversations that already belong to a lead', async () => {
    renderWith(<InboxPage />);

    // The difference from the review queue: linked threads are part of the
    // inbox, because the inbox is the whole picture.
    expect(await screen.findByText('LD-000042')).toBeInTheDocument();
  });

  it('shows an unowned conversation as unassigned', async () => {
    renderWith(<InboxPage />);

    const row = (await screen.findByText('Unknown sender')).closest('button');
    expect(row).not.toBeNull();
    // Scoped to the row: "Unassigned" is also a filter tab, and asserting on
    // the tab would pass whether or not the row said anything at all.
    expect(within(row as HTMLElement).getByText('Unassigned')).toBeInTheDocument();
  });

  it('shows tab counts', async () => {
    renderWith(<InboxPage />);
    await screen.findByText('Unknown sender');

    const mine = screen.getByRole('tab', { name: /mine/i });
    expect(mine).toHaveTextContent('1');
  });

  it('filters to mine', async () => {
    const user = userEvent.setup();
    renderWith(<InboxPage />);

    await screen.findByText('Unknown sender');
    await user.click(screen.getByRole('tab', { name: /mine/i }));

    await waitFor(() => {
      expect(apiClient.apiGet).toHaveBeenCalledWith('/conversations/inbox', { filter: 'MINE' });
    });
  });

  it('filters by channel', async () => {
    const user = userEvent.setup();
    renderWith(<InboxPage />);

    await screen.findByText('Unknown sender');
    await user.selectOptions(screen.getByLabelText('Channel'), 'INSTAGRAM');

    await waitFor(() => {
      expect(apiClient.apiGet).toHaveBeenCalledWith('/conversations/inbox', {
        channel: 'INSTAGRAM',
      });
    });
  });

  it('shows archived only when asked', async () => {
    const user = userEvent.setup();
    renderWith(<InboxPage />);

    await screen.findByText('Unknown sender');
    await user.click(screen.getByLabelText(/archived/i));

    await waitFor(() => {
      expect(apiClient.apiGet).toHaveBeenCalledWith('/conversations/inbox', { archived: true });
    });
  });

  it('treats an empty inbox as ordinary, not an error', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue({
      items: [],
      hasMore: false,
      nextCursor: null,
    } as never);

    renderWith(<InboxPage />);
    expect(await screen.findByText('No conversations')).toBeInTheDocument();
  });
});

describe('Channel integrations', () => {
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
    connectable: false,
  };

  beforeEach(() => {
    mockAuth(['org.view', 'org.update']);
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
      if (url === '/channel-integrations') {
        return Promise.resolve([
          NOT_CONNECTED,
          { ...NOT_CONNECTED, channel: 'INSTAGRAM' },
          { ...NOT_CONNECTED, channel: 'FACEBOOK' },
        ] as never);
      }
      return Promise.resolve({
        settings: { sharedUnassignedQueue: false },
      } as never);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says plainly that provider connections are not available', async () => {
    renderWith(<ChannelIntegrationsPage />);

    // The single most important claim on this screen.
    expect(await screen.findByText(/not available yet/i)).toBeInTheDocument();
  });

  it('lists every supported channel', async () => {
    renderWith(<ChannelIntegrationsPage />);

    expect(await screen.findByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
    expect(screen.getByText('Facebook')).toBeInTheDocument();
  });

  it('disables Connect rather than opening a flow that goes nowhere', async () => {
    renderWith(<ChannelIntegrationsPage />);

    const connect = await screen.findAllByRole('button', { name: 'Connect' });
    for (const button of connect) {
      expect(button).toBeDisabled();
    }
  });

  it('shows no invented activity date for a channel that has never been used', async () => {
    renderWith(<ChannelIntegrationsPage />);

    await screen.findByText('WhatsApp');
    expect(screen.queryByText('Last message')).toBeNull();
    expect(screen.queryByText('Connected by')).toBeNull();
  });

  it('lets an administrator open the unassigned queue to the sales team', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'apiPatch').mockResolvedValue({} as never);

    renderWith(<ChannelIntegrationsPage />);

    const toggle = await screen.findByRole('checkbox', {
      name: /let every salesperson see unassigned conversations/i,
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => {
      expect(apiClient.apiPatch).toHaveBeenCalledWith('/organizations/current', {
        settings: { sharedUnassignedQueue: true },
      });
    });
  });

  it('does not let a viewer change the shared queue', async () => {
    mockAuth(['org.view']);
    renderWith(<ChannelIntegrationsPage />);

    const toggle = await screen.findByRole('checkbox', {
      name: /let every salesperson see unassigned conversations/i,
    });
    // The API enforces this too; disabling avoids offering an action that
    // would certainly fail.
    expect(toggle).toBeDisabled();
  });
});
