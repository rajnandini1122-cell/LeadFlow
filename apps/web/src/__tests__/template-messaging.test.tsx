import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationDrawer } from '../features/omnichannel/conversation-drawer';
import * as apiClient from '../lib/api-client';

/**
 * Sending an approved WhatsApp template from the conversation drawer.
 *
 * The claims worth defending here are the separations:
 *
 *   - a template is offered only where the SERVER says one can be sent;
 *   - a closed 24-hour window hides the free-form composer and still offers a
 *     template, which is the entire feature;
 *   - typed text is never converted into a template, and no template is ever
 *     sent without somebody choosing it;
 *   - nothing appears as sent before the API has accepted it.
 */

const CONVERSATION = {
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

/** The window has closed: free-form refused, template allowed. */
const WINDOW_CLOSED = {
  canSend: false,
  sendDisabledReason:
    'More than 24 hours have passed since the customer last wrote. Send an approved WhatsApp template to reopen the conversation.',
  canSendTemplate: true,
};

const TEMPLATE = {
  name: 'order_ready',
  language: 'en_US',
  category: 'UTILITY',
  status: 'APPROVED' as const,
  supported: true,
  unsupportedReason: null,
  headerText: null,
  bodyText: 'Hi {{1}}, your order {{2}} is ready for collection.',
  footerText: 'Reply STOP to opt out',
  buttons: [],
  headerParameterCount: 0,
  bodyParameterCount: 2,
  syncedAt: new Date().toISOString(),
};

/** Routes each GET by path, so the drawer and the picker can both be served. */
function mockApi(
  conversation: Record<string, unknown>,
  templates: { items: unknown[]; connected: boolean } = { items: [TEMPLATE], connected: true },
): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((path: string) => {
    if (path.includes('/templates')) return Promise.resolve(templates as never);
    return Promise.resolve({ ...CONVERSATION, ...conversation } as never);
  });
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

const openPicker = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.click(await screen.findByRole('button', { name: /send a template/i }));
};

describe('WhatsApp template messaging', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('when the template option appears', () => {
    it('offers a template when the server says one can be sent', async () => {
      mockApi(WINDOW_CLOSED);
      renderDrawer();

      expect(await screen.findByRole('button', { name: /send a template/i })).toBeInTheDocument();
    });

    it('does not offer one when the server says it cannot', async () => {
      // Instagram, no approved templates, a disconnected channel — the client
      // never works out which. It reads one answer.
      mockApi({ canSend: true, canSendTemplate: false });
      renderDrawer();

      await screen.findByPlaceholderText(/reply on whatsapp/i);
      expect(screen.queryByRole('button', { name: /send a template/i })).not.toBeInTheDocument();
    });

    it('does not offer one when the server said nothing about templates', async () => {
      // An older response, or a channel that never reports the field. Absence
      // must not read as permission.
      mockApi({ canSend: true });
      renderDrawer();

      await screen.findByPlaceholderText(/reply on whatsapp/i);
      expect(screen.queryByRole('button', { name: /send a template/i })).not.toBeInTheDocument();
    });
  });

  describe('the 24-hour window', () => {
    it('hides the composer and still offers a template once it has closed', async () => {
      /*
       * The central case. If the composer reappears here the free-form rule has
       * been weakened; if the template button disappears there is no way out of
       * a closed conversation.
       */
      mockApi(WINDOW_CLOSED);
      renderDrawer();

      expect(await screen.findByRole('button', { name: /send a template/i })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/reply on whatsapp/i)).not.toBeInTheDocument();
      expect(screen.getByText(/more than 24 hours/i)).toBeInTheDocument();
    });

    it('keeps the ordinary composer as the default inside the window', async () => {
      mockApi({ canSend: true, canSendTemplate: true });
      renderDrawer();

      // Both are available; the composer is not replaced by the picker.
      expect(await screen.findByPlaceholderText(/reply on whatsapp/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /send a template/i })).toBeInTheDocument();
    });
  });

  describe('the picker', () => {
    it('lists the approved templates it loaded', async () => {
      const user = userEvent.setup();
      mockApi(WINDOW_CLOSED);
      renderDrawer();
      await openPicker(user);

      expect(await screen.findByRole('combobox', { name: /template/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /order_ready/i })).toBeInTheDocument();
    });

    it('does not offer a template that is not approved', async () => {
      const user = userEvent.setup();
      mockApi(WINDOW_CLOSED, {
        items: [{ ...TEMPLATE, status: 'PENDING' }],
        connected: true,
      });
      renderDrawer();
      await openPicker(user);

      // Meta would refuse it. Offering it would be offering a certain failure.
      expect(await screen.findByText(/no approved templates are available/i)).toBeInTheDocument();
    });

    it('does not offer a template LeadFlow cannot render', async () => {
      const user = userEvent.setup();
      mockApi(WINDOW_CLOSED, {
        items: [
          {
            ...TEMPLATE,
            supported: false,
            unsupportedReason: 'This template has an image header, which LeadFlow cannot send.',
          },
        ],
        connected: true,
      });
      renderDrawer();
      await openPicker(user);

      expect(await screen.findByText(/no approved templates are available/i)).toBeInTheDocument();
    });

    it('shows a preview with the placeholders still visible', async () => {
      const user = userEvent.setup();
      mockApi(WINDOW_CLOSED);
      renderDrawer();
      await openPicker(user);

      await user.selectOptions(
        await screen.findByRole('combobox', { name: /template/i }),
        'order_ready:en_US',
      );

      // An unfilled blank is obvious rather than silently disappearing.
      expect(screen.getByText(/your order \{\{2\}\} is ready/i)).toBeInTheDocument();
    });

    it('asks for one input per placeholder', async () => {
      const user = userEvent.setup();
      mockApi(WINDOW_CLOSED);
      renderDrawer();
      await openPicker(user);

      await user.selectOptions(
        await screen.findByRole('combobox', { name: /template/i }),
        'order_ready:en_US',
      );

      expect(screen.getByLabelText('Value 1')).toBeInTheDocument();
      expect(screen.getByLabelText('Value 2')).toBeInTheDocument();
    });

    it('can be cancelled without sending anything', async () => {
      const user = userEvent.setup();
      const post = vi.spyOn(apiClient, 'apiPost');
      mockApi(WINDOW_CLOSED);
      renderDrawer();
      await openPicker(user);

      await user.click(await screen.findByRole('button', { name: /cancel/i }));

      expect(await screen.findByRole('button', { name: /send a template/i })).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('sending', () => {
    async function pickTemplate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await openPicker(user);
      await user.selectOptions(
        await screen.findByRole('combobox', { name: /template/i }),
        'order_ready:en_US',
      );
    }

    it('refuses to send with a blank value', async () => {
      const user = userEvent.setup();
      const post = vi.spyOn(apiClient, 'apiPost');
      mockApi(WINDOW_CLOSED);
      renderDrawer();
      await pickTemplate(user);

      await user.type(screen.getByLabelText('Value 1'), 'Rahul');
      // Value 2 left empty. Sending would put a literal {{2}} on a phone.
      await user.click(screen.getByRole('button', { name: /^send template$/i }));

      expect(await screen.findByText(/fill in every value/i)).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
    });

    it('posts the chosen template and its values', async () => {
      const user = userEvent.setup();
      const post = vi
        .spyOn(apiClient, 'apiPost')
        .mockResolvedValue({ id: 'm-2', messageType: 'TEMPLATE' } as never);

      mockApi(WINDOW_CLOSED);
      renderDrawer();
      await pickTemplate(user);

      await user.type(screen.getByLabelText('Value 1'), 'Rahul');
      await user.type(screen.getByLabelText('Value 2'), 'A-1024');
      await user.click(screen.getByRole('button', { name: /^send template$/i }));

      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

      const [path, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
      // Its own endpoint, never the free-form one.
      expect(path).toBe('/conversations/conv-1/template-messages');
      expect(payload).toMatchObject({
        templateName: 'order_ready',
        language: 'en_US',
        bodyParameters: ['Rahul', 'A-1024'],
      });
      // The same guarantee the composer relies on.
      expect(typeof payload['idempotencyKey']).toBe('string');
    });

    it('does not send twice when the button is clicked twice', async () => {
      const user = userEvent.setup();
      // A request still in flight: the second click must find the button
      // disabled, because a duplicate here is a second message to a customer.
      const post = vi
        .spyOn(apiClient, 'apiPost')
        .mockImplementation(() => new Promise(() => undefined) as never);

      mockApi(WINDOW_CLOSED);
      renderDrawer();
      await pickTemplate(user);

      await user.type(screen.getByLabelText('Value 1'), 'Rahul');
      await user.type(screen.getByLabelText('Value 2'), 'A-1024');

      const button = screen.getByRole('button', { name: /^send template$/i });
      await user.click(button);
      await waitFor(() => expect(button).toBeDisabled());
      await user.click(button);

      expect(post).toHaveBeenCalledTimes(1);
    });

    it('shows the failure and does not resend', async () => {
      const user = userEvent.setup();
      const post = vi
        .spyOn(apiClient, 'apiPost')
        .mockRejectedValue(
          new apiClient.ApiError(
            'CONFLICT',
            'WhatsApp refused this template. It may no longer be approved.',
            409,
          ),
        );

      mockApi(WINDOW_CLOSED);
      renderDrawer();
      await pickTemplate(user);

      await user.type(screen.getByLabelText('Value 1'), 'Rahul');
      await user.type(screen.getByLabelText('Value 2'), 'A-1024');
      await user.click(screen.getByRole('button', { name: /^send template$/i }));

      expect(await screen.findByText(/no longer be approved/i)).toBeInTheDocument();
      // Nothing retries on its own. A resend is a person's decision.
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe('the conversation history', () => {
    it('marks a template message as one', async () => {
      mockApi({
        ...WINDOW_CLOSED,
        messages: [
          ...CONVERSATION.messages,
          {
            id: 'm-2',
            direction: 'OUTGOING' as const,
            senderType: 'AGENT' as const,
            messageType: 'TEMPLATE',
            // The rendered text: what the customer actually received.
            content: 'Hi Rahul, your order A-1024 is ready for collection.',
            attachments: [],
            deliveryStatus: 'SENT' as const,
            failureReason: null,
            sentAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
      });
      renderDrawer();

      expect(await screen.findByText('Template')).toBeInTheDocument();
      expect(
        screen.getByText('Hi Rahul, your order A-1024 is ready for collection.'),
      ).toBeInTheDocument();
    });

    it('does not mark an ordinary text message as a template', async () => {
      mockApi({ canSend: true });
      renderDrawer();

      await screen.findByText('Do you have stock?');
      expect(screen.queryByText('Template')).not.toBeInTheDocument();
    });
  });
});
