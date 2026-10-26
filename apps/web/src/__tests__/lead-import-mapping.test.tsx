import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportPreview } from '@leadflow/api-types';

import { ImportLeadsPage } from '../features/leads/import-leads-page';
import { ImportBatchesPage } from '../features/leads/import-batches-page';
import * as apiClient from '../lib/api-client';

/**
 * The CSV mapping screen.
 *
 * Every case here is one of the reported defects, seen from the user's side:
 * an address column with nowhere to go, a guess that arrived pre-ticked, a
 * column that vanished without comment, and a hundred errors with no way to
 * read the rest.
 */

const COLUMNS: ImportPreview['columns'] = [
  { header: 'Customer Name', index: 0, field: 'firstName', confidence: 'exact', note: null },
  { header: 'Mobile No.', index: 1, field: 'mobile', confidence: 'exact', note: null },
  { header: 'Address Line 1', index: 2, field: 'addressLine1', confidence: 'exact', note: null },
  { header: 'PIN Code', index: 3, field: 'postalCode', confidence: 'exact', note: null },
  {
    header: 'Budget',
    index: 4,
    field: 'estimatedValue',
    confidence: 'fuzzy',
    note: 'Guessed from the column name. Check this before importing.',
  },
  {
    header: 'Internal Ref',
    index: 5,
    field: null,
    confidence: null,
    note: 'Not recognised. Choose a field for it, or leave it out.',
  },
];

const PREVIEW: ImportPreview = {
  columns: COLUMNS,
  mapping: {
    'Customer Name': 'firstName',
    'Mobile No.': 'mobile',
    'Address Line 1': 'addressLine1',
    'PIN Code': 'postalCode',
  },
  unmapped: ['Budget', 'Internal Ref'],
  needsConfirmation: [COLUMNS[4] as ImportPreview['columns'][number]],
  collisions: [],
  missingRequired: [],
  duplicateHeaders: [],
  totalRows: 2,
  validRows: 1,
  invalidRows: 1,
  duplicateRows: 0,
  reviewRows: 1,
  rows: [
    {
      line: 2,
      values: {
        firstName: 'Dana',
        mobile: '9820011001',
        addressLine1: '12 High Street',
        postalCode: '411001',
      },
      errors: [],
      duplicateOf: null,
    },
    {
      line: 3,
      values: { firstName: 'Broken', mobile: 'not-a-number' },
      errors: ['"not-a-number" is not a phone number we can read.'],
      duplicateOf: null,
    },
  ],
  errorCsv: 'Row,Outcome,Reason\r\n3,Not imported,bad phone\r\n',
};

function stubApi(preview: ImportPreview = PREVIEW): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
    if (url === '/leads/assignable-users') return Promise.resolve([] as never);
    if (url === '/leads/import/mappings') return Promise.resolve([] as never);
    return Promise.resolve([] as never);
  });

  vi.spyOn(apiClient, 'apiPost').mockImplementation((url: string) => {
    if (url === '/leads/import/preview') return Promise.resolve(preview as never);
    if (url === '/leads/import') {
      return Promise.resolve({
        batchId: 'batch-1',
        created: 1,
        skipped: 0,
        failed: 1,
        failures: [{ line: 3, reason: 'bad phone' }],
        errorCsv: 'Row\r\n3\r\n',
      } as never);
    }
    return Promise.resolve({} as never);
  });
}

function renderPage(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter initialEntries={['/leads/import']}>
        <ImportLeadsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Uploads a file, which is what makes the rest of the screen appear.
 *
 * `FileReader` is real in jsdom, so the preview only arrives once it has fired
 * — which is why every case below awaits a mapping control rather than
 * asserting straight after the upload.
 */
async function upload(contents = 'Customer Name,Mobile No.\nDana,9820011001'): Promise<void> {
  renderPage();

  const file = new File([contents], 'october-leads.csv', { type: 'text/csv' });
  await userEvent.upload(screen.getByLabelText(/csv file/i), file);
  await screen.findByLabelText('Customer Name');
}

beforeEach(() => {
  stubApi();
});

describe('the mapping screen', () => {
  it('offers every address field, which previously did not exist', async () => {
    await upload();

    const select = screen.getByLabelText('Address Line 1');
    const options = within(select).getAllByRole('option').map((option) => option.textContent);

    /*
     * THE DEFECT. `leads` held only `city`, so these five fields were not in
     * the list at all — an "Address Line 1" column could only be dropped or
     * mapped onto something that meant a different thing.
     */
    expect(options).toContain('Address line 1');
    expect(options).toContain('Address line 2');
    expect(options).toContain('State / region');
    expect(options).toContain('Postal / PIN code');
    expect(options).toContain('Country (2-letter code)');
    expect(options).toContain('City');
  });

  it('pre-selects a confident match', async () => {
    await upload();

    expect(screen.getByLabelText('Address Line 1')).toHaveValue('addressLine1');
    expect(screen.getByLabelText('PIN Code')).toHaveValue('postalCode');
  });

  it('does not pre-select a guess, and says to check it', async () => {
    await upload();

    /*
     * "Budget" may be the deal value, a unit price or a per-kilo rate. The old
     * matcher pre-ticked the guess, which is how a budget column silently
     * became the pipeline value for two thousand leads.
     */
    expect(screen.getByLabelText(/^Budget/)).toHaveValue('');
    // Exact text, because the note below the control also contains the words
    // "check this" — an unscoped regex matched both and the test failed for a
    // reason that had nothing to do with the behaviour.
    expect(screen.getByText('Check this')).toBeInTheDocument();
    expect(screen.getByText(/Guessed from the column name/)).toBeInTheDocument();
  });

  it('says so when a column is not recognised, rather than hiding it', async () => {
    await upload();

    // The column still appears with its own control, so the user can map it or
    // decide to leave it out. It used to vanish with no comment at all.
    expect(screen.getByLabelText('Internal Ref')).toHaveValue('');
    expect(screen.getByText(/Not recognised/)).toBeInTheDocument();
  });

  it('warns when two columns are mapped to one field, and blocks the import', async () => {
    await upload();

    await userEvent.selectOptions(screen.getByLabelText('Internal Ref'), 'mobile');

    // Computed in the browser as well as on the server, so the warning appears
    // the moment the user creates the problem.
    expect(await screen.findByText(/Two columns are mapped to Mobile/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import/ })).toBeDisabled();
  });

  it('warns about a header that appears twice', async () => {
    stubApi({ ...PREVIEW, duplicateHeaders: ['Mobile No.'] });
    await upload();

    // Two columns with one name are two indexes to the reader but one key in
    // the mapping, so the second would silently replace the first.
    expect(screen.getByText(/appears more than once/)).toBeInTheDocument();
  });

  it('shows the address in the preview, so the mapping can be checked', async () => {
    await upload();

    // The counts said "created 2,000" whether or not the address arrived. Being
    // able to SEE it is what makes the preview worth having.
    expect(screen.getByText('12 High Street, 411001')).toBeInTheDocument();
  });

  it('quotes the rejected value in the row error', async () => {
    await upload();

    expect(screen.getByText(/"not-a-number" is not a phone number/)).toBeInTheDocument();
  });

  it('refuses to import until a required field is mapped', async () => {
    stubApi({ ...PREVIEW, mapping: {}, missingRequired: ['firstName', 'mobile'] });
    await upload();

    expect(screen.getByRole('alert')).toHaveTextContent(/First name and Mobile/);
    expect(screen.getByRole('button', { name: /^Import/ })).toBeDisabled();
  });

  it('sends the mapping the user corrected, not the suggestion', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost');
    await upload();

    await userEvent.selectOptions(screen.getByLabelText('Internal Ref'), 'productInterest');
    await userEvent.click(screen.getByRole('button', { name: /Re-check with this mapping/ }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/leads/import/preview',
        expect.objectContaining({
          mapping: expect.objectContaining({ 'Internal Ref': 'productInterest' }) as unknown,
        }),
      ),
    );
  });
});

describe('the error download', () => {
  it('offers every problem row as a file', async () => {
    await upload();

    /*
     * A download rather than a longer table, because the point is to fix the
     * SOURCE file. The old screen showed twenty rows and the import reported a
     * hundred failures, with no way to see the rest of a nine-hundred-row file.
     */
    expect(screen.getByRole('button', { name: /Download problem rows/ })).toBeInTheDocument();
  });

  it('writes a UTF-8 BOM so Excel opens Marathi names correctly', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:x');
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });

    await upload();
    await userEvent.click(screen.getByRole('button', { name: /Download problem rows/ }));

    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;

    /*
     * The RAW BYTES, not `blob.text()`.
     *
     * `text()` is specified to run UTF-8 decode, and UTF-8 decode strips a
     * leading BOM — so reading it that way asserts the opposite of what it
     * looks like it asserts, and passes whether or not the BOM is written.
     * Excel reads bytes, so the test reads bytes.
     */
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    // Without the BOM a UTF-8 CSV opens as mojibake in Excel, and the user
    // concludes the import corrupted their data.
    expect(await blob.text()).toContain('Not imported');
    vi.unstubAllGlobals();
  });

  it('offers it again on the result screen', async () => {
    await upload();
    await userEvent.click(screen.getByRole('button', { name: /^Import/ }));

    expect(await screen.findByText(/Import finished/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download problem rows/ })).toBeInTheDocument();
  });

  it('links to just the leads that batch created', async () => {
    await upload();
    await userEvent.click(screen.getByRole('button', { name: /^Import/ }));

    expect(await screen.findByRole('link', { name: /See just these leads/ })).toHaveAttribute(
      'href',
      '/leads?importBatchId=batch-1',
    );
  });
});

describe('duplicate handling', () => {
  it('defaults to skipping', async () => {
    await upload();

    // The safe behaviour is the one you get by doing nothing.
    expect(screen.getByLabelText(/Rows that match a lead you already have/)).toHaveValue('SKIP');
  });

  it('spells out what the other mode does before it is used', async () => {
    await upload();

    await userEvent.selectOptions(
      screen.getByLabelText(/Rows that match a lead you already have/),
      'CREATE_ANYWAY',
    );

    // And in particular what it does NOT do: nothing on the existing lead is
    // touched, which is the fear somebody choosing this has.
    expect(screen.getByText(/Nothing on the existing lead is changed/)).toBeInTheDocument();
  });

  it('will not import deliberate duplicates until they are confirmed', async () => {
    await upload();

    await userEvent.selectOptions(
      screen.getByLabelText(/Rows that match a lead you already have/),
      'CREATE_ANYWAY',
    );

    /*
     * A SECOND, EXPLICIT acknowledgement, not just the dropdown.
     *
     * This mode creates a deliberate duplicate for every matching row at
     * scale — forty rows means forty second leads for customers somebody is
     * already working — and a dropdown changed minutes ago is a weak record of
     * intent for that.
     */
    expect(screen.getByRole('button', { name: /^Import/ })).toBeDisabled();

    await userEvent.click(
      screen.getByLabelText(/I have checked these and want the second leads created/),
    );
    expect(screen.getByRole('button', { name: /^Import/ })).toBeEnabled();
  });

  it('forgets the confirmation when the mode changes', async () => {
    await upload();

    const mode = screen.getByLabelText(/Rows that match a lead you already have/);
    await userEvent.selectOptions(mode, 'CREATE_ANYWAY');
    await userEvent.click(
      screen.getByLabelText(/I have checked these and want the second leads created/),
    );

    await userEvent.selectOptions(mode, 'SKIP');
    await userEvent.selectOptions(mode, 'CREATE_ANYWAY');

    // A tick left on from an earlier decision is not a decision about this one.
    expect(screen.getByRole('button', { name: /^Import/ })).toBeDisabled();
  });

  it('says how many rows the mode will affect', async () => {
    stubApi({ ...PREVIEW, duplicateRows: 7 });
    await upload();

    await userEvent.selectOptions(
      screen.getByLabelText(/Rows that match a lead you already have/),
      'CREATE_ANYWAY',
    );

    // The count, because "any matching row" and "seven rows" are different
    // decisions to be asked to make.
    expect(screen.getByText(/7 rows in this file match/)).toBeInTheDocument();
  });

  it('sends the chosen mode', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost');
    await upload();

    await userEvent.selectOptions(
      screen.getByLabelText(/Rows that match a lead you already have/),
      'CREATE_ANYWAY',
    );
    await userEvent.click(
      screen.getByLabelText(/I have checked these and want the second leads created/),
    );
    await userEvent.click(screen.getByRole('button', { name: /^Import/ }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/leads/import',
        expect.objectContaining({ duplicateMode: 'CREATE_ANYWAY' }),
      ),
    );
  });
});

describe('past imports', () => {
  const BATCH = {
    id: 'batch-1',
    fileName: 'october-leads.csv',
    totalRows: 40,
    created: 38,
    skipped: 1,
    failed: 1,
    activeLeads: 20,
    deactivatedLeads: 18,
    startedAt: '2026-10-01T09:00:00.000Z',
    completedAt: '2026-10-01T09:00:30.000Z',
    importedBy: { id: 'user-1', fullName: 'Asha Admin' },
    mapping: { 'Customer Name': 'firstName' },
  };

  const renderBatches = (batches: unknown[] = [BATCH]): void => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue(batches as never);

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <MemoryRouter>
          <ImportBatchesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it('shows what a run created and how much is still live', async () => {
    renderBatches();

    expect(await screen.findByText('october-leads.csv')).toBeInTheDocument();
    expect(screen.getByText(/38 created/)).toBeInTheDocument();
    // The two numbers that make a bad import correctable: what it made, and
    // what is left.
    expect(screen.getByRole('link', { name: '20 of 38' })).toHaveAttribute(
      'href',
      '/leads?importBatchId=batch-1',
    );
    expect(screen.getByText('18 deactivated')).toBeInTheDocument();
  });

  it('marks a run that did not finish', async () => {
    renderBatches([{ ...BATCH, completedAt: null }]);

    // Its leads still carry the batch id, which is why the batch row is written
    // before the first lead rather than after the last.
    expect(await screen.findByText(/Did not finish/)).toBeInTheDocument();
  });

  it('says so when nothing has been imported', async () => {
    renderBatches([]);

    expect(await screen.findByText(/No imports yet/)).toBeInTheDocument();
  });
});
