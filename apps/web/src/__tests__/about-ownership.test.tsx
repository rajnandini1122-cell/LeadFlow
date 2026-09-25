import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { resetApiMocks } from './helpers/mock-api';
import {
  COMPANY_LEGAL_NAME,
  COMPANY_SALES_EMAIL,
  COMPANY_WEBSITE,
} from '../components/brand';
import { AboutPage } from '../features/marketing/about-page';
import { HomePage } from '../features/marketing/home-page';

/**
 * Public identity: what LeadFlow says it is, and who it says operates it.
 *
 * These assertions are about CLAIMS, which makes them a slightly unusual kind
 * of test — most of the suite checks behaviour. They exist because the failure
 * mode here is not a crash: it is the site quietly stating something that is not
 * true, or dropping the ownership notice a customer is entitled to see, and
 * neither produces an error anybody would notice.
 *
 * Two things are deliberately asserted NEGATIVELY: that no dated milestone is
 * claimed, and that no unproven scale or capability claim appears. An
 * enthusiastic edit to this page is exactly how "trusted by 500 businesses"
 * gets added, and nothing else in the codebase would object.
 */
function renderPublic(element: React.ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('The About page', () => {
  it('renders without any authentication', () => {
    /*
     * No AuthProvider, on purpose.
     *
     * A public page that reads auth state throws the moment it is rendered
     * outside the provider — which is precisely what happens to a visitor who
     * has never signed in. Rendering it bare is the assertion.
     */
    resetApiMocks();
    renderPublic(<AboutPage />);

    expect(
      screen.getByRole('heading', { name: /built and run by one company/i }),
    ).toBeInTheDocument();
  });

  it('names the operating company by its exact legal name', () => {
    renderPublic(<AboutPage />);

    // Exact string, from the shared constant rather than retyped here — a test
    // with its own copy of the name cannot catch the two drifting apart.
    expect(COMPANY_LEGAL_NAME).toBe('CRAVION VENTURES (OPC) PRIVATE LIMITED');
    expect(screen.getAllByText(COMPANY_LEGAL_NAME).length).toBeGreaterThan(0);
  });

  it('links to the official company website', () => {
    renderPublic(<AboutPage />);

    const links = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === COMPANY_WEBSITE);

    expect(links.length).toBeGreaterThan(0);
    expect(COMPANY_WEBSITE).toBe('https://www.cravionventures.com');
  });

  it('offers the official sales address, as a mailto', () => {
    renderPublic(<AboutPage />);

    expect(COMPANY_SALES_EMAIL).toBe('sales@cravionventures.com');
    const mail = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === `mailto:${COMPANY_SALES_EMAIL}`);

    expect(mail.length).toBeGreaterThan(0);
  });

  it('says what LeadFlow is, who it is for, and what it addresses', () => {
    renderPublic(<AboutPage />);

    expect(screen.getByText(/lead management and sales operations platform/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /the problem it addresses/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /who it is for/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /who operates leadflow/i })).toBeInTheDocument();
  });

  it('presents the journey as capability evolution, not a company timeline', () => {
    renderPublic(<AboutPage />);

    const heading = screen.getByRole('heading', { name: /how the product took shape/i });
    expect(heading).toBeInTheDocument();

    // An ordered list, because the sequence carries meaning — these capabilities
    // were layered in this order, and a <ul> would throw that away.
    const ordered = document.querySelectorAll('ol > li');
    expect(ordered.length).toBeGreaterThanOrEqual(5);

    // The note that keeps an ordered list from reading as dated history.
    expect(screen.getByText(/not a dated company history/i)).toBeInTheDocument();
    expect(screen.getByText(/no launch dates or milestones are claimed/i)).toBeInTheDocument();

    // Phrasing the guardrails call for: evolution, not dated milestones.
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/LeadFlow was built around/i);
    expect(text).toMatch(/The platform evolved to/i);
  });

  it('claims no dates anywhere in the story', () => {
    renderPublic(<AboutPage />);

    const text = document.body.textContent ?? '';

    /*
     * A year is the specific fabrication this page is most at risk of: "founded
     * in 2023" is the single most natural sentence to add to an About page, and
     * nothing in the repository would support it. 2026 is permitted only
     * because the shared Copyright component renders the current year — and
     * that component is not on this page, so any four-digit year here is new.
     */
    expect(text).not.toMatch(/\b(19|20)\d{2}\b/);
    expect(text).not.toMatch(/\bfounded\b|\bsince\b|\blaunched in\b/i);
  });

  it('makes no claim about customers, revenue, scale or AI', () => {
    renderPublic(<AboutPage />);

    const text = document.body.textContent ?? '';

    // None of these is proven anywhere in this repository.
    expect(text).not.toMatch(/\bAI\b|artificial intelligence|machine learning/);
    expect(text).not.toMatch(/trusted by|customers worldwide|\d+\s*(\+|k)?\s*(customers|businesses|users|companies)/i);
    expect(text).not.toMatch(/revenue|funding|valuation|award|certified|ISO\s*\d/i);
    expect(text).not.toMatch(/enterprise-grade|industry-leading|world-class|market leader/i);
  });

  it('names only capabilities the platform actually has', () => {
    renderPublic(<AboutPage />);

    const text = document.body.textContent ?? '';

    /*
     * Each of these is backed by a module in apps/api/src/modules — leads and
     * follow-ups, contacts and accounts, teams/territories/assignment-rules,
     * omnichannel (WhatsApp, Instagram, Messenger) and reports. The channel
     * names matter most: they are the easiest thing to over-list, and
     * ChannelType in the schema is the authority on which three exist.
     */
    expect(text).toMatch(/WhatsApp/);
    expect(text).toMatch(/Instagram/);
    expect(text).toMatch(/Messenger/);

    // Channels that are NOT built must not be advertised.
    expect(text).not.toMatch(/\bTelegram\b|\bSlack\b|\bWeChat\b|\bLine\b|\bViber\b/);
  });

  it('uses semantic headings in a sensible order', () => {
    renderPublic(<AboutPage />);

    // One h2 per section and h3 for the items inside them; no h1, because the
    // page title belongs to the document, not to a content section.
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(3);

    // Every heading has real text — an empty one is invisible to a screen
    // reader while still occupying the outline.
    for (const heading of screen.getAllByRole('heading')) {
      expect(heading.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it('keeps every call to action keyboard reachable as a real link', () => {
    renderPublic(<AboutPage />);

    const start = screen.getByRole('link', { name: /start free/i });
    const features = screen.getByRole('link', { name: /see the features/i });

    // Anchors, not click-handling divs: reachable by tab and usable by Enter
    // without any JavaScript of ours.
    expect(start).toHaveAttribute('href', '/register');
    expect(features).toHaveAttribute('href', '/features');
  });
});

describe('The public landing page', () => {
  it('states who operates LeadFlow on the first screen', () => {
    renderPublic(<HomePage />);

    /*
     * Ownership used to appear only in the footer, which reads as a vendor
     * credit. This asserts it is in the hero copy — the part somebody sees
     * without scrolling.
     */
    expect(
      screen.getAllByText(/developed and operated by/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(COMPANY_LEGAL_NAME).length).toBeGreaterThan(0);
  });

  it('says what LeadFlow is in the words the positioning uses', () => {
    renderPublic(<HomePage />);

    expect(
      screen.getByText(/customer lead management and sales operations platform/i),
    ).toBeInTheDocument();
  });

  it('offers a route to learn more', () => {
    renderPublic(<HomePage />);

    const about = screen.getAllByRole('link', { name: /about leadflow/i });
    expect(about.length).toBeGreaterThan(0);
    expect(about[0]).toHaveAttribute('href', '/about');
  });

  it('links the company website and the sales address from the hero', () => {
    renderPublic(<HomePage />);

    const site = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === COMPANY_WEBSITE);
    expect(site.length).toBeGreaterThan(0);

    const mail = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === `mailto:${COMPANY_SALES_EMAIL}`);
    expect(mail.length).toBeGreaterThan(0);
  });

  it('renders without authentication', () => {
    // Same argument as the About page: rendered with no AuthProvider, exactly
    // as a first-time visitor gets it.
    renderPublic(<HomePage />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/never lose another lead/i);
  });

  it('still makes no unproven scale or AI claim', () => {
    renderPublic(<HomePage />);

    const text = document.body.textContent ?? '';

    expect(text).not.toMatch(/\bAI\b|artificial intelligence|machine learning/);
    expect(text).not.toMatch(/trusted by|\d+\s*(\+|k)?\s*(customers|businesses|users|companies)/i);
  });
});

/**
 * The startup shell, which Part A added and this work must not disturb.
 *
 * The shell lives in index.html so that something is painted before any
 * JavaScript parses — the fix for the blank screen on Android cold start. It is
 * removed by a `data-booted` attribute set in main.tsx. Asserting on the built
 * artifacts rather than on a rendered component is the only way to catch a
 * regression here, because no component test would notice the shell vanishing.
 */
describe('The Part A startup shell', () => {
  it('is still in index.html, with its boot handoff intact', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

    // Painted immediately: inside #root, with styles inline rather than in a
    // stylesheet the browser has to fetch first.
    expect(html).toMatch(/id="root"/);
    expect(html).toMatch(/<style>/);
    expect(html).toMatch(/data-booted/);

    // Nothing blocking, and nothing remote. A webfont or a hero image here
    // would undo the whole point of the shell.
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"[^>]+href="https?:/);
  });

  it('hands off to the app by setting data-booted before render', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const main = readFileSync(join(process.cwd(), 'src', 'main.tsx'), 'utf8');

    expect(main).toMatch(/setAttribute\(\s*['"]data-booted['"]/);
  });
});
