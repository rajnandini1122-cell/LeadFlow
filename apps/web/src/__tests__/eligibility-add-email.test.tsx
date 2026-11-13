import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EligibilityPage } from '../features/email/eligibility-page';
import * as apiClient from '../lib/api-client';

/**
 * "Add email" on Marketing eligibility: any address, recorded by hand. Nothing
 * is pre-chosen — eligible needs a basis, the date and how permission was
 * given; "not eligible" records the address without authorizing anything.
 */

let canManage = true;
vi.mock('../features/auth/auth-context', () => ({
  useAuth: () => ({ can: () => canManage }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  canManage = true;
});

function open() {
  vi.spyOn(apiClient, 'apiGet').mockResolvedValue([] as never);
  const post = vi
    .spyOn(apiClient, 'apiPost')
    .mockImplementation(((url: string, body: { emails: string[] }) =>
      Promise.resolve(
        url.endsWith('/grant') ? { granted: body.emails, refused: [] } : { withdrawn: 1 },
      )) as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EligibilityPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return post;
}

const startAdding = async (email: string) => {
  await userEvent.click(await screen.findByRole('button', { name: 'Add email' }));
  await userEvent.type(screen.getByLabelText('Email address'), email);
};
const writes = (post: ReturnType<typeof open>) =>
  post.mock.calls.filter(([url]) => String(url).includes('/email/eligibility/'));

describe('Marketing eligibility — Add email', () => {
  it('nothing is pre-chosen: an address alone cannot be saved, so it is never eligible by default', async () => {
    const post = open();
    await startAdding('rajnandini1122@gmail.com');
    expect(screen.getByRole('radio', { name: /^Eligible/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /^Not eligible/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save as eligible' })).toBeDisabled();
    expect(writes(post)).toEqual([]);
  });

  it('eligible needs a basis, the date and how it was given, then records exactly that address with the evidence', async () => {
    const post = open();
    await startAdding(' Rajnandini1122@Gmail.com ');
    await userEvent.click(screen.getByRole('radio', { name: /^Eligible/ }));
    const save = screen.getByRole('button', { name: 'Save as eligible' });
    expect(save).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Basis'), 'CONSENT');
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Date permission was given'), '2026-11-13');
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('How it was given (source)'), 'email reply');
    await userEvent.type(screen.getByLabelText('Notes (optional)'), 'asked for the catalogue');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(writes(post)).toEqual([
      [
        '/email/eligibility/grant',
        {
          emails: ['rajnandini1122@gmail.com'],
          basis: 'CONSENT',
          note: 'Given 2026-11-13 via email reply — asked for the catalogue',
        },
      ],
    ]);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'rajnandini1122@gmail.com marked eligible.',
    );
  });

  it('a future date is not accepted', async () => {
    open();
    await startAdding('a@inbox.example');
    await userEvent.click(screen.getByRole('radio', { name: /^Eligible/ }));
    await userEvent.selectOptions(screen.getByLabelText('Basis'), 'CONSENT');
    await userEvent.type(screen.getByLabelText('Date permission was given'), '2999-01-01');
    await userEvent.type(screen.getByLabelText('How it was given (source)'), 'email reply');
    expect(screen.getByRole('button', { name: 'Save as eligible' })).toBeDisabled();
  });

  it('"not eligible" records the address without granting anything', async () => {
    const post = open();
    await startAdding('someone@inbox.example');
    await userEvent.click(screen.getByRole('radio', { name: /^Not eligible/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save as not eligible' }));
    expect(writes(post)).toEqual([
      [
        '/email/eligibility/withdraw',
        { emails: ['someone@inbox.example'], note: 'Permission not established' },
      ],
    ]);
    expect(post.mock.calls.some(([url]) => String(url).endsWith('/grant'))).toBe(false);
  });

  it('an invalid address cannot be saved', async () => {
    const post = open();
    await startAdding('not-an-email');
    await userEvent.click(screen.getByRole('radio', { name: /^Not eligible/ }));
    expect(screen.getByRole('button', { name: 'Save as not eligible' })).toBeDisabled();
    expect(writes(post)).toEqual([]);
  });

  it('people without the consent permission do not see "Add email"', async () => {
    canManage = false;
    open();
    expect(await screen.findByText('Marketing eligibility')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add email' })).not.toBeInTheDocument();
  });
});

describe('Marketing eligibility — reason for selected rows', () => {
  it('says why "Mark eligible" is disabled until the reason has 5 characters', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([
      {
        email: 'shvbhosale@gmail.com',
        name: 'Shivaji Bhosale',
        company: null,
        sources: ['LEAD'],
        status: 'UNKNOWN',
        basis: null,
        source: null,
        note: null,
        recordedAt: null,
        suppressed: null,
      },
    ] as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <EligibilityPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByLabelText('Select shvbhosale@gmail.com'));
    await userEvent.type(screen.getByLabelText('How was this obtained?'), 'bbb');
    expect(screen.getByText(/at least 5 characters/)).toHaveTextContent('(3/5)');
    expect(screen.getByRole('button', { name: 'Mark 1 eligible' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('How was this obtained?'), ' ok');
    expect(screen.queryByText(/at least 5 characters/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark 1 eligible' })).toBeEnabled();
  });
});
