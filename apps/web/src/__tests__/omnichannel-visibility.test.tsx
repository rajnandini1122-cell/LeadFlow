import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../lib/api-client';
import { AppShell } from '../components/app-shell';
import { AuthProvider } from '../features/auth/auth-context';
import { ChannelIntegrationsPage } from '../features/settings/channel-integrations-page';

/**
 * Reaching omnichannel at all.
 *
 * THE BUG THIS COVERS: the Channels settings screen — the only place a channel
 * can be connected — was hidden behind `omnichannelEnabled`, a per-tenant flag
 * that defaulted to false and had no UI or API path to turn on. The screen that
 * configures omnichannel was gated behind omnichannel already being configured,
 * so the whole feature was unreachable through the product; the only way in was
 * a direct database write.
 *
 * The fix is asymmetric on purpose, and that asymmetry is what these tests pin:
 * the CONFIGURATION screen is always reachable, while the OPERATIONAL screens
 * stay gated because they are legitimately empty until a channel is connected.
 */

const PERMISSIONS = ['org.view', 'org.update', 'lead.view.all', 'lead.update'];

const USER = {
  id: 'u-1',
  email: 'owner@northwind.example',
  fullName: 'Dana Whitfield',
  status: 'ACTIVE',
  role: 'OWNER',
  permissions: PERMISSIONS,
  organization: {
    id: 'org-1',
    name: 'Northwind Supply',
    slug: 'northwind-supply',
    timezone: 'America/Chicago',
    currency: 'USD',
    locale: 'en-US',
    country: 'US',
  },
  organizations: [],
};

/** A signed-in session whose organization has omnichannel on or off. */
function mockSession(omnichannelEnabled: boolean): void {
  vi.spyOn(apiClient, 'apiPost').mockImplementation((path: string) => {
    if (path === '/auth/refresh') {
      return Promise.resolve({ tokens: { accessToken: 'access-1' }, user: USER } as never);
    }
    return Promise.resolve({} as never);
  });

  vi.spyOn(apiClient, 'apiGet').mockImplementation((path: string) => {
    if (path === '/organizations/current') {
      return Promise.resolve({
        ...USER.organization,
        settings: { omnichannelEnabled, sharedUnassignedQueue: false },
      } as never);
    }
    /*
     * An ARRAY, and the exact shape matters: `/channel-integrations` returns
     * IntegrationView[], and a paged object here made the page throw on
     * `.map` — which is the page's real contract, not a test artefact.
     *
     * Three not-connected rows, so the cards render the same way they do for an
     * organization that has never connected anything.
     */
    if (path === '/channel-integrations') {
      return Promise.resolve([
        { channel: 'WHATSAPP', status: 'DISCONNECTED', enabled: false, id: null },
        { channel: 'INSTAGRAM', status: 'DISCONNECTED', enabled: false, id: null },
        { channel: 'FACEBOOK', status: 'DISCONNECTED', enabled: false, id: null },
      ] as never);
    }
    if (path.startsWith('/channel-integrations')) {
      return Promise.resolve({ templates: [] } as never);
    }
    if (path.startsWith('/conversations')) {
      return Promise.resolve({ unassigned: 0, mine: 0, all: 0, items: [], count: 0 } as never);
    }
    if (path.startsWith('/follow-ups')) return Promise.resolve([] as never);
    return Promise.resolve({ items: [], count: 0 } as never);
  });
}

function renderShell(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <AppShell />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The nav, addressed by its landmark rather than by guessing at markup. */
async function navigation(): Promise<HTMLElement> {
  const navs = await screen.findAllByRole('navigation');
  return navs[0] as HTMLElement;
}

/**
 * Nav links matched by HREF, not by accessible name.
 *
 * Deliberate: the Inbox item carries a count badge, so its accessible name is
 * "Inbox" plus whatever the badge says. An anchored name matcher missed it — and
 * worse, the "is it hidden" assertions then passed for the wrong reason, because
 * a query that can never match also never matches when the link IS present. The
 * href is the thing being asserted anyway.
 */
function navHrefs(nav: HTMLElement): string[] {
  return [...nav.querySelectorAll('a')].map((link) => link.getAttribute('href') ?? '');
}

describe('Navigation when omnichannel is OFF', () => {
  beforeEach(() => mockSession(false));
  afterEach(() => vi.restoreAllMocks());

  it('still shows Channels, so the feature can be switched on', async () => {
    renderShell();

    const nav = await navigation();

    // The regression test. Without this link there is no route into the
    // feature at all short of editing the database.
    await waitFor(() => expect(navHrefs(nav)).toContain('/settings/channels'));
  });

  it('hides Inbox, which would be empty', async () => {
    renderShell();

    const nav = await navigation();
    // Wait for the settled state first, so this is not asserting on a nav that
    // simply has not finished rendering.
    await waitFor(() => expect(navHrefs(nav)).toContain('/settings/channels'));

    expect(navHrefs(nav)).not.toContain('/inbox');
  });

  it('hides Channel review, which would be empty', async () => {
    renderShell();

    const nav = await navigation();
    await waitFor(() => expect(navHrefs(nav)).toContain('/settings/channels'));

    expect(navHrefs(nav)).not.toContain('/leads/review');
  });
});

describe('Navigation when omnichannel is ON', () => {
  beforeEach(() => mockSession(true));
  afterEach(() => vi.restoreAllMocks());

  it('shows all three: Inbox, Channel review and Channels', async () => {
    renderShell();

    const nav = await navigation();

    await waitFor(() => expect(navHrefs(nav)).toContain('/inbox'));
    expect(navHrefs(nav)).toContain('/leads/review');
    expect(navHrefs(nav)).toContain('/settings/channels');
  });
});

/** Renders the configuration screen on its own, as a signed-in owner. */
function renderChannelsPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <ChannelIntegrationsPage />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('The omnichannel toggle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders unchecked when the organization has it off', async () => {
    mockSession(false);
    renderChannelsPage();

    const toggle = await screen.findByRole('checkbox', {
      name: /use omnichannel capture in this organization/i,
    });

    expect(toggle).not.toBeChecked();
  });

  it('renders checked when the organization has it on', async () => {
    mockSession(true);
    renderChannelsPage();

    const toggle = await screen.findByRole('checkbox', {
      name: /use omnichannel capture in this organization/i,
    });

    expect(toggle).toBeChecked();
  });

  it('persists through the existing organization-settings endpoint', async () => {
    mockSession(false);
    const patch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue({} as never);

    renderChannelsPage();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('checkbox', {
        name: /use omnichannel capture in this organization/i,
      }),
    );

    /*
     * The SAME endpoint every other organization setting uses, not a bespoke
     * one. That is what makes this change validated, permission-checked and
     * audited identically to the rest — a dedicated route would have had to
     * re-earn all three.
     */
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/organizations/current', {
        settings: { omnichannelEnabled: true },
      }),
    );
  });

  it('can be switched back off', async () => {
    mockSession(true);
    const patch = vi.spyOn(apiClient, 'apiPatch').mockResolvedValue({} as never);

    renderChannelsPage();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('checkbox', {
        name: /use omnichannel capture in this organization/i,
      }),
    );

    // Explicit false, not an omitted key — the API has to receive the
    // disable, and a falsy value dropped in transit would make this
    // un-disableable.
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/organizations/current', {
        settings: { omnichannelEnabled: false },
      }),
    );
  });
});

describe('The channel configuration screen', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is usable with omnichannel off — connect is the point of the page', async () => {
    mockSession(false);
    renderChannelsPage();

    // The page renders its own content rather than an "enable this first"
    // placeholder, because enabling is done on this page.
    expect(
      await screen.findByRole('heading', { name: /channel integrations/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /use omnichannel capture/i }),
    ).toBeInTheDocument();
  });

  it('no longer calls Instagram and Messenger capture-only', async () => {
    mockSession(true);
    renderChannelsPage();

    await screen.findByRole('heading', { name: /channel integrations/i });
    const text = document.body.textContent ?? '';

    /*
     * The copy said "Instagram and Facebook Messenger are capture-only for now
     * — answer those in the Meta apps". Outbound is implemented for all three
     * channels (OutboundMessagingService dispatches WHATSAPP, INSTAGRAM and
     * FACEBOOK), so that line sent people away from a feature they had.
     */
    expect(text).not.toMatch(/capture-only/i);
    expect(text).not.toMatch(/answer those in the Meta apps/i);

    // And says what is actually true, including the one real difference.
    expect(text).toMatch(/reply/i);
    expect(text).toMatch(/24-hour/i);
    expect(text).toMatch(/template/i);
  });
});
