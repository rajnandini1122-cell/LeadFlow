import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CampaignEditorPage } from '../features/email/campaign-editor-page';
import * as apiClient from '../lib/api-client';
import { ApiError } from '../lib/api-client';

/**
 * The one test-email control on an existing draft: a "Send test to" address
 * (your own, until you change it) and one button that names it. It is enabled
 * exactly when the server would accept a test send, and submits only that
 * address — never the campaign recipient list. A Resend account must
 * not be held back by SMTP (which Railway blocks); nothing is sent by these tests.
 */

const ME = 'owner@cravion.example';

vi.mock('../features/auth/auth-context', () => ({
  useAuth: () => ({ can: () => true, user: { email: 'owner@cravion.example' } }),
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

/** The server's TEST checklist (GET /email/campaigns/c1/readiness?intent=TEST). */
function ready(
  checks: { id: string; status: 'pass' | 'warn' | 'fail'; title: string; detail?: string }[] = [],
) {
  const all = [
    { id: 'SENDING_AVAILABLE', status: 'pass' as const, title: 'Email sending is available' },
    ...checks,
  ];
  return {
    intent: 'TEST',
    channel: 'RESEND_BROADCAST',
    ok: all.every((c) => c.status !== 'fail'),
    checks: all,
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
        : url === '/email/campaigns/c1/readiness'
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

const button = () => screen.findByRole('button', { name: `Send test to ${ME}` });
const field_ = () => screen.findByLabelText('Send test to');
const testCalls = (post: ReturnType<typeof open>) =>
  post.mock.calls.filter(([url]) => String(url).endsWith('/test'));

describe('Test email readiness — the server checklist decides', () => {
  it('checklist ok: the test button is enabled and nothing is listed', async () => {
    const post = open(ready());
    expect(await button()).toBeEnabled();
    expect(screen.queryByLabelText('Why test emails are unavailable')).not.toBeInTheDocument();
    // Rendering never sends anything.
    expect(testCalls(post)).toEqual([]);
  });

  it('a failing check: disabled, and the reason is shown in plain words', async () => {
    open(ready([{ id: 'ACCOUNT_TESTED', status: 'fail', title: 'Test the Resend connection' }]));
    expect(await button()).toBeDisabled();
    const why = await screen.findByLabelText('Why test emails are unavailable');
    expect(why).toHaveTextContent('Test the Resend connection');
    expect(why).not.toHaveTextContent('Email sending is available');
  });

  it('a warning (the real campaign needs changes): still enabled, the warning is shown', async () => {
    open(
      ready([
        {
          id: 'MESSAGE_FITS',
          status: 'warn',
          title: 'The test can be sent, but the real campaign needs changes',
          detail: 'Broadcasts cannot carry attachments. Link to the catalogue instead.',
        },
      ]),
    );
    expect(await button()).toBeEnabled();
    expect(await screen.findByLabelText('Test email notes')).toHaveTextContent(
      'Broadcasts cannot carry attachments',
    );
  });

  it('asks the server for the TEST checklist of this campaign', async () => {
    open(ready());
    await button();
    expect(apiClient.apiGet).toHaveBeenCalledWith('/email/campaigns/c1/readiness', {
      intent: 'TEST',
    });
  });
});

describe('One test control', () => {
  it('there is exactly one test field and one test button, prefilled with your own address', async () => {
    open(ready());
    expect(await button()).toBeEnabled();
    expect(screen.getByLabelText('Send test to')).toHaveValue(ME);
    expect(screen.getAllByRole('button', { name: /^Send test/ })).toHaveLength(1);
    expect(screen.queryByText('Send me a test email')).not.toBeInTheDocument();
    expect(screen.queryByText(/another approved email/)).not.toBeInTheDocument();
  });

  it('your own address goes as a self test: no recipient is posted', async () => {
    const post = open(ready());
    await userEvent.click(await button());
    expect(testCalls(post)).toEqual([['/email/campaigns/c1/test', {}]]);
  });

  it('your own address in other casing is still a self test', async () => {
    const post = open(ready());
    const field = await field_();
    await userEvent.clear(field);
    await userEvent.type(field, ME.toUpperCase());
    await userEvent.click(screen.getByRole('button', { name: `Send test to ${ME}` }));
    expect(testCalls(post)).toEqual([['/email/campaigns/c1/test', {}]]);
  });

  it('another address: the button names it and posts exactly it (trimmed, lowercased), never yours', async () => {
    const post = open(ready());
    const field = await field_();
    await userEvent.clear(field);
    expect(screen.getByRole('button', { name: 'Send test' })).toBeDisabled();
    await userEvent.type(field, 'not-an-email');
    expect(screen.getByRole('button', { name: 'Send test' })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, ' Rajnandini1122@Gmail.com ');
    const send = screen.getByRole('button', { name: 'Send test to rajnandini1122@gmail.com' });
    expect(send).toBeEnabled();
    await userEvent.click(send);
    expect(testCalls(post)).toEqual([
      ['/email/campaigns/c1/test', { to: 'rajnandini1122@gmail.com' }],
    ]);
    expect(JSON.stringify(testCalls(post))).not.toContain(ME);
  });

  it('never posts the campaign recipients, and says so on both cards', async () => {
    const post = open(ready());
    expect(await screen.findByText(/never to the campaign’s recipients/)).toBeInTheDocument();
    expect(screen.getByText(/Test emails never go to them/)).toBeInTheDocument();
    await userEvent.click(await button());
    // The draft's own recipient list (buyer@cust.example) is never part of a test.
    expect(JSON.stringify(testCalls(post))).not.toContain('buyer@cust.example');
  });

  it('shows the server refusal naming the address; it never falls back to your own', async () => {
    const post = open(ready());
    post.mockImplementation(((url: string) =>
      String(url).endsWith('/test')
        ? Promise.reject(
            new ApiError(
              'VALIDATION_ERROR' as never,
              'stranger@elsewhere.example is not approved for test emails on this server. Only addresses an administrator has approved can receive them — ask for this one to be approved, or send the test to yourself.',
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
    const field = await field_();
    await userEvent.clear(field);
    await userEvent.type(field, 'stranger@elsewhere.example');
    await userEvent.click(
      screen.getByRole('button', { name: 'Send test to stranger@elsewhere.example' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'stranger@elsewhere.example is not approved for test emails',
    );
    expect(testCalls(post)).toEqual([
      ['/email/campaigns/c1/test', { to: 'stranger@elsewhere.example' }],
    ]);
  });

  it('never shows which addresses are approved', async () => {
    open(ready());
    const section = (await screen.findByRole('heading', { name: 'Test email' })).closest(
      'section',
    )!;
    // The only address on the card is your own, in the field and on the button.
    expect(within(section).queryByText(/@/, { ignore: 'button' })).not.toBeInTheDocument();
  });
});
