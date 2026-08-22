import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationDrawer } from '../features/omnichannel/conversation-drawer';
import * as apiClient from '../lib/api-client';

/**
 * Replying from the conversation drawer.
 *
 * The claims worth testing are the honest ones: a composer appears only where
 * the server says replying is possible, a message is never shown as sent before
 * it has been, and a retry of the same message reuses its key so a customer
 * cannot receive it twice.
 */

const BASE = {
  id: 'conv-1',
  channel: 'WHATSAPP' as const,
  status: 'OPEN',
  linkState: 'LINKED' as const,
  potentialLead: false,
  potentialLeadSignals: [],
  archivedAt: null,
  archivedReason: null,
  lastMessageAt: new Date().toISOString(),
  companyName: 'XYZ Foods',
  contact: {
    id: 'c-1',
    firstName: 'Rahul',
    lastName: 'Patil',
    mobile: '+447700900123',
    email: null,
    companyName: 'XYZ Foods',
  },
  owner: { id: 'u-1', fullName: 'Tony' },
  lead: { id: 'lead-1', leadNumber: 'LD-000042', status: 'NEGOTIATION' },
  integration: { id: 'i-1', displayName: 'Acme', status: 'CONNECTED' },
  candidateLeads: [],
  messages: [
    {
      id: 'm-1',
      direction: 'INCOMING' as const,
      senderType: 'CONTACT' as const,
      messageType: 'TEXT',
      content: 'Do you have stock?',
      attachments: null,
      sentAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
  ],
};

function mockConversation(overrides: Record<string, unknown>): void {
  vi.spyOn(apiClient, 'apiGet').mockResolvedValue({ ...BASE, ...overrides } as never);
}

function renderDrawer(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConversationDrawer conversationId="conv-1" onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Conversation composer', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'fixed-key' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('when the server says replying is possible', () => {
    beforeEach(() => {
      mockConversation({
        canSend: true,
        windowExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    });

    it('shows a composer', async () => {
      renderDrawer();
      expect(await screen.findByLabelText('Reply')).toBeInTheDocument();
    });

    it('says when the free-reply window closes', async () => {
      renderDrawer();
      expect(await screen.findByText(/allows free replies until/i)).toBeInTheDocument();
    });

    it('sends the typed message with an idempotency key', async () => {
      const user = userEvent.setup();
      vi.spyOn(apiClient, 'apiPost').mockResolvedValue({ id: 'm-2' } as never);

      renderDrawer();
      await user.type(await screen.findByLabelText('Reply'), 'Yes, we do.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => {
        expect(apiClient.apiPost).toHaveBeenCalledWith('/conversations/conv-1/messages', {
          content: 'Yes, we do.',
          idempotencyKey: 'fixed-key',
        });
      });
    });

    it('will not send an empty message', async () => {
      renderDrawer();
      await screen.findByLabelText('Reply');

      // Nothing typed: the button is not an invitation to send whitespace.
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    });

    it('disables the button while a send is in flight', async () => {
      const user = userEvent.setup();
      let resolve: (value: unknown) => void = () => {};
      vi.spyOn(apiClient, 'apiPost').mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }) as never,
      );

      renderDrawer();
      await user.type(await screen.findByLabelText('Reply'), 'One');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      // The first line of defence against a double click. The server's
      // idempotency key is the one that actually holds.
      expect(await screen.findByRole('button', { name: /sending/i })).toBeDisabled();
      resolve({ id: 'm-2' });
    });

    it('reports a failure instead of pretending the customer received it', async () => {
      const user = userEvent.setup();
      vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
        new apiClient.ApiError('CONFLICT', 'WhatsApp refused the message.', 409),
      );

      renderDrawer();
      await user.type(await screen.findByLabelText('Reply'), 'will fail');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/refused the message/i);
      // The text stays in the box so it is not lost.
      expect(screen.getByLabelText('Reply')).toHaveValue('will fail');
    });
  });

  describe('when the server says replying is not possible', () => {
    it('shows no composer at all', async () => {
      mockConversation({
        canSend: false,
        sendDisabledReason: 'More than 24 hours have passed since the customer last wrote.',
      });

      renderDrawer();

      expect(await screen.findByText(/more than 24 hours/i)).toBeInTheDocument();
      // Not a disabled box — a disabled box still suggests replying happens
      // here, and the reason explains that it does not.
      expect(screen.queryByLabelText('Reply')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    });

    it('falls back to a plain sentence when no reason was given', async () => {
      mockConversation({ canSend: false });

      renderDrawer();
      expect(await screen.findByText(/not available for this conversation/i)).toBeInTheDocument();
    });
  });

  describe('outbound message state', () => {
    it.each([
      ['PENDING', /sending/i],
      ['SENT', /sent/i],
      ['DELIVERED', /delivered/i],
      ['READ', /read/i],
    ])('shows %s', async (deliveryStatus, expected) => {
      mockConversation({
        canSend: true,
        messages: [
          {
            ...BASE.messages[0],
            id: 'm-out',
            direction: 'OUTGOING',
            senderType: 'AGENT',
            content: 'Yes, we do.',
            deliveryStatus,
          },
        ],
      });

      renderDrawer();
      expect(await screen.findByText(expected)).toBeInTheDocument();
    });

    it('distinguishes an unconfirmed message from a failed one', async () => {
      mockConversation({
        canSend: true,
        messages: [
          {
            ...BASE.messages[0],
            id: 'm-out',
            direction: 'OUTGOING',
            senderType: 'AGENT',
            content: 'Thanks for your enquiry.',
            deliveryStatus: 'UNCONFIRMED',
            failureReason:
              'Delivery could not be confirmed, and the message was not resent automatically.',
          },
        ],
      });

      renderDrawer();

      // The customer may well have received it. Saying "not delivered" here
      // would have a salesperson send it again.
      expect(await screen.findByText(/delivery not confirmed/i)).toBeInTheDocument();
      expect(screen.queryByText(/^Not delivered$/)).toBeNull();
      expect(screen.getByText(/not resent automatically/i)).toBeInTheDocument();
    });

    it('never leaves a recovered message reading as still sending', async () => {
      mockConversation({
        canSend: true,
        messages: [
          {
            ...BASE.messages[0],
            id: 'm-out',
            direction: 'OUTGOING',
            senderType: 'AGENT',
            content: 'Thanks.',
            deliveryStatus: 'UNCONFIRMED',
          },
        ],
      });

      renderDrawer();

      await screen.findByText(/delivery not confirmed/i);
      expect(screen.queryByText(/sending/i)).toBeNull();
    });

    it('shows why a message was not delivered', async () => {
      mockConversation({
        canSend: true,
        messages: [
          {
            ...BASE.messages[0],
            id: 'm-out',
            direction: 'OUTGOING',
            senderType: 'AGENT',
            content: 'Yes, we do.',
            deliveryStatus: 'FAILED',
            failureReason: 'WhatsApp could not deliver this message.',
          },
        ],
      });

      renderDrawer();

      // Regex, because the label renders after a separator in the same line.
      expect(await screen.findByText(/not delivered/i)).toBeInTheDocument();
      expect(screen.getByText(/could not deliver/i)).toBeInTheDocument();
    });
  });
});
