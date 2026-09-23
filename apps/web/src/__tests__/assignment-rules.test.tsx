import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssignmentPreviewResult, AssignmentRuleView } from '@leadflow/api-types';

import { AssignmentRulesPage } from '../features/assignment-rules/assignment-rules-page';
import { NAV_ITEMS } from '../components/app-shell';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';

/**
 * The routing table on screen.
 *
 * Two things this UI must not get wrong: it has to say WHAT a rule matches in
 * words an administrator can check, and the preview has to be visibly a
 * question rather than an action. A screen that makes routing look like it
 * already happened is worse than no screen.
 */

const WEBSITE_RULE: AssignmentRuleView = {
  id: '019a0000-0000-7000-8000-00000000r001',
  name: 'Website enquiries',
  description: 'Everything from the site',
  status: 'ACTIVE',
  priority: 10,
  source: 'Website',
  product: null,
  territory: null,
  isFallback: false,
  targetTeam: { id: 't-1', name: 'Pune Sales', status: 'ACTIVE' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const PRODUCT_RULE: AssignmentRuleView = {
  ...WEBSITE_RULE,
  id: '019a0000-0000-7000-8000-00000000r002',
  name: 'Onion powder',
  description: null,
  priority: 20,
  source: 'Website',
  product: { id: 'p-1', name: 'White Onion Powder', sku: 'WOP-1' },
  targetTeam: { id: 't-2', name: 'Export Team', status: 'ACTIVE' },
};

const PAUSED_RULE: AssignmentRuleView = {
  ...WEBSITE_RULE,
  id: '019a0000-0000-7000-8000-00000000r003',
  name: 'Trade shows',
  status: 'PAUSED',
  priority: 30,
  source: 'Trade show',
};

const FALLBACK_RULE: AssignmentRuleView = {
  ...WEBSITE_RULE,
  id: '019a0000-0000-7000-8000-00000000r004',
  name: 'Everything else',
  description: null,
  priority: 1000,
  source: null,
  isFallback: true,
  targetTeam: { id: 't-3', name: 'General Sales', status: 'ACTIVE' },
};

/** A rule scoped to one resolved territory — never to a city string. */
const TERRITORY_RULE: AssignmentRuleView = {
  ...WEBSITE_RULE,
  id: '019a0000-0000-7000-8000-00000000r005',
  name: 'Pune website work',
  description: null,
  priority: 5,
  source: 'Website',
  territory: { id: 'terr-1', name: 'Pune / PCMC', status: 'ACTIVE' },
  targetTeam: { id: 't-1', name: 'Pune Sales', status: 'ACTIVE' },
};

const TERRITORIES = [
  { id: 'terr-1', name: 'Pune / PCMC', status: 'ACTIVE' },
  { id: 'terr-9', name: 'Retired Region', status: 'ARCHIVED' },
];

const TEAMS = [
  { id: 't-1', name: 'Pune Sales', status: 'ACTIVE' },
  { id: 't-2', name: 'Export Team', status: 'ACTIVE' },
  { id: 't-9', name: 'Retired Team', status: 'ARCHIVED' },
];

const PRODUCTS = { items: [{ id: 'p-1', name: 'White Onion Powder' }], total: 1 };
const ORGANIZATION = { settings: { leadSources: ['Website', 'Referral', 'Trade show'] } };

function signedInAs(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
  } as never);
}

function stubApi(rules: AssignmentRuleView[] = [WEBSITE_RULE, PRODUCT_RULE, PAUSED_RULE, FALLBACK_RULE]): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
    if (url === '/assignment-rules') return Promise.resolve(rules as never);
    if (url === '/teams') return Promise.resolve(TEAMS as never);
    if (url === '/products') return Promise.resolve(PRODUCTS as never);
    if (url === '/territories') return Promise.resolve(TERRITORIES as never);
    return Promise.resolve(ORGANIZATION as never);
  });
}

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/assignment-rules']}>
        <AssignmentRulesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const previewResult = (
  overrides: Partial<AssignmentPreviewResult> = {},
): AssignmentPreviewResult => ({
  decision: 'MATCHED',
  rule: { id: WEBSITE_RULE.id, name: WEBSITE_RULE.name, priority: 10, isFallback: false },
  team: { id: 't-1', name: 'Pune Sales' },
  eligibleAgents: [{ membershipId: 'm-1', userId: 'u-1', fullName: 'Asha Rep' }],
  eligibleAgentCount: 1,
  territory: null,
  ...overrides,
});

beforeEach(() => {
  signedInAs(['assignment_rule.view', 'assignment_rule.manage']);
  stubApi();
});

afterEach(() => vi.restoreAllMocks());

describe('navigation', () => {
  it('offers Assignment rules to somebody who may view them', () => {
    const entry = NAV_ITEMS.find((item) => item.to === '/assignment-rules');

    expect(entry?.label).toBe('Assignment rules');
    expect(entry?.permission).toBe('assignment_rule.view');
  });
});

describe('the rule list', () => {
  it('shows precedence, what each rule matches, and where it sends work', async () => {
    renderPage();

    const website = (await screen.findByText('Website enquiries')).closest('tr') as HTMLElement;
    expect(within(website).getByText('10')).toBeInTheDocument();
    expect(within(website).getByText('source Website')).toBeInTheDocument();
    expect(within(website).getByText('Pune Sales')).toBeInTheDocument();

    // AND, said as "and" — listing them would suggest either would do.
    const product = screen.getByText('Onion powder').closest('tr') as HTMLElement;
    expect(within(product).getByText('source Website and product White Onion Powder')).toBeInTheDocument();
  });

  it('shows the fallback as last rather than as a number', async () => {
    renderPage();

    const fallback = (await screen.findByText('Everything else')).closest('tr') as HTMLElement;
    expect(within(fallback).getByText('Last')).toBeInTheDocument();
    expect(within(fallback).getByText('Anything not matched above')).toBeInTheDocument();
  });

  it('distinguishes paused from active', async () => {
    renderPage();

    const paused = (await screen.findByText('Trade shows')).closest('tr') as HTMLElement;
    expect(within(paused).getByText('Paused')).toBeInTheDocument();
  });

  it('counts only the active rules', async () => {
    renderPage();

    // Three of the four are active; a paused rule is configuration, not routing.
    expect(await screen.findByText('3 active rules')).toBeInTheDocument();
  });

  it('says so when nothing is configured', async () => {
    stubApi([]);
    renderPage();

    expect(await screen.findByText(/no routing rules yet/i)).toBeInTheDocument();
  });

  it('reports a failure instead of an empty table', async () => {
    vi.spyOn(apiClient, 'apiGet').mockRejectedValue(new Error('network'));
    renderPage();

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });
});

describe('managing rules', () => {
  it('creates a rule', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue(WEBSITE_RULE as never);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /new rule/i }));
    // Scoped to the dialog: the preview panel below has its own Source field.
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/^name$/i), 'Referrals');
    await userEvent.type(dialog.getByLabelText(/source/i), 'Referral');
    await userEvent.selectOptions(dialog.getByLabelText(/send to team/i), 't-1');
    await userEvent.click(dialog.getByRole('button', { name: /create rule/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/assignment-rules', {
        name: 'Referrals',
        targetTeamId: 't-1',
        isFallback: false,
        source: 'Referral',
      }),
    );
  });

  it('hides the criteria once a rule is marked as the fallback', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /new rule/i }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/source/i)).toBeInTheDocument();

    await userEvent.click(dialog.getByLabelText(/use as the fallback/i));

    // A fallback carries no criteria, and the form says that by removing them
    // rather than by refusing after the fact.
    expect(dialog.queryByLabelText(/source/i)).toBeNull();
    expect(dialog.queryByLabelText(/priority/i)).toBeNull();
  });

  it('does not offer an archived team as a target', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /new rule/i }));
    const picker = screen.getByLabelText(/send to team/i);

    // The API refuses one, so offering it produces an error nobody can act on.
    expect(within(picker).queryByRole('option', { name: /retired team/i })).toBeNull();
    expect(within(picker).getByRole('option', { name: 'Pune Sales' })).toBeInTheDocument();
  });

  it('edits a rule', async () => {
    const apiPatch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(WEBSITE_RULE as never);
    renderPage();

    const row = (await screen.findByText('Website enquiries')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.clear(dialog.getByLabelText(/^name$/i));
    await userEvent.type(dialog.getByLabelText(/^name$/i), 'Web enquiries');
    await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(
        `/assignment-rules/${WEBSITE_RULE.id}`,
        expect.objectContaining({ name: 'Web enquiries' }),
      ),
    );
  });

  it('pauses and archives', async () => {
    const apiPatch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(WEBSITE_RULE as never);
    renderPage();

    const row = (await screen.findByText('Website enquiries')).closest('tr') as HTMLElement;

    await userEvent.click(within(row).getByRole('button', { name: /pause/i }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(`/assignment-rules/${WEBSITE_RULE.id}`, {
        status: 'PAUSED',
      }),
    );

    await userEvent.click(within(row).getByRole('button', { name: /archive/i }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(`/assignment-rules/${WEBSITE_RULE.id}`, {
        status: 'ARCHIVED',
      }),
    );
  });

  it('surfaces a refusal from the server', async () => {
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
      new apiClient.ApiError(
        'CONFLICT',
        'Another active rule already matches exactly these criteria.',
        409,
      ),
    );

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /new rule/i }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/^name$/i), 'Duplicate');
    await userEvent.type(dialog.getByLabelText(/source/i), 'Website');
    await userEvent.selectOptions(dialog.getByLabelText(/send to team/i), 't-1');
    await userEvent.click(dialog.getByRole('button', { name: /create rule/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already matches/i);
  });
});

describe('the preview', () => {
  const check = async (result: AssignmentPreviewResult) => {
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue(result as never);
    renderPage();

    await userEvent.type(await screen.findByLabelText(/^source$/i), 'Website');
    await userEvent.click(screen.getByRole('button', { name: /check/i }));

    return screen.findByTestId('preview-result');
  };

  it('says a specific rule matched, and who is available', async () => {
    const panel = await check(previewResult());

    expect(within(panel).getByText('Matched')).toBeInTheDocument();
    expect(within(panel).getByText(/Website enquiries/)).toBeInTheDocument();
    expect(within(panel).getByText(/1 agent available: Asha Rep/)).toBeInTheDocument();
  });

  it('distinguishes the fallback from a real match', async () => {
    const panel = await check(
      previewResult({
        decision: 'FALLBACK_MATCHED',
        rule: { id: FALLBACK_RULE.id, name: 'Everything else', priority: 1000, isFallback: true },
        team: { id: 't-3', name: 'General Sales' },
      }),
    );

    // Falling through usually means a rule is missing, so it must not read as
    // an ordinary success.
    expect(within(panel).getByText('Fallback')).toBeInTheDocument();
    expect(within(panel).getByText(/no specific rule matched/i)).toBeInTheDocument();
  });

  it('says plainly when nothing would be routed', async () => {
    const panel = await check(
      previewResult({ decision: 'NO_MATCH', rule: null, team: null, eligibleAgents: [], eligibleAgentCount: 0 }),
    );

    expect(within(panel).getByText('No match')).toBeInTheDocument();
    expect(within(panel).getByText(/nothing would be routed/i)).toBeInTheDocument();
  });

  it('separates "no rule" from "nobody available"', async () => {
    const panel = await check(
      previewResult({ decision: 'NO_ELIGIBLE_AGENTS', eligibleAgents: [], eligibleAgentCount: 0 }),
    );

    /*
     * A staffing problem, not a routing one — and the two have different
     * fixes. Collapsing them into one message would send an administrator to
     * edit rules that are working.
     */
    expect(within(panel).getByText('No available agents')).toBeInTheDocument();
    expect(within(panel).getByText(/nobody in that team can receive work/i)).toBeInTheDocument();
    // And it names where to go and fix it, rather than repeating itself.
    expect(within(panel).getByText(/no agents available in pune sales/i)).toBeInTheDocument();
  });

  it('is presented as a question, not an action', async () => {
    renderPage();

    // The screen has to say this. An administrator checking where enquiries go
    // must not have to wonder whether checking sent one.
    expect(
      await screen.findByText(/nothing is created or changed/i),
    ).toBeInTheDocument();
  });
});

describe('someone who may only view', () => {
  beforeEach(() => signedInAs(['assignment_rule.view']));

  it('sees the table but is offered no way to change it', async () => {
    renderPage();

    await screen.findByText('Website enquiries');
    expect(screen.queryByRole('button', { name: /new rule/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /archive/i })).toBeNull();
  });

  it('can still ask where work would go', async () => {
    // Reading the routing table is exactly what a manager whose team stopped
    // receiving enquiries needs to do.
    renderPage();

    expect(await screen.findByRole('button', { name: /check/i })).toBeInTheDocument();
  });
});

describe('the territory criterion', () => {
  it('says which territory a rule is scoped to, in words', async () => {
    stubApi([TERRITORY_RULE]);
    renderPage();

    await screen.findByText('Pune website work');
    // AND, said out loud. A row that listed the two criteria without joining
    // them would read as "either of these".
    expect(screen.getByText(/source Website and territory Pune \/ PCMC/)).toBeInTheDocument();
  });

  it('offers territories, and sends the id rather than a place name', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue(TERRITORY_RULE as never);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /new rule/i }));
    const dialog = within(screen.getByRole('dialog'));

    await userEvent.type(dialog.getByLabelText(/^name$/i), 'Pune work');
    await userEvent.selectOptions(dialog.getByLabelText(/territory/i), 'terr-1');
    await userEvent.selectOptions(dialog.getByLabelText(/send to team/i), 't-1');
    await userEvent.click(dialog.getByRole('button', { name: /create rule/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/assignment-rules', {
        name: 'Pune work',
        targetTeamId: 't-1',
        isFallback: false,
        // A resolved id. The form has no city, state or pincode box at all,
        // because a rule that matched raw geography would be a second
        // geography database.
        territoryId: 'terr-1',
      }),
    );
  });

  it('does not offer an archived territory for a new rule', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /new rule/i }));
    const dialog = within(screen.getByRole('dialog'));

    // The API refuses one, and offering it would produce an error nobody can
    // act on.
    expect(within(dialog.getByLabelText(/territory/i)).queryByText(/Retired Region/)).toBeNull();
    expect(within(dialog.getByLabelText(/territory/i)).getByText('Pune / PCMC')).toBeInTheDocument();
  });

  it('still shows the retired territory a paused rule was written against', async () => {
    const paused: AssignmentRuleView = {
      ...TERRITORY_RULE,
      status: 'PAUSED',
      territory: { id: 'terr-9', name: 'Retired Region', status: 'ARCHIVED' },
    };
    stubApi([paused]);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    const dialog = within(screen.getByRole('dialog'));

    // Otherwise the form would silently claim the rule routes everywhere.
    expect(
      within(dialog.getByLabelText(/territory/i)).getByText(/Retired Region/),
    ).toBeInTheDocument();
  });

  it('hides the territory along with the other criteria for a fallback', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /new rule/i }));
    const dialog = within(screen.getByRole('dialog'));

    await userEvent.click(dialog.getByRole('checkbox'));
    expect(dialog.queryByLabelText(/territory/i)).toBeNull();
  });
});

describe('the preview, with a location', () => {
  const checkLocation = async (result: AssignmentPreviewResult) => {
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue(result as never);
    renderPage();

    await userEvent.type(await screen.findByLabelText(/^city$/i), 'Pune');
    await userEvent.click(screen.getByRole('button', { name: /check/i }));

    return screen.findByTestId('preview-result');
  };

  it('sends the location raw, for the server to resolve', async () => {
    const apiPost = vi
      .spyOn(apiClient, 'apiPost')
      .mockResolvedValue(previewResult({ territory: { id: 'terr-1', name: 'Pune / PCMC' } }) as never);
    renderPage();

    await userEvent.selectOptions(await screen.findByLabelText(/^country$/i), 'IN');
    await userEvent.type(screen.getByLabelText(/^state$/i), 'Maharashtra');
    await userEvent.type(screen.getByLabelText(/^city$/i), 'Pune');
    await userEvent.type(screen.getByLabelText(/^postal code$/i), '411019');
    await userEvent.click(screen.getByRole('button', { name: /check/i }));

    await waitFor(() =>
      // Resolved by the server, on the same path production will take. Doing
      // it here would mean the screen tested one thing and production another.
      expect(apiPost).toHaveBeenCalledWith('/assignment-rules/preview', {
        country: 'IN',
        state: 'Maharashtra',
        city: 'Pune',
        postalCode: '411019',
      }),
    );
  });

  it('names the territory a location resolved to', async () => {
    const panel = await checkLocation(
      previewResult({ territory: { id: 'terr-1', name: 'Pune / PCMC' } }),
    );

    expect(within(panel).getByText(/Pune \/ PCMC/)).toBeInTheDocument();
  });

  it('separates "no territory covers this" from "no rule matched"', async () => {
    const panel = await checkLocation(
      previewResult({ decision: 'NO_MATCH', rule: null, team: null, eligibleAgents: [], eligibleAgentCount: 0 }),
    );

    // Two different problems with two different fixes: one is a missing rule,
    // the other a gap in the map.
    expect(within(panel).getByText(/No territory covers that location/i)).toBeInTheDocument();
    expect(within(panel).getByText('No match')).toBeInTheDocument();
  });

  it('says nothing about territories when no location was given', async () => {
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue(previewResult() as never);
    renderPage();

    await userEvent.type(await screen.findByLabelText(/^source$/i), 'Website');
    await userEvent.click(screen.getByRole('button', { name: /check/i }));

    const panel = await screen.findByTestId('preview-result');
    expect(within(panel).queryByText(/No territory covers/i)).toBeNull();
  });
});
