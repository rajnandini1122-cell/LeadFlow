import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailboxView } from '@leadflow/api-types';

import { EmailSettingsPage } from '../features/email/email-settings-page';
import { UnsubscribePage } from '../features/email/unsubscribe-page';
import * as apiClient from '../lib/api-client';

/**
 * Email account settings show exactly what a mail client shows — and never the
 * password. Unsubscribing needs no account, and opening the page changes nothing.
 */

const mailbox = (over: Partial<MailboxView> = {}): MailboxView => ({
  configured: true,
  emailAddress: 'sales@cravionventures.com',
  description: null,
  username: 'sales@cravionventures.com',
  imapHost: 'mail.cravionventures.com',
  imapPort: 993,
  imapSecurity: 'SSL_TLS',
  smtpHost: 'mail.cravionventures.com',
  smtpPort: 465,
  smtpSecurity: 'SSL_TLS',
  passwordSet: true,
  passwordUpdatedAt: '2026-11-11T10:00:00.000Z',
  enabled: false,
  hourlyLimit: 50,
  dailyLimit: 300,
  smtp: { checkedAt: null, okAt: null, error: null },
  imap: { checkedAt: null, okAt: null, error: null },
  sync: { at: null, error: null, count: null },
  platform: { sendingEnabled: false, dispatcherEnabled: false },
  ...over,
});

function renderAt(path: string, element: React.ReactElement, route: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('Email account settings', () => {
  it('shows the account like a mail client: address, description, IMAP and SMTP host, port and secure type', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue(mailbox() as never);
    renderAt('/settings/email', <EmailSettingsPage />, '/settings/email');

    expect(await screen.findByText('Account details')).toBeInTheDocument();
    expect(screen.getByText('IMAP configuration')).toBeInTheDocument();
    expect(screen.getByText('SMTP configuration')).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveValue('sales@cravionventures.com');
    expect(screen.getByLabelText('Account description')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Hostname').map((i) => (i as HTMLInputElement).value)).toEqual([
      'mail.cravionventures.com',
      'mail.cravionventures.com',
    ]);
    expect(screen.getAllByLabelText('Port').map((i) => (i as HTMLInputElement).value)).toEqual([
      '993',
      '465',
    ]);
    expect(
      screen.getAllByLabelText('Secure connection type').map((i) => (i as HTMLSelectElement).value),
    ).toEqual(['SSL_TLS', 'SSL_TLS']);
    // The password field is empty: a saved password is never shown again.
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('switching the secure type sets the matching port', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue(mailbox() as never);
    renderAt('/settings/email', <EmailSettingsPage />, '/settings/email');
    const [, smtpSecurity] = await screen.findAllByLabelText('Secure connection type');
    await userEvent.selectOptions(smtpSecurity!, 'STARTTLS');
    expect(screen.getAllByLabelText('Port').map((i) => (i as HTMLInputElement).value)).toEqual([
      '993',
      '587',
    ]);
  });

  it('cannot be switched on until both connections have been tested', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue(mailbox() as never);
    renderAt('/settings/email', <EmailSettingsPage />, '/settings/email');
    expect(await screen.findByLabelText('Use this account for campaigns')).toBeDisabled();
    expect(screen.getByText(/not enabled on this LeadFlow server yet/)).toBeInTheDocument();
  });
});

describe('HostingRaja preset', () => {
  it('fills mail.<domain>, IMAP 993 and SMTP 465 with SSL/TLS from the email address', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue(
      mailbox({
        configured: false,
        emailAddress: null,
        imapHost: null,
        smtpHost: null,
        imapPort: null,
        smtpPort: null,
        imapSecurity: null,
        smtpSecurity: null,
        passwordSet: false,
      }) as never,
    );
    renderAt('/settings/email', <EmailSettingsPage />, '/settings/email');
    await userEvent.type(
      await screen.findByLabelText('Email address'),
      'sales@cravionventures.com',
    );
    await userEvent.selectOptions(screen.getByLabelText('Mail provider'), 'hostingraja');
    expect(screen.getAllByLabelText('Hostname').map((i) => (i as HTMLInputElement).value)).toEqual([
      'mail.cravionventures.com',
      'mail.cravionventures.com',
    ]);
    expect(screen.getAllByLabelText('Port').map((i) => (i as HTMLInputElement).value)).toEqual([
      '993',
      '465',
    ]);
    expect(
      screen.getAllByLabelText('Secure connection type').map((i) => (i as HTMLSelectElement).value),
    ).toEqual(['SSL_TLS', 'SSL_TLS']);
  });
});

describe('Unsubscribe page', () => {
  it('opening the link changes nothing; the button unsubscribes', async () => {
    const get = vi
      .spyOn(apiClient, 'apiGet')
      .mockResolvedValue({ organizationName: 'CRAVION', alreadyUnsubscribed: false } as never);
    const post = vi
      .spyOn(apiClient, 'apiPost')
      .mockResolvedValue({ organizationName: 'CRAVION', alreadyUnsubscribed: true } as never);
    renderAt('/unsubscribe/abc', <UnsubscribePage />, '/unsubscribe/:token');

    expect(await screen.findByText(/Stop receiving marketing emails from/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/email/unsubscribe/abc');
    expect(post).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    await waitFor(() => expect(screen.getByText('You are unsubscribed')).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith('/email/unsubscribe/abc');
  });
});
