import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelReviewPage } from '../features/omnichannel/channel-review-page';
import { LeadConversationsCard } from '../features/omnichannel/lead-conversations-card';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';

/**
 * Channel lead review.
 *
 * The claims worth testing are the restraining ones: the screen must not offer
 * to send a message it cannot send, must not hide the fact that dismissing is
 * reversible, and must not present a lead as chosen when the system explicitly
 * refused to choose one.
 */

const UNKNOWN_SENDER = {
  id: 'conv-1',
  channel: 'WHATSAPP' as const,
  linkState: 'UNLINKED' as const,
  potentialLead: true,
  potentialLeadSignals: ['pricing', 'kg'],
  archivedAt: null,
  lastMessageAt: new Date().toISOString(),
  contact: null,
  companyName: null,
  owner: null,
  lead: null,
  lastMessagePreview: 'Need pricing for 500kg onion powder.',
};

const AMBIGUOUS = {
  id: 'conv-2',
  channel: 'INSTAGRAM' as const,
  linkState: 'REVIEW_REQUIRED' as const,
  potentialLead: false,
  potentialLeadSignals: [],
  archivedAt: null,
  lastMessageAt: new Date().toISOString(),
  contact: { id: 'c-1', name: 'Rahul Patil', mobile: '+14155552671', email: null, companyName: 'XYZ Foods' },
  companyName: 'XYZ Foods',
  owner: { id: 'u-1', fullName: 'Tony' },
  lead: null,
  lastMessagePreview: 'Please send wholesale pricing.',
};

function mockAuth(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
  } as never);
}

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ChannelReviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Channel lead review', () => {
  beforeEach(() => {
    mockAuth(['lead.view.own', 'lead.update']);
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
      if (url === '/conversations/review') {
        return Promise.resolve({ items: [UNKNOWN_SENDER, AMBIGUOUS], total: 2 } as never);
      }
      return Promise.resolve({ items: [], total: 0 } as never);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists conversations waiting on a decision', async () => {
    renderPage();

    expect(await screen.findByText(/Need pricing for 500kg/)).toBeInTheDocument();
    expect(screen.getByText('Rahul Patil', { exact: false })).toBeInTheDocument();
  });

  it('names an unidentified sender rather than inventing one', async () => {
    renderPage();

    // The system could not identify them, and the screen says so instead of
    // showing a blank or a guessed name.
    expect(await screen.findByText('Unknown sender')).toBeInTheDocument();
  });

  it('marks a buying enquiry as a potential lead', async () => {
    renderPage();
    expect(await screen.findByText('Potential lead')).toBeInTheDocument();
  });

  it('says plainly when several leads matched', async () => {
    renderPage();

    // Never "linked to XYZ Foods" — the system declined to choose, and the
    // screen must not imply otherwise.
    expect(await screen.findByText('Review required')).toBeInTheDocument();
  });

  it('offers create, link and dismiss for someone who may edit leads', async () => {
    renderPage();

    expect(await screen.findAllByRole('button', { name: /create lead/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /link existing lead/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /not a lead/i })).toHaveLength(2);
  });

  it('hides every action from someone who may only view', async () => {
    mockAuth(['lead.view.own']);
    renderPage();

    await screen.findByText('Unknown sender');
    // The API enforces this too; hiding it avoids offering an action that
    // would certainly fail.
    expect(screen.queryByRole('button', { name: /create lead/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /not a lead/i })).toBeNull();
  });

  it('filters to one category', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Unknown sender');
    await user.click(screen.getByRole('tab', { name: /potential leads/i }));

    await waitFor(() => {
      expect(apiClient.apiGet).toHaveBeenCalledWith('/conversations/review', {
        category: 'POTENTIAL_LEAD',
      });
    });
  });

  it('dismisses a conversation without claiming to delete it', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({ archived: true } as never);

    renderPage();

    const dismissButtons = await screen.findAllByRole('button', { name: /not a lead/i });
    await user.click(dismissButtons[0] as HTMLElement);

    await waitFor(() => {
      expect(apiClient.apiPost).toHaveBeenCalledWith('/conversations/conv-1/archive', {});
    });

    // The wording matters: nothing was destroyed, and the user should know.
    expect(await screen.findByText(/still stored/i)).toBeInTheDocument();
  });

  it('shows an empty queue as good news, not an error', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue({ items: [], total: 0 } as never);
    renderPage();

    expect(await screen.findByText('Nothing waiting')).toBeInTheDocument();
  });
});

describe('Conversations on a lead', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderCard(): void {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LeadConversationsCard leadId="lead-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('renders nothing for a lead with no conversations', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([] as never);
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <MemoryRouter>
          <LeadConversationsCard leadId="lead-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Every lead predates this feature. An empty panel on all of them would be
    // permanent furniture advertising something unused.
    await waitFor(() => {
      expect(container.querySelector('h2')).toBeNull();
    });
  });

  it('lists linked conversations', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([
      {
        id: 'conv-9',
        channel: 'WHATSAPP',
        ownerId: 'u-1',
        lastMessageAt: new Date().toISOString(),
        status: 'OPEN',
        contact: { id: 'c-1', firstName: 'Rahul', lastName: 'Patil', mobile: '+14155552671' },
        messages: [{ id: 'm-1', content: 'Please send the quotation.', createdAt: new Date().toISOString() }],
      },
    ] as never);

    renderCard();

    // findBy, not getBy: the card renders a skeleton under the same heading
    // while the query is in flight, so waiting on the heading proves nothing.
    expect(await screen.findByText(/Please send the quotation/)).toBeInTheDocument();
    expect(screen.getByText('Conversations')).toBeInTheDocument();
    expect(screen.getByText('Rahul Patil')).toBeInTheDocument();
  });
});
