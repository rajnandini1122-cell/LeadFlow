import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanView } from '@leadflow/api-types';
import { MarketingLayout } from '../features/marketing/marketing-layout';
import { HomePage } from '../features/marketing/home-page';
import { FeaturesPage } from '../features/marketing/features-page';
import { PricingPage } from '../features/marketing/pricing-page';
import { AboutPage } from '../features/marketing/about-page';
import * as apiClient from '../lib/api-client';

/**
 * The public marketing site.
 *
 * The assertions that matter most are the honest ones: that prices come from
 * the API rather than being typed into the markup, and that the early-access
 * disclaimer is present while plan limits are not actually enforced. A pricing
 * page that drifts from what the product does is worse than none.
 */

const PLANS: PlanView[] = [
  {
    id: '1',
    code: 'STARTER',
    name: 'Starter',
    tagline: 'For a founder',
    description: null,
    featured: false,
    currency: 'USD',
    monthlyPrice: '0',
    yearlyPrice: '0',
    maxUsers: 3,
    maxActiveLeads: 500,
    features: ['Up to 3 team members', 'CSV import and export'],
  },
  {
    id: '2',
    code: 'PROFESSIONAL',
    name: 'Professional',
    tagline: 'For a sales team',
    description: null,
    featured: true,
    currency: 'USD',
    monthlyPrice: '29',
    yearlyPrice: '290',
    maxUsers: 15,
    maxActiveLeads: 10_000,
    features: ['Up to 15 team members', 'Team performance reporting'],
  },
  {
    id: '3',
    code: 'BUSINESS',
    name: 'Business',
    tagline: 'For several teams',
    description: null,
    featured: false,
    currency: 'USD',
    monthlyPrice: '79',
    yearlyPrice: '790',
    maxUsers: null,
    maxActiveLeads: null,
    features: ['No stated team-size limit', 'Administrative audit trail'],
  },
];

function renderAt(path: string): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<MarketingLayout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/features" element={<FeaturesPage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/about" element={<AboutPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Marketing site', () => {
  beforeEach(() => {
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue(PLANS as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('homepage', () => {
    it('leads with the product message and a way in', async () => {
      renderAt('/');

      expect(screen.getByRole('heading', { name: 'Never lose another lead' })).toBeInTheDocument();
      expect(screen.getAllByRole('link', { name: 'Start free' })[0]).toHaveAttribute(
        'href',
        '/register',
      );
      expect(screen.getByRole('link', { name: 'View pricing' })).toHaveAttribute(
        'href',
        '/pricing',
      );
    });

    it('covers the problem, the benefits, how it works and ownership', async () => {
      renderAt('/');

      expect(
        screen.getByRole('heading', {
          name: /leads are rarely lost to competitors/i,
        }),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'What you get instead' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'How it works' })).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /when a salesperson leaves/i }),
      ).toBeInTheDocument();
    });

    it('sets a page title and description', async () => {
      renderAt('/');

      await waitFor(() => {
        expect(document.title).toBe('LeadFlow — Sales CRM for small teams');
      });
    });
  });

  describe('pricing', () => {
    it('renders every plan the API returns', async () => {
      renderAt('/pricing');

      for (const plan of PLANS) {
        expect(await screen.findByRole('heading', { name: plan.name })).toBeInTheDocument();
      }
    });

    it('shows prices from the API rather than the markup', async () => {
      renderAt('/pricing');

      // If someone hardcodes a price in the JSX this stops matching as soon as
      // the catalogue changes, which is the whole point of fetching it.
      expect(await screen.findByText('$29')).toBeInTheDocument();
      expect(screen.getByText('$79')).toBeInTheDocument();
      expect(screen.getAllByText('Free').length).toBeGreaterThan(0);
    });

    it('switches to annual pricing', async () => {
      const user = userEvent.setup();
      renderAt('/pricing');

      await user.click(await screen.findByRole('radio', { name: 'Annual' }));

      expect(screen.getByText('$290')).toBeInTheDocument();
      expect(screen.getByText('$790')).toBeInTheDocument();
      expect(screen.getAllByText('/year').length).toBeGreaterThan(0);
    });

    it('states the limits without implying they are enforced', async () => {
      renderAt('/pricing');

      expect(await screen.findByText('Up to 3 members')).toBeInTheDocument();
      expect(screen.getByText('No stated members limit')).toBeInTheDocument();

      // The honesty check. Publishing "up to 3 members" while allowing thirty
      // is a promise broken at the worst possible moment.
      expect(
        screen.getByText(/limits shown above are not currently applied/i),
      ).toBeInTheDocument();
    });

    it('marks exactly one plan as most popular', async () => {
      renderAt('/pricing');
      expect(await screen.findByText('Most popular')).toBeInTheDocument();
      expect(screen.getAllByText('Most popular')).toHaveLength(1);
    });

    it('lists each plan’s own features under that plan', async () => {
      renderAt('/pricing');

      const heading = await screen.findByRole('heading', { name: 'Professional' });
      const card = heading.closest('div') as HTMLElement;

      expect(within(card).getByText('Team performance reporting')).toBeInTheDocument();
    });

    it('stays usable when the catalogue cannot be loaded', async () => {
      vi.spyOn(apiClient, 'apiGet').mockRejectedValue(new Error('offline'));
      renderAt('/pricing');

      // Prices come from one source, so this state is the honest cost of that.
      // A visitor must still be able to sign up.
      // usePlans retries once, so the error state takes longer than the
      // default 1s to settle.
      const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
      expect(within(alert).getByText(/pricing is temporarily unavailable/i)).toBeInTheDocument();
      expect(within(alert).getByRole('link', { name: /create your workspace/i })).toHaveAttribute(
        'href',
        '/register',
      );
    });
  });

  describe('features page', () => {
    it('groups the implemented features', async () => {
      renderAt('/features');

      expect(screen.getByRole('heading', { name: 'Lead management' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Follow-ups' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Reporting' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'CSV import' })).toBeInTheDocument();
    });

    it('separates what is planned from what is built', async () => {
      renderAt('/features');

      // Mixing the two is how a customer signs up for something that is not
      // there. Everything unbuilt carries a visible label.
      expect(
        screen.getByRole('heading', { name: 'Planned, not yet built' }),
      ).toBeInTheDocument();
      expect(screen.getAllByText('Upcoming').length).toBeGreaterThan(0);
    });

    it('does not claim capabilities the product lacks', async () => {
      renderAt('/features');

      const page = document.body.textContent ?? '';
      // The specific unsupported claims called out as forbidden.
      expect(page).not.toMatch(/AI-powered/i);
      expect(page).not.toMatch(/unlimited everything/i);
      expect(page).not.toMatch(/enterprise[- ]grade security/i);
    });
  });

  describe('about page', () => {
    it('explains the product decisions', async () => {
      renderAt('/about');

      expect(
        screen.getByRole('heading', { name: /why leadflow works the way it does/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Who it is for' })).toBeInTheDocument();
    });
  });

  describe('layout', () => {
    it('has landmarks, a skip link and marketing navigation', async () => {
      renderAt('/');

      expect(screen.getByRole('banner')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
      expect(screen.getByRole('contentinfo')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
        'href',
        '#main',
      );
    });

    it('does NOT show the authenticated CRM navigation', async () => {
      renderAt('/');

      // The public site and the app are deliberately separate layouts. A
      // marketing visitor must never see links into the CRM.
      for (const label of ['Leads', 'Contacts', 'Follow-ups', 'Team', 'Reports', 'Settings']) {
        expect(screen.queryByRole('link', { name: label })).toBeNull();
      }
    });

    it('opens the mobile menu', async () => {
      const user = userEvent.setup();
      renderAt('/');

      const toggle = screen.getByRole('button', { name: 'Open menu' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });
  });
});
