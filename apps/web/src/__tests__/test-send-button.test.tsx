import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CampaignEditorPage } from '../features/email/campaign-editor-page';
import * as apiClient from '../lib/api-client';
import { ApiError } from '../lib/api-client';

/**
 * "Send me a test email" on an existing draft: enabled exactly when the server
 * would accept a test send. A Resend account must not be held back by SMTP
 * (which Railway blocks); nothing is sent by these tests.
 */

vi.mock('../features/auth/auth-context', () => ({
  useAuth: () => ({ can: () => true }),
}));

afterEach(() => vi.restoreAllMocks());

const OK = '2026-11-12T13:25:28.000Z';

const draft = {
  id: 'c1',
  name: 'Catalogue',
  category: 'PRODUCT_CATALOGUE',
  purpose: 'PROMOTIONAL',
  status: 'DRAFT',
  subject: 'Our catalogue',
  html: '<p>Hello</p>',
  text: 'Hello',
  assetIds: [],
  filter: { source: 'CUSTOM', customEmails: ['buyer@cust.example'] },
  scheduledAt: null,
  confirmedAt: null,
  startedAt: null,
  pausedAt: null,
  pauseReason: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: OK,
  updatedAt: OK,
  counts: {},
  broadcast: null,
};

function mailbox(over: Record<string, unknown> = {}) {
  return {
    configured: true,
    sendingProvider: 'RESEND',
    smtp: { checkedAt: OK, okAt: null, error: 'The connection timed out.' },
    imap: { checkedAt: OK, okAt: OK, error: null },
    provider: { checkedAt: OK, okAt: OK, error: null },
    resend: { domainVerifiedAt: OK },
    platform: { sendingEnabled: true, dispatcherEnabled: true },
    ...over,
  };
}

function open(mb: unknown) {
  const post = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
    selected: 1,
    eligible: 0,
    excluded: { INVALID: 0, SUPPRESSED: 0, NO_CONSENT: 1, DUPLICATE: 0, EXCLUDED: 0 },
    sample: [],
    recipients: [],
    recipientsTruncated: false,
    recipientsListed: true,
    recipientsTotal: 1,
    undisplayedEligible: 0,
  } as never);
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) =>
    Promise.resolve(
      (url === '/email/campaigns/c1'
        ? draft
        : url === '/email/mailbox'
          ? mb
          : url === '/email/campaigns/c1/preview'
            ? { subject: draft.subject, html: draft.html, text: draft.text, attachments: [] }
            : url === '/email/campaigns/audience/options'
              ? { cities: [], contacted: { never: 0, contacted: 0 } }
              : []) as never,
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/campaigns/c1/edit']}>
        <Routes>
          <Route path="/campaigns/:id/edit" element={<CampaignEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return post;
}

const button = () => screen.findByRole('button', { name: 'Send me a test email' });

describe('Send me a test email', () => {
  it('Resend tested + domain verified + switches on: ENABLED although SMTP timed out', async () => {
    const post = open(mailbox());
    expect(await button()).toBeEnabled();
    expect(screen.queryByLabelText('Why test emails are unavailable')).not.toBeInTheDocument();
    // Rendering never sends anything.
    expect(post.mock.calls.some(([url]) => String(url).endsWith('/test'))).toBe(false);
  });

  it('switches off: disabled, and says sending is switched off on this server', async () => {
    open(mailbox({ platform: { sendingEnabled: false, dispatcherEnabled: false } }));
    expect(await button()).toBeDisabled();
    expect(
      await screen.findByText(
        'Test emails are switched off on this server until email sending is enabled.',
      ),
    ).toBeInTheDocument();
  });

  it('Resend not tested: disabled, asks for the Resend test — not SMTP', async () => {
    open(mailbox({ provider: { checkedAt: OK, okAt: null, error: 'bad key' } }));
    expect(await button()).toBeDisabled();
    expect(
      await screen.findByText('Test the Resend connection in Email settings.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Connect and test the email account first/)).not.toBeInTheDocument();
  });

  it('Resend domain unverified: disabled with that reason', async () => {
    open(mailbox({ resend: { domainVerifiedAt: null } }));
    expect(await button()).toBeDisabled();
    expect(
      await screen.findByText('Verify the sending domain in Resend, then test Resend again.'),
    ).toBeInTheDocument();
  });

  it('SMTP account with SMTP tested: enabled', async () => {
    open(
      mailbox({
        sendingProvider: 'SMTP',
        smtp: { checkedAt: OK, okAt: OK, error: null },
        provider: { checkedAt: null, okAt: null, error: null },
        resend: { domainVerifiedAt: null },
      }),
    );
    expect(await button()).toBeEnabled();
  });

  it('"Send me a test email" posts no recipient — the server sends to the signed-in user', async () => {
    const post = open(mailbox());
    await userEvent.click(await button());
    const call = post.mock.calls.find(([url]) => String(url).endsWith('/test'));
    expect(call).toEqual(['/email/campaigns/c1/test', {}]);
  });

  describe('Send test to another approved email', () => {
    const openOther = async () => {
      await userEvent.click(await screen.findByText('Send test to another approved email'));
      return {
        input: screen.getByLabelText('Email address'),
        send: screen.getByRole('button', { name: 'Send test to this address' }),
      };
    };

    it('needs a valid address, then posts exactly that address (trimmed, lowercased)', async () => {
      const post = open(mailbox());
      const { input, send } = await openOther();
      expect(send).toBeDisabled();
      await userEvent.type(input, 'not-an-email');
      expect(send).toBeDisabled();
      await userEvent.clear(input);
      await userEvent.type(input, ' Rajnandini1122@Gmail.com ');
      expect(send).toBeEnabled();
      await userEvent.click(send);
      const calls = post.mock.calls.filter(([url]) => String(url).endsWith('/test'));
      expect(calls).toEqual([['/email/campaigns/c1/test', { to: 'rajnandini1122@gmail.com' }]]);
    });

    it('shows the server refusal; it never falls back to your own address', async () => {
      const post = open(mailbox());
      post.mockImplementation(((url: string) =>
        String(url).endsWith('/test')
          ? Promise.reject(
              new ApiError(
                'VALIDATION_ERROR' as never,
                'This address is not approved for test emails on this server. Only approved internal addresses can receive them.',
                400,
              ),
            )
          : Promise.resolve({
              selected: 0,
              eligible: 0,
              excluded: {},
              sample: [],
              recipients: [],
              recipientsTruncated: false,
              recipientsListed: true,
              recipientsTotal: 0,
              undisplayedEligible: 0,
            })) as never);
      const { input, send } = await openOther();
      await userEvent.type(input, 'stranger@elsewhere.example');
      await userEvent.click(send);
      expect(await screen.findByRole('alert')).toHaveTextContent('not approved for test emails');
      const calls = post.mock.calls.filter(([url]) => String(url).endsWith('/test'));
      expect(calls).toEqual([['/email/campaigns/c1/test', { to: 'stranger@elsewhere.example' }]]);
    });

    it('is unavailable whenever "Send me a test email" is (switches off)', async () => {
      open(mailbox({ platform: { sendingEnabled: false, dispatcherEnabled: false } }));
      const { input, send } = await openOther();
      await userEvent.type(input, 'rajnandini1122@gmail.com');
      expect(send).toBeDisabled();
    });

    it('never shows which addresses are approved', async () => {
      open(mailbox());
      await openOther();
      const card = screen.getByText('Send test to another approved email').closest('details')!;
      expect(within(card).queryByText(/@/)).not.toBeInTheDocument();
    });
  });

  it('SMTP account with SMTP not tested: disabled, asks for the SMTP test', async () => {
    open(
      mailbox({ sendingProvider: 'SMTP', provider: { checkedAt: null, okAt: null, error: null } }),
    );
    expect(await button()).toBeDisabled();
    expect(
      await screen.findByText('Test the SMTP (sending) connection in Email settings.'),
    ).toBeInTheDocument();
  });
});
