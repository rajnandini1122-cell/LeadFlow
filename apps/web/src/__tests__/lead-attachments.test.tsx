import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../lib/api-client';
import { setFormattingContext } from '../lib/format';
import { ToastProvider } from '../components/toast';
import { LeadAttachmentsCard, latestQuotation } from '../features/leads/lead-attachments-card';
import type { LeadAttachment } from '../features/leads/use-lead-attachments';

/**
 * Files & quotations on a lead: attach the quotation that was sent (which
 * moves the lead to Quotation sent), invoices, POs and photos; see them
 * listed with amount, uploader and age; download and remove them.
 */

const LEAD_ID = '01a00000-0000-7000-8000-0000000000c1';

const QUOTE: LeadAttachment = {
  id: '01a00000-0000-7000-8000-0000000000a1',
  leadId: LEAD_ID,
  kind: 'QUOTATION',
  fileName: 'Quotation Q-104.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 182_000,
  note: '20 ft container, CIF Jebel Ali',
  amount: '125000',
  uploadedBy: { id: 'user-1', fullName: 'Asha Rep' },
  createdAt: '2026-10-23T05:30:00.000Z',
  isImage: false,
};

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })}
    >
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  setFormattingContext({ locale: 'en-IN', currency: 'INR', timezone: 'Asia/Kolkata' });
});
afterEach(() => {
  vi.restoreAllMocks();
  setFormattingContext({ locale: 'en-US', currency: 'USD', timezone: 'UTC' });
});

describe('Files & quotations', () => {
  it('lists each file with its kind, amount, note and uploader', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([QUOTE] as never);
    wrap(<LeadAttachmentsCard leadId={LEAD_ID} canEdit />);

    const list = await screen.findByRole('list', { name: 'Attached files' });
    expect(within(list).getByText('Quotation')).toBeInTheDocument();
    expect(within(list).getByText('Quotation Q-104.pdf')).toBeInTheDocument();
    expect(within(list).getByText('₹1,25,000')).toBeInTheDocument();
    expect(within(list).getByText('20 ft container, CIF Jebel Ali')).toBeInTheDocument();
    expect(within(list).getByText(/178 KB · Asha Rep/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Quotation Q-104.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Quotation Q-104.pdf' })).toBeInTheDocument();
  });

  it('says what to attach when there is nothing yet', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([] as never);
    wrap(<LeadAttachmentsCard leadId={LEAD_ID} canEdit />);
    expect(await screen.findByText('No files yet')).toBeInTheDocument();
  });

  it('a viewer without edit rights can download but not attach or remove', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([QUOTE] as never);
    wrap(<LeadAttachmentsCard leadId={LEAD_ID} canEdit={false} />);

    await screen.findByRole('list', { name: 'Attached files' });
    expect(screen.queryByRole('form', { name: 'Attach a file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Download/ })).toBeInTheDocument();
  });

  it('attaches a quotation as sent, with amount and an idempotency key, and confirms the stage move', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([] as never);
    const apiPost = vi
      .spyOn(apiClient, 'apiPost')
      .mockResolvedValue({ attachment: QUOTE, leadStatus: 'QUOTATION_SENT', replayed: false } as never);
    const user = userEvent.setup();
    wrap(<LeadAttachmentsCard leadId={LEAD_ID} canEdit />);

    await screen.findByText('No files yet');
    await user.upload(screen.getByLabelText('File'), new File(['%PDF-1.4'], 'Q-104.pdf', { type: 'application/pdf' }));
    await user.type(screen.getByLabelText('Amount'), '125000');
    await user.type(screen.getByLabelText('Note'), 'CIF Jebel Ali');
    expect(screen.getByLabelText(/Sent to the customer/)).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Attach file' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [url, form, options] = apiPost.mock.calls[0] as [string, FormData, { headers: Record<string, string> }];
    expect(url).toBe(`/leads/${LEAD_ID}/attachments`);
    expect(form.get('kind')).toBe('QUOTATION');
    expect(form.get('amount')).toBe('125000');
    expect(form.get('note')).toBe('CIF Jebel Ali');
    expect(form.get('markQuotationSent')).toBe('true');
    expect((form.get('file') as File).name).toBe('Q-104.pdf');
    expect(options.headers['Idempotency-Key']).toBeTruthy();

    expect(await screen.findByText(/now awaiting the customer/)).toBeInTheDocument();
  });

  it('refuses a file over 10 MB before uploading it', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([] as never);
    const apiPost = vi.spyOn(apiClient, 'apiPost');
    const user = userEvent.setup();
    wrap(<LeadAttachmentsCard leadId={LEAD_ID} canEdit />);

    await screen.findByText('No files yet');
    const big = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    await user.upload(screen.getByLabelText('File'), big);
    await user.click(screen.getByRole('button', { name: 'Attach file' }));

    expect(await screen.findAllByText('Files must be 10 MB or smaller.')).not.toHaveLength(0);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('only a quotation offers "sent", and an invoice is never marked sent', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([] as never);
    const apiPost = vi
      .spyOn(apiClient, 'apiPost')
      .mockResolvedValue({ attachment: { ...QUOTE, kind: 'INVOICE' }, leadStatus: 'NEGOTIATION', replayed: false } as never);
    const user = userEvent.setup();
    wrap(<LeadAttachmentsCard leadId={LEAD_ID} canEdit />);

    await screen.findByText('No files yet');
    await user.selectOptions(screen.getByLabelText('What is it?'), 'INVOICE');
    expect(screen.queryByLabelText(/Sent to the customer/)).not.toBeInTheDocument();
    await user.upload(screen.getByLabelText('File'), new File(['%PDF-1.4'], 'inv.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Attach file' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect((apiPost.mock.calls[0]?.[1] as FormData).get('markQuotationSent')).toBeNull();
    expect(await screen.findByText('Invoice attached.')).toBeInTheDocument();
  });

  it('shows the API’s reason when an upload is refused', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([] as never);
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
      new apiClient.ApiError('VALIDATION_FAILED' as never, 'That file type is not accepted.', 400, { file: ['unsupported type'] }),
    );
    const user = userEvent.setup();
    wrap(<LeadAttachmentsCard leadId={LEAD_ID} canEdit />);

    await screen.findByText('No files yet');
    await user.upload(screen.getByLabelText('File'), new File(['MZ'], 'x.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Attach file' }));

    expect(await screen.findByText('That file type is not accepted.')).toBeInTheDocument();
    expect(screen.getByText('unsupported type')).toBeInTheDocument();
  });

  it('removes a file after confirmation', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue([QUOTE] as never);
    const apiDelete = vi.spyOn(apiClient, 'apiDelete').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    wrap(<LeadAttachmentsCard leadId={LEAD_ID} canEdit />);

    await user.click(await screen.findByRole('button', { name: 'Remove Quotation Q-104.pdf' }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith(`/leads/${LEAD_ID}/attachments/${QUOTE.id}`));
    expect(await screen.findByText('File removed.')).toBeInTheDocument();
  });

  it('latestQuotation picks the newest quotation, ignoring other files', () => {
    const photo = { ...QUOTE, id: 'p', kind: 'PRODUCT_PHOTO' as const };
    expect(latestQuotation([photo, QUOTE])?.id).toBe(QUOTE.id);
    expect(latestQuotation([photo])).toBeNull();
    expect(latestQuotation(undefined)).toBeNull();
  });
});
