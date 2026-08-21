import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LandingPage } from '../features/marketing/landing-page';
import { PLANS, PLAN_LIMITS_ENFORCED, formatPlanPrice } from '../lib/plans';

/**
 * The public front door.
 *
 * The assertions that matter most are the honest ones: that every price on
 * screen comes from the pricing module rather than being typed into the markup,
 * and that the early-access disclaimer is present for as long as plan limits
 * are not actually enforced. A pricing page that quietly drifts from what the
 * product does is worse than no pricing page.
 */
function renderLanding(): void {
  render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

describe('Landing page', () => {
  it('explains what the product is', () => {
    renderLanding();

    expect(screen.getByRole('heading', { name: 'No lead left behind' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Simple pricing' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Questions' })).toBeInTheDocument();
  });

  it('offers a way to sign up and a way to sign in', () => {
    renderLanding();

    const signUp = screen.getAllByRole('link', { name: /create your workspace|start free/i });
    expect(signUp.length).toBeGreaterThan(0);
    for (const link of signUp) {
      expect(link).toHaveAttribute('href', '/register');
    }

    const signIn = screen.getAllByRole('link', { name: 'Sign in' });
    expect(signIn.length).toBeGreaterThan(0);
    expect(signIn[0]).toHaveAttribute('href', '/login');
  });

  it('renders every plan from the pricing module', () => {
    renderLanding();

    for (const plan of PLANS) {
      expect(screen.getByRole('heading', { name: plan.name })).toBeInTheDocument();
      expect(screen.getByText(plan.tagline)).toBeInTheDocument();
    }
  });

  it('shows monthly prices taken from the config, not typed into the markup', () => {
    renderLanding();

    for (const plan of PLANS) {
      // If someone hardcodes a price in the JSX, this stops matching the
      // moment the config changes — which is the whole point.
      const rendered = formatPlanPrice(plan.monthlyPrice);
      expect(screen.getAllByText(rendered).length).toBeGreaterThan(0);
    }
  });

  it('switches to annual pricing', async () => {
    const user = userEvent.setup();
    renderLanding();

    const paid = PLANS.find((plan) => plan.annualPrice !== null && plan.monthlyPrice > 0);
    expect(paid).toBeDefined();

    await user.click(screen.getByRole('radio', { name: 'Annual' }));

    expect(
      screen.getAllByText(formatPlanPrice(paid?.annualPrice as number)).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('/year').length).toBeGreaterThan(0);
  });

  it('lists each plan’s own features under that plan', () => {
    renderLanding();

    for (const plan of PLANS) {
      const card = screen.getByRole('heading', { name: plan.name }).closest('div');
      expect(card).not.toBeNull();

      for (const feature of plan.features) {
        expect(within(card as HTMLElement).getByText(feature)).toBeInTheDocument();
      }
    }
  });

  it('marks exactly one plan as most popular', () => {
    renderLanding();
    expect(screen.getAllByText('Most popular')).toHaveLength(1);
  });

  it('says plainly that limits are not enforced while they are not', () => {
    renderLanding();

    // The honesty check. Publishing "up to 15 users" when nothing caps users
    // is a promise broken at the worst possible moment — when a customer
    // discovers it. If PLAN_LIMITS_ENFORCED is ever flipped, this test flips
    // with it rather than silently passing.
    if (PLAN_LIMITS_ENFORCED) {
      expect(screen.queryAllByText(/plan limits are not currently applied/i)).toHaveLength(0);
    } else {
      expect(
        screen.getAllByText(/plan limits are not currently applied/i).length,
      ).toBeGreaterThan(0);
      expect(screen.getAllByText(/early access — no card required/i).length).toBeGreaterThan(0);
    }
  });

  it('has navigable landmarks and a skip link', () => {
    renderLanding();

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    // Without this a keyboard user tabs the entire nav on every page load.
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#main',
    );
  });

  it('opens and closes the mobile menu', async () => {
    const user = userEvent.setup();
    renderLanding();

    const toggle = screen.getByRole('button', { name: /open menu/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: /close menu/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('describes the illustration for screen readers', () => {
    renderLanding();

    // It carries meaning — it is the product's core screen — so it needs a
    // description rather than being hidden as decoration.
    expect(screen.getByRole('img', { name: /follow-up list/i })).toBeInTheDocument();
  });
});
