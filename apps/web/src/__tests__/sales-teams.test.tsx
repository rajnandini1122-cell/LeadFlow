import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamAgentCandidate, TeamDetail, TeamListItem } from '@leadflow/api-types';

import { SalesTeamsPage } from '../features/sales-teams/sales-teams-page';
import { TeamDetailPage } from '../features/sales-teams/team-detail-page';
import { NAV_ITEMS } from '../components/app-shell';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';

/**
 * Sales teams.
 *
 * Two things these screens must get right, beyond rendering: they show WHY
 * somebody cannot receive work — paused, suspended, or not an assignment role
 * are three different problems with three different fixes — and they never
 * stand in for the server's authorization. Hiding a button is a courtesy; the
 * API is what decides, and the API tests assert that separately.
 */

const TEAM: TeamListItem = {
  id: '019a0000-0000-7000-8000-00000000t001',
  name: 'Pune Sales',
  description: 'Western region',
  status: 'ACTIVE',
  manager: {
    membershipId: 'm-1',
    userId: 'u-manager',
    fullName: 'Rohan Manager',
    role: 'MANAGER',
  },
  activeMemberCount: 2,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const ARCHIVED: TeamListItem = {
  ...TEAM,
  id: '019a0000-0000-7000-8000-00000000t002',
  name: 'Retired Team',
  status: 'ARCHIVED',
  manager: null,
  activeMemberCount: 0,
};

const DETAIL: TeamDetail = {
  ...TEAM,
  members: [
    {
      id: 'tm-1',
      membershipId: 'm-2',
      userId: 'u-rep',
      fullName: 'Asha Rep',
      email: 'asha@example.test',
      avatarUrl: null,
      role: 'SALES_REP',
      status: 'ACTIVE',
      assignmentEnabled: true,
      joinedAt: '2026-09-01T00:00:00.000Z',
      eligibleForAssignment: true,
    },
    {
      id: 'tm-2',
      membershipId: 'm-3',
      userId: 'u-paused',
      fullName: 'Vikram Paused',
      email: 'vikram@example.test',
      avatarUrl: null,
      role: 'SALES_REP',
      status: 'ACTIVE',
      assignmentEnabled: false,
      joinedAt: '2026-09-01T00:00:00.000Z',
      eligibleForAssignment: false,
    },
    {
      id: 'tm-3',
      membershipId: 'm-4',
      userId: 'u-suspended',
      fullName: 'Neha Suspended',
      email: 'neha@example.test',
      avatarUrl: null,
      role: 'SALES_REP',
      status: 'SUSPENDED',
      assignmentEnabled: true,
      joinedAt: '2026-09-01T00:00:00.000Z',
      eligibleForAssignment: false,
    },
  ],
};

const AGENTS: TeamAgentCandidate[] = [
  {
    membershipId: 'm-5',
    userId: 'u-free',
    fullName: 'Sunil Available',
    email: 'sunil@example.test',
    avatarUrl: null,
    role: 'SALES_REP',
    status: 'ACTIVE',
    assignableRole: true,
    teams: [],
  },
  {
    membershipId: 'm-4',
    userId: 'u-suspended',
    fullName: 'Neha Suspended',
    email: 'neha@example.test',
    avatarUrl: null,
    role: 'SALES_REP',
    status: 'SUSPENDED',
    assignableRole: true,
    teams: [],
  },
];

function signedInAs(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
  } as never);
}

function renderList(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sales-teams']}>
        <Routes>
          <Route path="/sales-teams" element={<SalesTeamsPage />} />
          <Route path="/sales-teams/:id" element={<TeamDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDetail(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/sales-teams/${TEAM.id}`]}>
        <Routes>
          <Route path="/sales-teams" element={<p>All teams</p>} />
          <Route path="/sales-teams/:id" element={<TeamDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Answers each endpoint the screens call. */
function stubApi(overrides: { teams?: TeamListItem[]; detail?: TeamDetail } = {}): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
    if (url === '/teams') return Promise.resolve((overrides.teams ?? [TEAM]) as never);
    if (url === '/teams/agents') return Promise.resolve(AGENTS as never);
    return Promise.resolve((overrides.detail ?? DETAIL) as never);
  });
}

beforeEach(() => {
  signedInAs(['team.view', 'team.manage']);
  stubApi();
});

afterEach(() => vi.restoreAllMocks());

describe('navigation', () => {
  it('offers Sales teams to somebody who may view them', () => {
    const entry = NAV_ITEMS.find((item) => item.to === '/sales-teams');

    expect(entry?.label).toBe('Sales teams');
    expect(entry?.permission).toBe('team.view');
  });

  it('keeps it distinct from the member directory', () => {
    // Two entries called "Team" would be one entry nobody can find.
    const team = NAV_ITEMS.find((item) => item.to === '/team');

    expect(team?.label).toBe('Team');
    expect(team?.permission).toBe('user.view');
  });
});

describe('the team list', () => {
  it('shows each team with its manager, agent count and status', async () => {
    renderList();

    const row = (await screen.findByText('Pune Sales')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Rohan Manager')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
  });

  it('says so when there are no teams yet', async () => {
    stubApi({ teams: [] });
    renderList();

    expect(await screen.findByText(/no sales teams yet/i)).toBeInTheDocument();
  });

  it('can include archived teams', async () => {
    const apiGet = vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string, params) => {
      if (url === '/teams') {
        return Promise.resolve(
          (params ? [TEAM, ARCHIVED] : [TEAM]) as never,
        );
      }
      if (url === '/teams/agents') return Promise.resolve(AGENTS as never);
      return Promise.resolve(DETAIL as never);
    });

    renderList();
    await screen.findByText('Pune Sales');

    await userEvent.click(screen.getByLabelText(/show archived/i));

    expect(await screen.findByText('Retired Team')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/teams', { includeArchived: 'true' });
  });

  it('reports a failure instead of showing an empty list', async () => {
    vi.spyOn(apiClient, 'apiGet').mockRejectedValue(new Error('network'));
    renderList();

    // An empty table would read as "you have no teams", which is a different
    // and much more alarming statement than "this did not load".
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });

  it('creates a team', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue(DETAIL as never);
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: /new team/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Nagpur Sales');
    await userEvent.click(screen.getByRole('button', { name: /create team/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/teams', { name: 'Nagpur Sales' }),
    );
  });

  it('offers only members who could actually hold the manager role', async () => {
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: /new team/i }));
    const picker = screen.getByLabelText(/manager/i);

    // Offering a suspended colleague produces a server error the
    // administrator cannot act on.
    expect(within(picker).getByRole('option', { name: /sunil available/i })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /neha suspended/i })).toBeNull();
  });
});

describe('someone who may only view', () => {
  beforeEach(() => signedInAs(['team.view']));

  it('sees the teams but is offered no way to change them', async () => {
    renderList();

    await screen.findByText('Pune Sales');
    expect(screen.queryByRole('button', { name: /new team/i })).toBeNull();
  });

  it('sees no member controls on a team', async () => {
    renderDetail();

    await screen.findByText('Asha Rep');
    expect(screen.queryByRole('button', { name: /^remove$/i })).toBeNull();
    expect(screen.queryByLabelText(/assignment for/i)).toBeNull();
    // Still told who is available, because that is information, not a control.
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });
});

describe('one team', () => {
  it('lists its agents and says why each is or is not available', async () => {
    renderDetail();

    const available = (await screen.findByText('Asha Rep')).closest('tr') as HTMLElement;
    expect(within(available).getByText('Available')).toBeInTheDocument();

    /*
     * Three different reasons, said plainly. "Paused" is this team's decision
     * and this screen can change it; a suspended membership is not, and
     * showing both as a bare unchecked box would send an administrator
     * toggling the wrong thing.
     */
    const paused = screen.getByText('Vikram Paused').closest('tr') as HTMLElement;
    expect(within(paused).getByText('Paused')).toBeInTheDocument();

    const suspended = screen.getByText('Neha Suspended').closest('tr') as HTMLElement;
    expect(within(suspended).getByText(/membership suspended/i)).toBeInTheDocument();
  });

  it('adds an existing organization member', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue(DETAIL as never);
    renderDetail();

    await userEvent.selectOptions(
      await screen.findByLabelText(/add an existing member/i),
      'u-free',
    );
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(`/teams/${TEAM.id}/members`, { userId: 'u-free' }),
    );
  });

  it('does not offer somebody already in the team', async () => {
    renderDetail();

    const picker = await screen.findByLabelText(/add an existing member/i);
    expect(within(picker).queryByRole('option', { name: /asha rep/i })).toBeNull();
  });

  it('removes a member', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue(DETAIL as never);
    renderDetail();

    const row = (await screen.findByText('Asha Rep')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /remove/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(`/teams/${TEAM.id}/members/tm-1/remove`),
    );
  });

  it('pauses assignment for one member', async () => {
    const apiPatch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(DETAIL as never);
    renderDetail();

    await userEvent.click(await screen.findByLabelText(/assignment for asha rep/i));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(`/teams/${TEAM.id}/members/tm-1`, {
        assignmentEnabled: false,
      }),
    );
  });

  it('archives a team, and says what that does not do', async () => {
    const apiPatch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue({
      ...DETAIL,
      status: 'ARCHIVED',
    } as never);

    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /archive/i }));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(`/teams/${TEAM.id}`, { status: 'ARCHIVED' }),
    );
  });

  it('withdraws member controls while archived, and explains why', async () => {
    stubApi({ detail: { ...DETAIL, status: 'ARCHIVED' } });
    renderDetail();

    expect(await screen.findByText(/this team is archived/i)).toBeInTheDocument();
    // Nothing was unassigned — the screen says so rather than leaving an
    // administrator to wonder what archiving just did to their pipeline.
    expect(screen.getByText(/nothing was unassigned/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/add an existing member/i)).toBeNull();
  });

  it('reports a team that could not be loaded', async () => {
    vi.spyOn(apiClient, 'apiGet').mockRejectedValue(new Error('network'));
    renderDetail();

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });
});
