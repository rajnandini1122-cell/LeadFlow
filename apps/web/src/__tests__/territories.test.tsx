import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerritoryDetail, TerritoryListItem } from '@leadflow/api-types';

import { TerritoriesPage } from '../features/territories/territories-page';
import { NAV_ITEMS } from '../components/app-shell';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';

/**
 * The map on screen.
 *
 * Three things this UI must not get wrong: it has to name the places a
 * territory covers rather than implying a boundary nobody drew; the resolver
 * has to be visibly a question rather than an action; and it must never
 * suggest that a territory decides which team handles the work — that is the
 * assignment rules screen, and two answers would be two answers in production.
 */

const PUNE: TerritoryListItem = {
  id: 'terr-1',
  name: 'Pune / PCMC',
  description: 'West Maharashtra',
  status: 'ACTIVE',
  coverageCount: 2,
  coverageSummary: 'Pune, Maharashtra, IN · 411019, IN',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const RETIRED: TerritoryListItem = {
  ...PUNE,
  id: 'terr-9',
  name: 'Old Region',
  description: null,
  status: 'ARCHIVED',
  coverageCount: 0,
  coverageSummary: '',
};

const PUNE_DETAIL: TerritoryDetail = {
  ...PUNE,
  coverage: [
    {
      id: 'cov-1',
      type: 'CITY',
      countryCode: 'IN',
      state: 'Maharashtra',
      city: 'Pune',
      postalCode: null,
      label: 'Pune, Maharashtra, IN',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    {
      id: 'cov-2',
      type: 'POSTAL_CODE',
      countryCode: 'IN',
      state: null,
      city: null,
      postalCode: '411019',
      label: '411019, IN',
      createdAt: '2026-09-02T00:00:00.000Z',
    },
  ],
};

function signedInAs(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
  } as never);
}

function stubApi(territories: TerritoryListItem[] = [PUNE, RETIRED]): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
    if (url === '/territories') return Promise.resolve(territories as never);
    if (url === '/territories/terr-1') return Promise.resolve(PUNE_DETAIL as never);
    return Promise.resolve({ ...PUNE_DETAIL, coverage: [] } as never);
  });
}

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/territories']}>
        <TerritoriesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  signedInAs(['territory.view', 'territory.manage']);
  stubApi();
});

describe('navigation', () => {
  it('offers Territories to somebody who may view them', () => {
    const entry = NAV_ITEMS.find((item) => item.to === '/territories');

    expect(entry).toBeDefined();
    expect(entry?.permission).toBe('territory.view');
  });
});

describe('the territory list', () => {
  it('shows what each territory covers, and how much', async () => {
    renderPage();

    await screen.findByText('Pune / PCMC');
    expect(screen.getByText('Pune, Maharashtra, IN · 411019, IN')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('counts only the active territories', async () => {
    renderPage();

    // One of the two is archived. Counting it would overstate the live map.
    expect(await screen.findByText('1 active territory')).toBeInTheDocument();
  });

  it('never suggests a territory owns a team', async () => {
    renderPage();

    await screen.findByText('Pune / PCMC');
    // The structural promise, visible on screen: routing is decided once, on
    // the assignment rules screen.
    expect(screen.queryByText(/send to team/i)).toBeNull();
    expect(screen.queryByLabelText(/team/i)).toBeNull();
  });

  it('says so when nothing is configured', async () => {
    stubApi([]);
    renderPage();

    expect(await screen.findByText(/no territories yet/i)).toBeInTheDocument();
  });

  it('reports a failure instead of an empty table', async () => {
    vi.spyOn(apiClient, 'apiGet').mockRejectedValue(new Error('down'));
    renderPage();

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });
});

describe('managing territories', () => {
  it('creates one', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue(PUNE_DETAIL as never);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /new territory/i }));
    const dialog = within(screen.getByRole('dialog'));

    await userEvent.type(dialog.getByLabelText(/^name$/i), 'Nashik');
    await userEvent.click(dialog.getByRole('button', { name: /create territory/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/territories', { name: 'Nashik' }),
    );
  });

  it('archives, rather than deleting', async () => {
    const apiPatch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(PUNE_DETAIL as never);
    renderPage();

    await screen.findByText('Pune / PCMC');
    // A territory that once decided where enquiries went is the explanation
    // for why a customer reached the team they did.
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /archive/i }));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/territories/terr-1', { status: 'ARCHIVED' }),
    );
  });

  it('names the rules that block an archive', async () => {
    const refusal = new apiClient.ApiError(
      'VALIDATION_ERROR',
      'Assignment rules still route work to this territory.',
      400,
      { status: ['pause, archive or retarget these rules first: Pune website work'] },
    );
    vi.spyOn(apiClient, 'apiPatch').mockRejectedValue(refusal);
    renderPage();

    await screen.findByText('Pune / PCMC');
    await userEvent.click(screen.getByRole('button', { name: /archive/i }));

    // The refusal is the useful part: an administrator needs the rule names to
    // know what to pause before trying again.
    expect(await screen.findByText(/Pune website work/)).toBeInTheDocument();
  });

  it('offers to bring an archived territory back', async () => {
    const apiPatch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(PUNE_DETAIL as never);
    renderPage();

    await screen.findByText('Old Region');
    await userEvent.click(screen.getByRole('button', { name: /reactivate/i }));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/territories/terr-9', { status: 'ACTIVE' }),
    );
  });
});

describe('the coverage editor', () => {
  const openPune = async (): Promise<void> => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Pune / PCMC' }));
  };

  it('lists the places, saying which kind each one is', async () => {
    await openPune();

    // WHICH selector matters: a pincode and a city route differently, and an
    // administrator checking why an enquiry went somewhere needs to see which
    // one is configured.
    expect(await screen.findByText('Pune, Maharashtra, IN')).toBeInTheDocument();
    expect(screen.getByText('411019, IN')).toBeInTheDocument();

    // Scoped to the list: the add-coverage form below has an option with each
    // of these names, and an unscoped query would pass on those instead.
    const list = within(screen.getByRole('list'));
    expect(list.getByText('City')).toBeInTheDocument();
    expect(list.getByText('Postal code')).toBeInTheDocument();
  });

  it('shows no map, and nothing to draw on', async () => {
    await openPune();

    await screen.findByText('Pune, Maharashtra, IN');
    // A map would imply a precision this routing does not have.
    expect(document.querySelector('canvas')).toBeNull();
    expect(document.querySelector('svg[data-map]')).toBeNull();
  });

  it('asks only for the fields the chosen selector uses', async () => {
    await openPune();

    const form = within(await screen.findByRole('form', { name: /add coverage/i }));

    // City is the default: country, an optional state, and a city.
    expect(form.getByLabelText(/^city$/i)).toBeInTheDocument();
    expect(form.queryByLabelText(/postal code/i)).toBeNull();

    await userEvent.selectOptions(form.getByLabelText(/covers/i), 'POSTAL_CODE');
    expect(form.getByLabelText(/postal code/i)).toBeInTheDocument();
    // Sending a city on a postal selector is refused by the API, so the form
    // does not offer it rather than letting somebody fill it in and fail.
    expect(form.queryByLabelText(/^city$/i)).toBeNull();

    await userEvent.selectOptions(form.getByLabelText(/covers/i), 'COUNTRY');
    expect(form.queryByLabelText(/^city$/i)).toBeNull();
    expect(form.queryByLabelText(/^state$/i)).toBeNull();
  });

  it('adds a place', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue(PUNE_DETAIL as never);
    await openPune();

    const form = within(await screen.findByRole('form', { name: /add coverage/i }));
    await userEvent.selectOptions(form.getByLabelText(/covers/i), 'POSTAL_CODE');
    await userEvent.type(form.getByLabelText(/postal code/i), '411057');
    await userEvent.click(form.getByRole('button', { name: /add/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/territories/terr-1/coverage', {
        type: 'POSTAL_CODE',
        country: 'IN',
        postalCode: '411057',
      }),
    );
  });

  it('removes a place without deleting the territory', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue(PUNE_DETAIL as never);
    await openPune();

    await screen.findByText('Pune, Maharashtra, IN');
    const [firstRemove] = screen.getAllByRole('button', { name: /remove/i });
    await userEvent.click(firstRemove as HTMLElement);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/territories/terr-1/coverage/cov-1/remove', {}),
    );
  });

  it('surfaces a refusal when the place is already covered', async () => {
    const conflict = new apiClient.ApiError(
      'CONFLICT',
      'Pune, Maharashtra, IN is already covered by Nashik. Remove it there first.',
      409,
    );
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(conflict);
    await openPune();

    const form = within(await screen.findByRole('form', { name: /add coverage/i }));
    await userEvent.type(form.getByLabelText(/^city$/i), 'Pune');
    await userEvent.click(form.getByRole('button', { name: /add/i }));

    expect(await screen.findByText(/already covered by Nashik/)).toBeInTheDocument();
  });
});

describe('the resolver', () => {
  it('is presented as a question, not an action', async () => {
    renderPage();

    // An administrator checking where an address goes must not have to wonder
    // whether checking sent something there.
    expect(await screen.findByText(/nothing is created or changed/i)).toBeInTheDocument();
  });

  it('names the territory and which selector answered', async () => {
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      decision: 'MATCHED',
      territory: { id: 'terr-1', name: 'Pune / PCMC' },
      matchedCoverage: { id: 'cov-2', type: 'POSTAL_CODE', label: '411019, IN' },
    } as never);
    renderPage();

    await userEvent.type(await screen.findByLabelText(/^postal code$/i), '411019');
    await userEvent.click(screen.getByRole('button', { name: /check/i }));

    const panel = await screen.findByTestId('resolve-result');
    expect(within(panel).getByText(/Pune \/ PCMC/)).toBeInTheDocument();
    // Whether the pincode or the country decided is the whole question when
    // somebody is investigating a misroute.
    expect(within(panel).getByText(/Matched on postal code/)).toBeInTheDocument();
  });

  it('says plainly when nothing covers a location', async () => {
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      decision: 'NO_MATCH',
      territory: null,
      matchedCoverage: null,
    } as never);
    renderPage();

    await userEvent.type(await screen.findByLabelText(/^city$/i), 'Nowhere');
    await userEvent.click(screen.getByRole('button', { name: /check/i }));

    const panel = await screen.findByTestId('resolve-result');
    expect(within(panel).getByText(/No territory covers this location/i)).toBeInTheDocument();
  });
});

describe('someone who may only view', () => {
  beforeEach(() => signedInAs(['territory.view']));

  it('sees the map but is offered no way to change it', async () => {
    renderPage();

    await screen.findByText('Pune / PCMC');
    expect(screen.queryByRole('button', { name: /new territory/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /archive/i })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Pune / PCMC' }));
    await screen.findByText('Pune, Maharashtra, IN');
    expect(screen.queryByRole('form', { name: /add coverage/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('can still ask where a location belongs', async () => {
    // A manager whose region stopped receiving enquiries needs exactly this.
    renderPage();

    expect(await screen.findByRole('button', { name: /check/i })).toBeInTheDocument();
  });
});
