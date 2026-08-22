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
      attachments: [],
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

  describe('channel awareness', () => {
    it.each([
      ['WHATSAPP', 'WhatsApp', 4096],
      ['INSTAGRAM', 'Instagram', 1000],
      ['FACEBOOK', 'Facebook', 2000],
    ])('names %s in the composer and uses its own limit', async (channel, label, maxTextLength) => {
      mockConversation({ channel, canSend: true, maxTextLength });
      renderDrawer();

      const box = await screen.findByLabelText('Reply');
      // The salesperson must know which channel they are about to answer on.
      expect(box).toHaveAttribute('placeholder', expect.stringContaining(label));
      // Meta's limits genuinely differ; one number for all three would let the
      // composer accept a body the provider then rejects.
      expect(box).toHaveAttribute('maxlength', String(maxTextLength));
    });

    it('warns only as the limit approaches', async () => {
      const user = userEvent.setup();
      mockConversation({ channel: 'INSTAGRAM', canSend: true, maxTextLength: 1000 });
      renderDrawer();

      const box = await screen.findByLabelText('Reply');
      expect(screen.queryByText(/characters left/i)).toBeNull();

      await user.type(box, 'x'.repeat(60));
      // Still quiet — a counter on every message is noise.
      expect(screen.queryByText(/characters left/i)).toBeNull();
    });

    it('names the channel in the free-reply window notice', async () => {
      mockConversation({
        channel: 'FACEBOOK',
        canSend: true,
        maxTextLength: 2000,
        windowExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

      renderDrawer();
      expect(await screen.findByText(/Facebook.*allows free replies until/i)).toBeInTheDocument();
    });
  });

  describe('attachments', () => {
    beforeEach(() => {
      mockConversation({ canSend: true, maxTextLength: 4096 });
    });

    function pick(name = 'quote.jpg', type = 'image/jpeg'): File {
      return new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], name, { type });
    }

    it('shows the chosen file before it is sent', async () => {
      const user = userEvent.setup();
      renderDrawer();

      await user.upload(await screen.findByLabelText(/attach a file/i), pick());

      expect(screen.getByText('quote.jpg')).toBeInTheDocument();
    });

    it('lets the file be removed again', async () => {
      const user = userEvent.setup();
      renderDrawer();

      await user.upload(await screen.findByLabelText(/attach a file/i), pick());
      await user.click(screen.getByRole('button', { name: /remove quote\.jpg/i }));

      expect(screen.queryByText('quote.jpg')).toBeNull();
    });

    it('enables Send for a file with no text', async () => {
      const user = userEvent.setup();
      renderDrawer();

      // A photo on its own is a complete message.
      expect(await screen.findByRole('button', { name: 'Send' })).toBeDisabled();
      await user.upload(screen.getByLabelText(/attach a file/i), pick());
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });

    it('sends the file as multipart, with the same idempotency key', async () => {
      const user = userEvent.setup();
      vi.spyOn(apiClient, 'apiPost').mockResolvedValue({ id: 'm-2' } as never);

      renderDrawer();
      await user.upload(await screen.findByLabelText(/attach a file/i), pick());
      await user.type(screen.getByLabelText('Reply'), 'Here it is.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => {
        expect(apiClient.apiPost).toHaveBeenCalledWith(
          '/conversations/conv-1/messages',
          expect.any(FormData),
        );
      });

      const form = vi.mocked(apiClient.apiPost).mock.calls[0]?.[1] as FormData;
      expect(form.get('idempotencyKey')).toBe('fixed-key');
      expect(form.get('content')).toBe('Here it is.');
      expect((form.get('file') as File).name).toBe('quote.jpg');
    });

    it('still sends plain JSON when there is no file', async () => {
      const user = userEvent.setup();
      vi.spyOn(apiClient, 'apiPost').mockResolvedValue({ id: 'm-2' } as never);

      renderDrawer();
      await user.type(await screen.findByLabelText('Reply'), 'Text only.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => {
        // The existing path is byte-for-byte what it was before media existed.
        expect(apiClient.apiPost).toHaveBeenCalledWith('/conversations/conv-1/messages', {
          content: 'Text only.',
          idempotencyKey: 'fixed-key',
        });
      });
    });

    it('reports a rejected file instead of pretending it was sent', async () => {
      const user = userEvent.setup();
      vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
        new apiClient.ApiError('VALIDATION_ERROR', 'That file type cannot be sent.', 400),
      );

      renderDrawer();
      await user.upload(await screen.findByLabelText(/attach a file/i), pick('bad.exe'));
      await user.click(screen.getByRole('button', { name: 'Send' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be sent/i);
      // The file stays selected so it is not silently lost.
      expect(screen.getByText('bad.exe')).toBeInTheDocument();
    });
  });

  describe('rendering received attachments', () => {
    function withAttachment(attachment: Record<string, unknown>): void {
      mockConversation({
        canSend: true,
        messages: [
          {
            ...BASE.messages[0],
            id: 'm-att',
            content: null,
            messageType: 'IMAGE',
            attachments: [{ index: 0, mimeType: null, filename: null, sizeBytes: null, retrievable: true, ...attachment }],
          },
        ],
      });
    }

    it('renders an image through our own authenticated endpoint', async () => {
      withAttachment({ type: 'IMAGE', filename: 'photo.jpg' });
      renderDrawer();

      const image = await screen.findByAltText('photo.jpg');
      // Never a provider link — those are capability URLs that also expire.
      expect(image).toHaveAttribute(
        'src',
        '/api/v1/conversations/conv-1/messages/m-att/attachments/0',
      );
    });

    it('offers a download for a document rather than a fake preview', async () => {
      withAttachment({ type: 'DOCUMENT', filename: 'purchase-order.pdf' });
      renderDrawer();

      const link = await screen.findByRole('link', { name: /purchase-order\.pdf/i });
      expect(link).toHaveAttribute(
        'href',
        '/api/v1/conversations/conv-1/messages/m-att/attachments/0',
      );
    });

    it.each(['VIDEO', 'AUDIO', 'OTHER'])(
      'offers a download for %s rather than a player it may not decode',
      async (type) => {
        withAttachment({ type });
        renderDrawer();

        // Named by its type, and scoped — the drawer header also has a link to
        // the linked lead, so a bare role query would match that instead.
        const link = await screen.findByRole('link', {
          name: new RegExp(`${type.toLowerCase()} attachment`, 'i'),
        });
        expect(link).toHaveAttribute(
          'href',
          '/api/v1/conversations/conv-1/messages/m-att/attachments/0',
        );
      },
    );

    it('says so when an attachment can no longer be fetched', async () => {
      withAttachment({ type: 'IMAGE', retrievable: false, filename: 'gone.jpg' });
      renderDrawer();

      // Honest about it rather than a broken image icon.
      expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
      // No link and no image FOR THE ATTACHMENT. The lead link in the header
      // is a different thing entirely.
      expect(screen.queryByRole('link', { name: /gone\.jpg/i })).toBeNull();
      expect(screen.queryByRole('img')).toBeNull();
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
