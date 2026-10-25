import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../lib/api-client';
import { ToastProvider } from '../components/toast';
import { LeadCustomerCard, duplicatesFrom } from '../features/leads/lead-customer-card';
import type { LeadDetail } from '../features/leads/use-leads';

/**
 * New lead → Won → Customer, finished from the lead page: a won deal with no
 * customer is linked to one (or the customer is created, duplicate-checked).
 */

const LEAD = {
  id: '01a00000-0000-7000-8000-0000000000c1',
  name: 'Kavya Iyer',
  companyName: 'Iyer Spices',
  status: 'WON',
  account: null,
} as unknown as LeadDetail;

const wrap = (lead: LeadDetail, canLink = true) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <LeadCustomerCard lead={lead} canLink={canLink} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('Customer on the lead page', () => {
  it('shows the linked customer with its status', () => {
    wrap({ ...LEAD, account: { id: 'a1', name: 'Iyer Spices Pvt Ltd', status: 'CUSTOMER' } } as LeadDetail);
    expect(screen.getByRole('link', { name: 'Iyer Spices Pvt Ltd' })).toHaveAttribute('href', '/customers/a1');
    expect(screen.getByText('Customer', { selector: 'span' })).toBeInTheDocument();
  });

  it('flags a won deal that is not linked, and offers the matching customer', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue({ companyName: 'Iyer Spices', accounts: [{ id: 'a1', name: 'Iyer Spices Pvt Ltd', status: 'PROSPECT' }] } as never);
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({ leadsUpdated: 1, contactsUpdated: 0, requested: 1 } as never);
    wrap(LEAD);

    expect(screen.getByText(/This deal is won/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Link to Iyer Spices Pvt Ltd' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/accounts/mapping/assign', { accountId: 'a1', leadIds: [LEAD.id] }));
    expect(await screen.findByText('Linked to Iyer Spices Pvt Ltd.')).toBeInTheDocument();
  });

  it('creates the customer from the company name, then links it', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue({ companyName: 'Iyer Spices', accounts: [] } as never);
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockImplementation((url: string) =>
      Promise.resolve((url === '/accounts' ? { account: { id: 'new', name: 'Iyer Spices' } } : { leadsUpdated: 1 }) as never),
    );
    wrap(LEAD);

    await userEvent.click(await screen.findByRole('button', { name: 'Create customer “Iyer Spices”' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/accounts/mapping/assign', { accountId: 'new', leadIds: [LEAD.id] }));
    expect(apiPost).toHaveBeenCalledWith('/accounts', { name: 'Iyer Spices' });
  });

  it('on a duplicate, offers the existing customer — and "different company" creates anyway', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue({ companyName: 'Iyer Spices', accounts: [] } as never);
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockImplementation((url: string, body?: unknown) => {
      if (url === '/accounts' && !(body as { force?: boolean }).force) {
        return Promise.reject(
          new apiClient.ApiError('DUPLICATE_ACCOUNT' as never, 'exists', 409, {
            duplicateAccountIds: ['a9'],
            duplicateAccountNames: ['IYER SPICES'],
          }),
        );
      }
      return Promise.resolve((url === '/accounts' ? { account: { id: 'n2', name: 'Iyer Spices' } } : { leadsUpdated: 1 }) as never);
    });
    wrap(LEAD);

    await userEvent.click(await screen.findByRole('button', { name: 'Create customer “Iyer Spices”' }));
    expect(await screen.findByRole('button', { name: 'Link to IYER SPICES' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /different company/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/accounts', { name: 'Iyer Spices', force: true }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/accounts/mapping/assign', { accountId: 'n2', leadIds: [LEAD.id] }));
  });

  it('without permission shows the state but no actions', () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue({ companyName: null, accounts: [] } as never);
    wrap(LEAD, false);
    expect(screen.getByText('Not linked to a customer yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('reads duplicate candidates from the error details', () => {
    const error = new apiClient.ApiError('DUPLICATE_ACCOUNT' as never, 'x', 409, { duplicateAccountIds: ['1', '2'], duplicateAccountNames: ['A', 'B'] });
    expect(duplicatesFrom(error)).toEqual([{ id: '1', name: 'A' }, { id: '2', name: 'B' }]);
    expect(duplicatesFrom(new Error('x'))).toBeNull();
  });
});
