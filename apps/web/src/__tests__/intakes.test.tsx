import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationIntakeDetail, IntegrationIntakeListItem } from '@leadflow/api-types';

import { IntakesPage } from '../features/intakes/intakes-page';
import { WebsiteEnquiryPanel } from '../features/intakes/website-enquiry-panel';
import { NAV_ITEMS } from '../components/app-shell';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';

/**
 * The website enquiry queue on screen.
 *
 * Three things this UI must not get wrong: an enquiry that became nobody's
 * work has to say WHY in words somebody can act on; a duplicate has to read as
 * a decision waiting for a person rather than a failure; and retry has to be
 * visibly "route this again", never "edit and resubmit".
 */

const PROCESSED: IntegrationIntakeListItem = {
  id: 'intake-1',
  source: 'WEBSITE',
  status: 'PROCESSED',
  receivedAt: '2026-09-22T09:00:00.000Z',
  name: 'Dana Whitfield',
  company: 'Whitfield Foods',
  productInterest: 'White onion powder, 500kg monthly',
  sourcePage: '/contact',
  processingCode: null,
  failureReason: null,
  processingAttempts: 1,
  lastProcessingAt: '2026-09-22T09:00:05.000Z',
  processedAt: '2026-09-22T09:00:05.000Z',
  territory: { id: 'terr-1', name: 'India' },
  rule: { id: 'rule-1', name: 'Website enquiries' },
  team: { id: 'team-1', name: 'Pune Sales' },
  assignedTo: { id: 'user-1', fullName: 'Asha Rep' },
  createdLead: { id: 'lead-1', leadNumber: 'LD-00021' },
};

const BLOCKED: IntegrationIntakeListItem = {
  ...PROCESSED,
  id: 'intake-2',
  status: 'BLOCKED',
  name: 'Ravi Menon',
  company: null,
  processingCode: 'NO_ELIGIBLE_AGENTS',
  failureReason: 'Nobody in Pune Sales can receive assigned work right now.',
  processedAt: null,
  assignedTo: null,
  createdLead: null,
};

const DUPLICATE: IntegrationIntakeListItem = {
  ...BLOCKED,
  id: 'intake-3',
  // A distinct name: two fixtures sharing one would make every row query in
  // this file ambiguous, and the ambiguity would look like a UI bug.
  name: 'Priya Nair',
  status: 'DUPLICATE',
  processingCode: 'DUPLICATE_LEAD',
  failureReason: 'An active lead (LD-00009) already exists for this number.',
};

const detailFor = (item: IntegrationIntakeListItem): IntegrationIntakeDetail => ({
  ...item,
  email: 'dana@example.test',
  phone: '+919820011001',
  country: 'IN',
  message: 'We lose enquiries every week. Can we see a demo?',
  matchedContactId: null,
  matchedLeadId: item.status === 'DUPLICATE' ? 'lead-9' : null,
});

function signedInAs(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
  } as never);
}

function stubApi(items: IntegrationIntakeListItem[] = [PROCESSED, BLOCKED, DUPLICATE]): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
    if (url.startsWith('/integration-intakes?') || url === '/integration-intakes') {
      return Promise.resolve({ items, total: items.length } as never);
    }

    const match = /^\/integration-intakes\/(.+)$/.exec(url);
    if (match) {
      const found = items.find((item) => item.id === match[1]) ?? items[0];
      return Promise.resolve(detailFor(found as IntegrationIntakeListItem) as never);
    }

    return Promise.resolve(null as never);
  });
}

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/website-enquiries']}>
        <IntakesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  signedInAs(['integration_intake.view', 'integration_intake.manage']);
  stubApi();
});

describe('navigation', () => {
  it('offers the queue to somebody who may view it', () => {
    const entry = NAV_ITEMS.find((item) => item.to === '/website-enquiries');

    expect(entry).toBeDefined();
    expect(entry?.permission).toBe('integration_intake.view');
  });
});

describe('the queue', () => {
  /*
   * Scoped to the TABLE throughout.
   *
   * The status filter offers every status by the same label the pills use, so
   * an unscoped `getByText('Became a lead')` would happily match the dropdown
   * option and pass while the table showed nothing at all.
   */
  const table = async (): Promise<HTMLElement> => {
    renderPage();
    await screen.findByText('Dana Whitfield');
    return screen.getByRole('table');
  };

  it('shows who wrote in, what they asked about, and what happened', async () => {
    const rows = within(await table());

    expect(rows.getByText('Whitfield Foods')).toBeInTheDocument();
    // All three fixtures asked about the same thing, so this is deliberately
    // an "all" query — the point is that the column is populated, not that it
    // is unique.
    expect(rows.getAllByText('White onion powder, 500kg monthly')).toHaveLength(3);
    expect(rows.getByText('Became a lead')).toBeInTheDocument();
    expect(rows.getByText('LD-00021')).toBeInTheDocument();
    expect(rows.getByText('Asha Rep')).toBeInTheDocument();
  });

  it('says WHY a blocked enquiry is blocked, in words', async () => {
    const rows = within(await table());

    // "Blocked" alone sends an operator looking. The reason tells them what to
    // fix.
    expect(rows.getByText('Needs configuration')).toBeInTheDocument();
    expect(rows.getByText('Nobody in that team can take work')).toBeInTheDocument();
  });

  it('reads a duplicate as a decision, not a failure', async () => {
    const rows = within(await table());

    expect(rows.getByText('Needs review')).toBeInTheDocument();
    expect(rows.queryByText(/failed/i)).toBeNull();
  });

  it('names somebody who left no name rather than showing a blank', async () => {
    stubApi([{ ...BLOCKED, name: null }]);
    renderPage();

    expect(await screen.findByText(/left no name/i)).toBeInTheDocument();
  });

  it('never dumps the raw submission into the table', async () => {
    renderPage();

    await screen.findByText('Dana Whitfield');
    // The message belongs on the record somebody opens deliberately, not in a
    // list that is scanned.
    expect(screen.queryByText(/We lose enquiries every week/)).toBeNull();
  });

  it('says so when nothing has arrived', async () => {
    stubApi([]);
    renderPage();

    expect(await screen.findByText(/no enquiries yet/i)).toBeInTheDocument();
  });

  it('reports a failure instead of an empty table', async () => {
    vi.spyOn(apiClient, 'apiGet').mockRejectedValue(new Error('down'));
    renderPage();

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });

  it('filters by status', async () => {
    const apiGet = vi.spyOn(apiClient, 'apiGet');
    renderPage();

    await screen.findByText('Dana Whitfield');
    await userEvent.selectOptions(screen.getByLabelText(/filter by status/i), 'BLOCKED');

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        expect.stringContaining('status=BLOCKED') as unknown as string,
      ),
    );
  });
});

describe('one enquiry', () => {
  const open = async (name: string): Promise<HTMLElement> => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(name) }));
    return screen.findByTestId('intake-detail');
  };

  it('shows the customer’s own words', async () => {
    const panel = await open('Dana Whitfield');

    expect(within(panel).getByText(/We lose enquiries every week/)).toBeInTheDocument();
    expect(within(panel).getByText('dana@example.test')).toBeInTheDocument();
  });

  it('shows how it was routed', async () => {
    const panel = await open('Dana Whitfield');

    // A rep asking "why did this reach me?" should get an answer here rather
    // than from whoever maintains the rules.
    expect(within(panel).getByText('Website enquiries')).toBeInTheDocument();
    expect(within(panel).getByText('Pune Sales')).toBeInTheDocument();
    expect(within(panel).getByText('India')).toBeInTheDocument();
  });

  it('links to the lead it became', async () => {
    const panel = await open('Dana Whitfield');

    expect(within(panel).getByRole('link', { name: 'LD-00021' })).toHaveAttribute(
      'href',
      '/leads/lead-1',
    );
  });

  it('offers retry on a blocked enquiry, and says what it does', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({} as never);
    const panel = await open('Ravi Menon');

    expect(within(panel).getByText(/Nobody in Pune Sales/)).toBeInTheDocument();
    // The obvious guesses — "resend to the customer", "edit and resubmit" —
    // are both wrong, so the screen says which it is.
    expect(within(panel).getByText(/Nothing the customer sent is changed/)).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole('button', { name: /retry routing/i }));

    await waitFor(() =>
      // No payload. Retry re-evaluates the stored enquiry; it cannot author one.
      expect(apiPost).toHaveBeenCalledWith('/integration-intakes/intake-2/retry', {}),
    );
  });

  it('offers no retry once an enquiry became a lead', async () => {
    const panel = await open('Dana Whitfield');

    expect(within(panel).queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('offers no "create anyway" on a duplicate', async () => {
    stubApi([DUPLICATE]);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Priya Nair/ }));
    const panel = await screen.findByTestId('intake-detail');

    // Overriding a duplicate is a decision a person makes deliberately, with a
    // record of what they were shown — not a button on a queue.
    expect(within(panel).queryByRole('button', { name: /create anyway/i })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /retry/i })).toBeNull();
    expect(within(panel).getByText(/already in the CRM/i)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /matching lead/i })).toHaveAttribute(
      'href',
      '/leads/lead-9',
    );
  });

  it('shows no cursor, sequence or rotation internals', async () => {
    const panel = await open('Dana Whitfield');

    // An administrator does not need a textbox saying "next sequence = 57".
    // The team and the person are the auditable facts.
    expect(within(panel).queryByText(/sequence/i)).toBeNull();
    expect(within(panel).queryByText(/cursor/i)).toBeNull();
  });
});

describe('someone who may only view', () => {
  beforeEach(() => signedInAs(['integration_intake.view']));

  it('sees the queue but cannot retry', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /Ravi Menon/ }));
    const panel = await screen.findByTestId('intake-detail');

    expect(within(panel).getByText(/Nobody in Pune Sales/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('the website enquiry panel on a lead', () => {
  const renderPanel = (): void => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WebsiteEnquiryPanel leadId="lead-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it('shows the enquiry behind the lead', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue({
      id: 'intake-1',
      source: 'WEBSITE',
      receivedAt: '2026-09-22T09:00:00.000Z',
      sourcePage: '/contact',
      message: 'We lose enquiries every week. Can we see a demo?',
      productInterest: 'White onion powder, 500kg monthly',
      territory: { id: 'terr-1', name: 'India' },
      rule: { id: 'rule-1', name: 'Website enquiries' },
      team: { id: 'team-1', name: 'Pune Sales' },
    } as never);

    renderPanel();

    expect(await screen.findByText(/We lose enquiries every week/)).toBeInTheDocument();
    expect(screen.getByText(/From \/contact/)).toBeInTheDocument();
    expect(screen.getByText(/Routed by/)).toBeInTheDocument();
  });

  it('renders nothing for a lead somebody created by hand', async () => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue(null as never);
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <MemoryRouter>
          <WebsiteEnquiryPanel leadId="lead-2" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // An empty "Website enquiry: none" panel on every manual lead would be
    // clutter on the screen a salesperson looks at most.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
