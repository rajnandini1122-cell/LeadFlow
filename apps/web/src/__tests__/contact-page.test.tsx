import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContactPage } from '../features/marketing/contact-page';
import { ApiError } from '../lib/api-client';
import * as apiClient from '../lib/api-client';

/**
 * The public enquiry form.
 *
 * The cases that matter: a genuine enquiry reaches the API in the right shape,
 * the visitor is told what happened, and the honeypot is genuinely unreachable
 * by anyone using a keyboard or a screen reader — a trap that catches real
 * customers is worse than no trap.
 */
function renderContact(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ContactPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/your name/i), 'Dana Whitfield');
  await user.type(screen.getByLabelText(/work email/i), 'dana@kestrel.example');
  await user.type(
    screen.getByLabelText(/how can we help/i),
    'We are a team of six and keep losing enquiries. Can we see a demo?',
  );
}

describe('Contact page', () => {
  beforeEach(() => {
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      reference: 'A1B2C3D4',
      salesEmail: 'sales@cravionventures.com',
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the sales address for people who prefer email', () => {
    renderContact();

    const links = screen.getAllByRole('link', { name: /sales@cravionventures\.com/i });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute('href', 'mailto:sales@cravionventures.com');
  });

  it('sends the enquiry in the shape the API expects', async () => {
    const user = userEvent.setup();
    renderContact();

    await fillRequired(user);
    await user.type(screen.getByLabelText(/company/i), 'Kestrel Interiors');
    await user.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      expect(apiClient.apiPost).toHaveBeenCalledWith('/contact', {
        name: 'Dana Whitfield',
        email: 'dana@kestrel.example',
        company: 'Kestrel Interiors',
        message: 'We are a team of six and keep losing enquiries. Can we see a demo?',
        source: 'contact',
      });
    });
  });

  it('omits optional fields rather than sending empty strings', async () => {
    const user = userEvent.setup();
    renderContact();

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      const body = vi.mocked(apiClient.apiPost).mock.calls[0]?.[1] as Record<string, unknown>;
      expect(body).not.toHaveProperty('company');
      expect(body).not.toHaveProperty('phone');
      // The honeypot is only sent when something filled it.
      expect(body).not.toHaveProperty('website');
    });
  });

  it('NEVER sends a destination address', async () => {
    const user = userEvent.setup();
    renderContact();

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      const body = vi.mocked(apiClient.apiPost).mock.calls[0]?.[1] as Record<string, unknown>;
      // The server takes the recipient from configuration. Sending one from
      // here would make the endpoint an open relay.
      for (const field of ['to', 'recipient', 'salesEmail', 'notifyEmail']) {
        expect(body).not.toHaveProperty(field);
      }
    });
  });

  it('confirms receipt with a reference and a reply address', async () => {
    const user = userEvent.setup();
    renderContact();

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /send message/i }));

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('A1B2C3D4');
    expect(confirmation).toHaveTextContent(/sales@cravionventures\.com/);
    expect(screen.queryByRole('button', { name: /send message/i })).toBeNull();
  });

  it('surfaces a field error from the API', async () => {
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Invalid enquiry.', 400, {
        message: ['please tell us a little more'],
      }),
    );

    const user = userEvent.setup();
    renderContact();

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /send message/i }));

    expect(await screen.findByText(/please tell us a little more/i)).toBeInTheDocument();
  });

  it('tells a rate-limited visitor how to reach us anyway', async () => {
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
      new ApiError('RATE_LIMITED', 'Too many requests', 429),
    );

    const user = userEvent.setup();
    renderContact();

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /send message/i }));

    // A dead end here loses a customer who was actively trying to reach us.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/sales@cravionventures\.com/);
  });

  it('keeps the honeypot out of reach of real people', () => {
    renderContact();

    const honeypot = screen.getByLabelText(/website \(leave this blank\)/i, {
      selector: 'input',
    });

    // A trap that catches real customers is worse than no trap: it must be
    // out of the tab order and hidden from assistive technology.
    expect(honeypot).toHaveAttribute('tabIndex', '-1');
    expect(honeypot.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(honeypot).toHaveValue('');
  });

  it('marks required fields for screen readers, not just with an asterisk', () => {
    renderContact();

    expect(screen.getByLabelText(/your name/i)).toBeRequired();
    expect(screen.getByLabelText(/work email/i)).toBeRequired();
    expect(screen.getByLabelText(/how can we help/i)).toBeRequired();
  });
});
