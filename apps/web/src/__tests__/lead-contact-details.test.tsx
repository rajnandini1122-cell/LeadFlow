import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ADDITIONAL_CONTACTS } from '@leadflow/api-types';

import { LeadDetailPage } from '../features/leads/lead-detail-page';
import { ApiError } from '../lib/api-client';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';
import type { LeadDetail } from '../features/leads/use-leads';

/**
 * Address and additional contacts on screen.
 *
 * The defect (production, 2026-10-30): the Edit form had no street address, no
 * second phone or email, and opened with Email / City / Product interest BLANK
 * even when the lead had them — so a salesperson could neither see what was
 * stored nor clear it, and typed everything into "City" and "Product interest".
 */

const LEAD: LeadDetail = {
  id: '01a00000-0000-7000-8000-000000000077',
  leadNumber: 'LD-00077',
  name: 'Pallavi Rasal',
  companyName: 'Pallavi Spices and Foods',
  mobile: '+919823064636',
  email: 'sales@pallavisspices.com',
  status: 'NEW',
  priority: 'HIGH',
  estimatedValue: null,
  nextFollowUpAt: '2026-11-20T09:00:00.000Z',
  assignedTo: { id: 'user-1', fullName: 'Asha Rep' },
  createdAt: '2026-10-01T09:00:00.000Z',
  deactivatedAt: null,
  activities: [],
  addressLine1: 'Survey No. 68, Jambhulwadi–Kolewadi Road',
  addressLine2: 'Jambhulwadi',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411046',
  country: 'IN',
  additionalPhones: ['+912029512009', '+919823055636'],
  additionalEmails: ['pallavisspices@yahoo.com'],
  productInterest: 'Turmeric',
  deactivationReason: null,
  deactivatedBy: null,
  importBatchId: null,
  market: 'DOMESTIC',
  lastOutcome: null,
  lastOutcomeAt: null,
  lastContactedAt: null,
  latestActivity: null,
  nextAction: null,
};

function stubApi(lead: LeadDetail): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
    if (url.startsWith('/leads/') && url.includes('/activities')) {
      return Promise.resolve({ items: [], hasMore: false } as never);
    }
    if (url.startsWith('/leads/') && (url.includes('/follow-ups') || url.includes('/attachments'))) {
      return Promise.resolve([] as never);
    }
    if (url.startsWith('/leads/')) return Promise.resolve(lead as never);
    return Promise.resolve([] as never);
  });
}

function renderDetail(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      })}
    >
      <MemoryRouter initialEntries={[`/leads/${LEAD.id}`]}>
        <Routes>
          <Route path="/leads/:id" element={<LeadDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openEdit(lead: LeadDetail = LEAD): Promise<HTMLElement> {
  stubApi(lead);
  renderDetail();
  await userEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
  return screen.getByRole('dialog');
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: () => true,
    user: { id: 'user-1', fullName: 'Asha Rep' },
  } as never);
});

describe('the lead page', () => {
  it('shows additional phones and emails as tappable links', async () => {
    stubApi(LEAD);
    renderDetail();

    const landline = await screen.findByRole('link', { name: '+912029512009' });
    expect(landline).toHaveAttribute('href', 'tel:+912029512009');
    expect(screen.getByRole('link', { name: 'pallavisspices@yahoo.com' })).toHaveAttribute(
      'href',
      'mailto:pallavisspices@yahoo.com',
    );
    expect(
      screen.getByText('Survey No. 68, Jambhulwadi–Kolewadi Road, Jambhulwadi, Pune, Maharashtra, 411046, IN'),
    ).toBeInTheDocument();
  });
});

describe('Edit lead', () => {
  it('opens with EVERYTHING the lead holds, not blanks', async () => {
    const dialog = await openEdit();
    const q = within(dialog);

    expect(q.getByLabelText('Email')).toHaveValue('sales@pallavisspices.com');
    expect(q.getByLabelText('Address line 1')).toHaveValue('Survey No. 68, Jambhulwadi–Kolewadi Road');
    expect(q.getByLabelText('Address line 2')).toHaveValue('Jambhulwadi');
    expect(q.getByLabelText('City')).toHaveValue('Pune');
    expect(q.getByLabelText('State')).toHaveValue('Maharashtra');
    expect(q.getByLabelText('PIN code')).toHaveValue('411046');
    expect(q.getByLabelText('Product interest')).toHaveValue('Turmeric');
    expect(q.getByLabelText('Additional phones 1')).toHaveValue('+912029512009');
    expect(q.getByLabelText('Additional phones 2')).toHaveValue('+919823055636');
    expect(q.getByLabelText('Additional emails 1')).toHaveValue('pallavisspices@yahoo.com');
  });

  it('saves the address and extra contacts, and a blank field clears it', async () => {
    const patch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(LEAD as never);
    const dialog = await openEdit();
    const q = within(dialog);

    await userEvent.clear(q.getByLabelText('Address line 2'));
    await userEvent.click(q.getByRole('button', { name: '+ Add email' }));
    await userEvent.type(q.getByLabelText('Additional emails 2'), 'accounts@pallavisspices.com');
    await userEvent.click(q.getByRole('button', { name: 'Remove additional phones 2' }));
    await userEvent.click(q.getByRole('button', { name: '+ Add phone' }));
    // An empty extra row is ignored, not sent.
    await userEvent.click(q.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [url, body] = patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(`/leads/${LEAD.id}`);
    expect(body).toMatchObject({
      email: 'sales@pallavisspices.com',
      addressLine1: 'Survey No. 68, Jambhulwadi–Kolewadi Road',
      addressLine2: null,
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '411046',
      additionalPhones: ['+912029512009'],
      additionalEmails: ['pallavisspices@yahoo.com', 'accounts@pallavisspices.com'],
    });
  });

  it(`stops offering "Add" at ${MAX_ADDITIONAL_CONTACTS}`, async () => {
    const dialog = await openEdit({ ...LEAD, additionalPhones: [], additionalEmails: [] });
    const q = within(dialog);

    for (let i = 0; i < MAX_ADDITIONAL_CONTACTS; i++) {
      await userEvent.click(q.getByRole('button', { name: '+ Add phone' }));
    }
    expect(q.getAllByRole('textbox', { name: /^Additional phones \d$/ })).toHaveLength(MAX_ADDITIONAL_CONTACTS);
    expect(q.queryByRole('button', { name: '+ Add phone' })).not.toBeInTheDocument();
  });

  it("shows the server's message under the additional-phones list", async () => {
    vi.spyOn(apiClient, 'apiPatch').mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Additional phone 1: Not a valid phone number.', 400, {
        additionalPhones: ['"12345" — Not a valid phone number.'],
      }),
    );
    const dialog = await openEdit();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await within(dialog).findByText('"12345" — Not a valid phone number.')).toBeInTheDocument();
  });

  it('shows and saves the designation', async () => {
    const patch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(LEAD as never);
    const dialog = await openEdit({ ...LEAD, designation: 'Proprietor' });
    const q = within(dialog);

    expect(q.getByLabelText('Designation')).toHaveValue('Proprietor');
    await userEvent.clear(q.getByLabelText('Designation'));
    await userEvent.type(q.getByLabelText('Designation'), 'Purchase Manager');
    await userEvent.click(q.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect((patch.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({ designation: 'Purchase Manager' });
  });
});

/*
 * "Rescheduling with a comment throws an error" — the comment went into the
 * 200-character "What for?" label, the only text box, and the 400 that came
 * back named no field (production, 2026-10-30).
 */
describe('Schedule follow-up', () => {
  async function openSchedule(): Promise<HTMLElement> {
    stubApi(LEAD);
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: '+ Follow-up' }));
    return screen.getByRole('dialog');
  }

  it('has a separate comment box, sent as notes', async () => {
    const post = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({ id: 'f1', scheduledAt: '2026-11-02T05:30:00.000Z' } as never);
    const dialog = await openSchedule();
    const q = within(dialog);
    const comment = 'Customer asked to call after Diwali; wants 2 kg turmeric samples first.';

    await userEvent.type(q.getByLabelText('What for?'), 'Send revised quotation');
    await userEvent.type(q.getByLabelText('Comment'), comment);
    await userEvent.click(q.getByRole('button', { name: 'Schedule' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(`/leads/${LEAD.id}/follow-ups`);
    expect(body).toMatchObject({ title: 'Send revised quotation', notes: comment });
  });

  it('cannot type past the label limit, and shows the count', async () => {
    const dialog = await openSchedule();
    const label = within(dialog).getByLabelText('What for?');

    expect(label).toHaveAttribute('maxLength', '200');
    await userEvent.type(label, 'abc');
    expect(within(dialog).getByText(/3\/200/)).toBeInTheDocument();
  });

  it('shows a server error under the field it belongs to', async () => {
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Request validation failed.', 400, {
        notes: ['notes must be shorter than or equal to 2000 characters'],
      }),
    );
    const dialog = await openSchedule();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }));

    expect(await within(dialog).findByText('notes must be shorter than or equal to 2000 characters')).toBeInTheDocument();
  });
});
