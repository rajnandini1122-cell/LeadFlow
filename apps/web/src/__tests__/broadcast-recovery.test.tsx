import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmailBroadcastView, EmailCampaignView } from '@leadflow/api-types';

import { BroadcastRecoveryPanel } from '../features/email/broadcast-recovery-panel';
import * as apiClient from '../lib/api-client';

/**
 * The NEEDS_REVIEW recovery panel: it explains what is known, asks for an
 * explicit, reasoned confirmation, and sends exactly one decision carrying the
 * version it was shown — the server decides whether a retry is safe.
 */

const broadcast = (over: Partial<EmailBroadcastView> = {}): EmailBroadcastView => ({
  state: 'NEEDS_REVIEW',
  stateAt: '2026-11-11T10:05:00.000Z',
  version: 7,
  error: 'Needs review: Resend still shows this broadcast as a draft after the send was requested.',
  providerBroadcastId: 'b_123',
  sendRequestedAt: '2026-11-11T10:00:00.000Z',
  lastCheckedAt: '2026-11-11T10:05:00.000Z',
  lastProviderStatus: 'draft',
  exposure: 'MAY_HAVE_BEEN_SENT',
  needsReview: true,
  reviews: [],
  ...over,
});

function renderPanel(b: EmailBroadcastView, canDecide = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (view: EmailBroadcastView) => (
    <QueryClientProvider client={client}>
      <BroadcastRecoveryPanel campaignId="c_1" broadcast={view} canDecide={canDecide} />
    </QueryClientProvider>
  );
  const result = render(ui(b));
  return { rerender: (view: EmailBroadcastView) => result.rerender(ui(view)) };
}

afterEach(() => vi.restoreAllMocks());

describe('Broadcast recovery panel', () => {
  it('shows the state, last check with Resend, the reason, the Resend id and whether anyone may have it', () => {
    renderPanel(broadcast());
    expect(screen.getByText('This broadcast needs a decision.')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText(/Resend said “draft”/)).toBeInTheDocument();
    expect(screen.getByText('b_123')).toBeInTheDocument();
    expect(screen.getByText(/still shows this broadcast as a draft/)).toBeInTheDocument();
    expect(screen.getByTestId('broadcast-exposure')).toHaveTextContent(
      'may already have received it',
    );
  });

  it('offers no decision to someone who is not an administrator', () => {
    renderPanel(broadcast(), false);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /abandon/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Only an organisation administrator/)).toBeInTheDocument();
  });

  it('retry asks for confirmation with the real consequences and a reason, then sends ONE decision with the version shown', async () => {
    let finish: (v: EmailCampaignView) => void = () => {};
    const post = vi
      .spyOn(apiClient, 'apiPost')
      .mockImplementation(() => new Promise((resolve) => (finish = resolve as never)));
    const user = userEvent.setup();
    renderPanel(broadcast());

    await user.click(screen.getByRole('button', { name: 'Recheck & retry if safe' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('it is NOT sent again');
    expect(dialog).toHaveTextContent('request the send — once');
    expect(dialog).toHaveTextContent('If Resend’s status cannot be read, nothing changes');
    const confirm = screen.getByRole('button', { name: 'Confirm: recheck and retry if safe' });
    expect(confirm).toBeDisabled(); // no reason yet

    await user.type(screen.getByRole('textbox'), 'Checked Resend: still a draft');
    await user.click(confirm);
    // Repeated clicks while the server is answering send nothing more.
    await user.click(screen.getByRole('button', { name: 'Checking with Resend…' }));
    await user.click(screen.getByRole('button', { name: 'Checking with Resend…' }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/email/campaigns/c_1/broadcast/resolve', {
      action: 'retry',
      reason: 'Checked Resend: still a draft',
      expectedVersion: 7,
    });
    finish({ id: 'c_1' } as EmailCampaignView);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('abandon explains that recipients may be marked unknown when Resend cannot be read', async () => {
    const user = userEvent.setup();
    renderPanel(broadcast());
    await user.click(screen.getByRole('button', { name: 'Abandon campaign' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('sent emails cannot be recalled');
    expect(dialog).toHaveTextContent('cannot be resumed or sent');
    expect(dialog).toHaveTextContent('marked “Unknown outcome”');
  });

  it('a page that changed while the dialog was open cannot be confirmed', async () => {
    const post = vi.spyOn(apiClient, 'apiPost');
    const user = userEvent.setup();
    const { rerender } = renderPanel(broadcast());
    await user.click(screen.getByRole('button', { name: 'Abandon campaign' }));
    await user.type(screen.getByRole('textbox'), 'Offer withdrawn');
    // Another administrator acted; the 10-second refresh brings a new version.
    rerender(broadcast({ version: 9 }));
    expect(screen.getByText(/changed while the dialog was open/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm: abandon campaign' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("shows the server's refusal instead of pretending it worked", async () => {
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
      new apiClient.ApiError(
        'CONFLICT',
        "Resend's status for this broadcast cannot be read right now. Retrying is not safe without it; nothing was changed.",
        409,
      ),
    );
    const user = userEvent.setup();
    renderPanel(broadcast());
    await user.click(screen.getByRole('button', { name: 'Recheck & retry if safe' }));
    await user.type(screen.getByRole('textbox'), 'Try again');
    await user.click(screen.getByRole('button', { name: 'Confirm: recheck and retry if safe' }));
    expect(await screen.findByText(/Retrying is not safe without it/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('lists every decision with who, when, why and the state before and after', () => {
    renderPanel(
      broadcast({
        needsReview: false,
        state: 'DRAFT_CREATED',
        reviews: [
          {
            id: 'r1',
            actorUserId: 'u1',
            actorName: 'Asha Rao',
            action: 'retry',
            reason: 'Checked Resend',
            outcome: 'retrying',
            refusal: null,
            previousState: 'NEEDS_REVIEW',
            previousStatus: 'PAUSED',
            resultingState: 'DRAFT_CREATED',
            resultingStatus: 'SENDING',
            providerStatus: 'draft',
            recipientsClosed: 0,
            createdAt: '2026-11-11T10:10:00.000Z',
          },
        ],
      }),
    );
    expect(screen.getByText(/Asha Rao/)).toBeInTheDocument();
    expect(screen.getByText('“Checked Resend”')).toBeInTheDocument();
    expect(
      screen.getByText(/NEEDS_REVIEW \(paused\) → DRAFT_CREATED \(sending\)/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
