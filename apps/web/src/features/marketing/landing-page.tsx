import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PLANS,
  PLAN_LIMITS_ENFORCED,
  annualSaving,
  formatPlanPrice,
  type Plan,
} from '../../lib/plans';

/**
 * The public front door.
 *
 * Before this existed, anyone opening the app without a session was bounced
 * straight to a password box with no explanation of what they were signing in
 * to. This page answers "what is it, who is it for, what does it cost".
 *
 * It is deliberately plain HTML and Tailwind — no animation library, no
 * scroll-jacking. A marketing page that is slow to load loses more visitors
 * than a static one loses to boredom.
 */
export function LandingPage(): React.JSX.Element {
  return (
    <div className="min-h-screen bg-white">
      <MarketingHeader />
      <main id="main">
        <Hero />
        <Problem />
        <Features />
        <Pricing />
        <Faq />
        <ClosingCta />
      </main>
      <MarketingFooter />
    </div>
  );
}

function MarketingHeader(): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  const links = [
    { href: '#features', label: 'Features' },
    { href: '#pricing', label: 'Pricing' },
    { href: '#faq', label: 'FAQ' },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      {/* Lets a keyboard user reach the content without tabbing the whole nav. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-slate-900 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-sm font-bold text-white">
            L
          </span>
          <span className="text-base font-semibold tracking-tight text-slate-900">LeadFlow</span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-7 md:flex">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-slate-600 transition hover:text-slate-900"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Link
            to="/login"
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            Sign in
          </Link>
          <Link
            to="/register"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            Get started
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          className="rounded-lg p-2 text-slate-600 transition hover:bg-slate-100 md:hidden"
        >
          <span className="sr-only">{menuOpen ? 'Close menu' : 'Open menu'}</span>
          {menuOpen ? '✕' : '☰'}
        </button>
      </div>

      {menuOpen && (
        <div id="mobile-nav" className="border-t border-slate-100 px-4 py-3 md:hidden">
          <nav aria-label="Main" className="flex flex-col gap-1">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="rounded-lg px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100"
              >
                {link.label}
              </a>
            ))}
            <hr className="my-2 border-slate-100" />
            <Link
              to="/login"
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Sign in
            </Link>
            <Link
              to="/register"
              className="rounded-lg bg-slate-900 px-3 py-2 text-center text-sm font-medium text-white"
            >
              Get started
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}

function Hero(): React.JSX.Element {
  return (
    <section className="mx-auto max-w-6xl px-4 pt-16 pb-14 sm:px-6 sm:pt-24 sm:pb-20">
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-5 inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
          Early access — no card required
        </p>

        <h1 className="text-4xl font-semibold tracking-tight text-balance text-slate-900 sm:text-5xl">
          No lead left behind
        </h1>

        <p className="mx-auto mt-5 max-w-2xl text-lg text-pretty text-slate-600">
          A sales CRM built around one rule: every open lead has an owner, a status and a
          scheduled next step. Not a database your team forgets to update — a list of what to
          do today.
        </p>

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/register"
            className="w-full rounded-lg bg-slate-900 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-800 sm:w-auto"
          >
            Create your workspace
          </Link>
          <a
            href="#features"
            className="w-full rounded-lg border border-slate-300 px-6 py-3 text-center text-sm font-medium text-slate-700 transition hover:bg-slate-50 sm:w-auto"
          >
            See how it works
          </a>
        </div>

        <p className="mt-4 text-xs text-slate-400">
          Free to start · Set up in a couple of minutes
        </p>
      </div>

      <div className="mx-auto mt-14 max-w-4xl">
        <PipelineIllustration />
      </div>
    </section>
  );
}

/**
 * A representative screenshot, drawn rather than photographed.
 *
 * Real screenshots go stale the moment the UI changes and quietly show
 * customers a product that no longer exists. This is built from the same
 * design tokens as the app, so it drifts far more slowly.
 */
function PipelineIllustration(): React.JSX.Element {
  const rows = [
    { name: 'Priya Raman', company: 'Kestrel Interiors', status: 'Overdue', tone: 'danger' },
    { name: 'Daniel Okafor', company: 'Northgate Ltd', status: 'Due today', tone: 'warning' },
    { name: 'Mei Tanaka', company: 'Harbour Foods', status: 'In 2 days', tone: 'calm' },
    { name: 'Sofia Alvarez', company: 'Verde Supply', status: 'In 5 days', tone: 'calm' },
  ];

  const tones: Record<string, string> = {
    danger: 'bg-red-50 text-red-700',
    warning: 'bg-amber-50 text-amber-700',
    calm: 'bg-slate-100 text-slate-600',
  };

  return (
    <div
      role="img"
      aria-label="An illustration of the follow-up list, showing one overdue lead, one due today and two scheduled later."
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60"
    >
      <div className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        <span className="ml-3 text-xs font-medium text-slate-500">Today&rsquo;s follow-ups</span>
      </div>

      <ul className="divide-y divide-slate-100">
        {rows.map((row) => (
          <li key={row.name} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
              {row.name
                .split(' ')
                .map((part) => part[0])
                .join('')}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-900">{row.name}</span>
              <span className="block truncate text-xs text-slate-500">{row.company}</span>
            </span>
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${tones[row.tone]}`}
            >
              {row.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Problem(): React.JSX.Element {
  const points = [
    {
      stat: 'The 4th call',
      body: 'Most deals need several attempts. Most teams stop after one or two, because nothing reminded them.',
    },
    {
      stat: 'The forgotten lead',
      body: 'An enquiry lands, someone means to call back, and it disappears into a spreadsheet nobody reopens.',
    },
    {
      stat: 'The handover',
      body: 'A salesperson leaves and their pipeline goes with them — unless the system knows who owns what.',
    },
  ];

  return (
    <section className="border-y border-slate-200 bg-slate-50 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 className="max-w-2xl text-2xl font-semibold tracking-tight text-balance text-slate-900 sm:text-3xl">
          Leads are rarely lost to competitors. They are lost to silence.
        </h2>

        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {points.map((point) => (
            <div key={point.stat} className="rounded-xl border border-slate-200 bg-white p-6">
              <p className="text-sm font-semibold text-slate-900">{point.stat}</p>
              <p className="mt-2 text-sm text-pretty text-slate-600">{point.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Features(): React.JSX.Element {
  const features = [
    {
      icon: '◷',
      title: 'Follow-ups that cannot be skipped',
      body: 'Every active lead must carry a next step — enforced by the database, not by a habit. Overdue work is the first thing anyone sees.',
    },
    {
      icon: '☰',
      title: 'A pipeline your team keeps current',
      body: 'Stages, priorities and owners. Log a call in one tap, and the next follow-up is scheduled before you leave the screen.',
    },
    {
      icon: '✆',
      title: 'Call and WhatsApp in one tap',
      body: 'Numbers are stored in canonical form, so the dial and message shortcuts work first time — on a phone, from the field.',
    },
    {
      icon: '⚈',
      title: 'Contacts separate from deals',
      body: 'The same customer coming back is a second deal, not a stranger. Duplicates are surfaced for review and merged only when you say so.',
    },
    {
      icon: '▤',
      title: 'Reporting that counts everything',
      body: 'Team performance, conversion and pipeline over any date range, computed on the whole dataset in your timezone — not a sample.',
    },
    {
      icon: '⚇',
      title: 'Safe joiners and leavers',
      body: 'When someone leaves, their live leads and open follow-ups move to a named colleague before their access ends. Nothing is orphaned.',
    },
  ];

  return (
    <section id="features" className="scroll-mt-20 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-balance text-slate-900 sm:text-3xl">
            Everything a small sales team needs, and nothing it does not
          </h2>
          <p className="mt-3 text-pretty text-slate-600">
            Built for teams who sell by talking to people, not by configuring software.
          </p>
        </div>

        <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title}>
              <span
                aria-hidden
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-base text-white"
              >
                {feature.icon}
              </span>
              <h3 className="mt-4 text-base font-semibold text-slate-900">{feature.title}</h3>
              <p className="mt-1.5 text-sm text-pretty text-slate-600">{feature.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing(): React.JSX.Element {
  const [annual, setAnnual] = useState(false);
  const anyAnnual = PLANS.some((plan) => plan.annualPrice !== null);

  return (
    <section id="pricing" className="scroll-mt-20 border-t border-slate-200 bg-slate-50 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-balance text-slate-900 sm:text-3xl">
            Simple pricing
          </h2>
          <p className="mt-3 text-pretty text-slate-600">
            Start free. Move up when your team does.
          </p>
        </div>

        {anyAnnual && (
          <div className="mt-8 flex justify-center">
            <fieldset className="inline-flex rounded-lg bg-white p-1 ring-1 ring-slate-200 ring-inset">
              <legend className="sr-only">Billing period</legend>
              {[
                { value: false, label: 'Monthly' },
                { value: true, label: 'Annual' },
              ].map((option) => (
                <label
                  key={option.label}
                  className={`cursor-pointer rounded-md px-4 py-1.5 text-sm font-medium transition ${
                    annual === option.value
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <input
                    type="radio"
                    name="billing-period"
                    className="sr-only"
                    checked={annual === option.value}
                    onChange={() => setAnnual(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          </div>
        )}

        <div className="mt-10 grid items-start gap-6 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} annual={annual} />
          ))}
        </div>

        {!PLAN_LIMITS_ENFORCED && (
          <p className="mx-auto mt-8 max-w-2xl rounded-lg bg-white px-4 py-3 text-center text-xs text-pretty text-slate-500 ring-1 ring-slate-200 ring-inset">
            LeadFlow is in early access. Plan limits are not currently applied to accounts, and
            no payment is taken at sign-up — the tiers above describe where pricing is heading
            so you can plan, not what you will be charged today.
          </p>
        )}
      </div>
    </section>
  );
}

function PlanCard({ plan, annual }: { plan: Plan; annual: boolean }): React.JSX.Element {
  const price = annual && plan.annualPrice !== null ? plan.annualPrice : plan.monthlyPrice;
  const saving = annualSaving(plan);
  const period = plan.monthlyPrice === 0 ? '' : annual ? '/year' : '/month';

  return (
    <div
      className={`relative rounded-2xl bg-white p-6 sm:p-7 ${
        plan.highlighted
          ? 'shadow-xl shadow-slate-200/70 ring-2 ring-slate-900'
          : 'ring-1 ring-slate-200'
      }`}
    >
      {plan.highlighted && (
        <span className="absolute -top-3 left-6 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-medium text-white">
          Most popular
        </span>
      )}

      <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
      <p className="mt-1 text-sm text-slate-500">{plan.tagline}</p>

      <p className="mt-5 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tracking-tight text-slate-900">
          {formatPlanPrice(price)}
        </span>
        {period && <span className="text-sm text-slate-500">{period}</span>}
      </p>

      {annual && saving !== null && (
        <p className="mt-1 text-xs font-medium text-emerald-700">Save {saving}% paid annually</p>
      )}
      {!annual && plan.monthlyPrice > 0 && (
        <p className="mt-1 text-xs text-slate-400">per organization, not per user</p>
      )}

      <Link
        to={plan.cta.to}
        className={`mt-6 block rounded-lg px-4 py-2.5 text-center text-sm font-medium transition ${
          plan.highlighted
            ? 'bg-slate-900 text-white hover:bg-slate-800'
            : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
        }`}
      >
        {plan.cta.label}
      </Link>

      <ul className="mt-6 space-y-2.5">
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-2.5 text-sm text-slate-600">
            <span aria-hidden className="mt-0.5 shrink-0 text-emerald-600">
              ✓
            </span>
            <span className="text-pretty">{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Faq(): React.JSX.Element {
  const questions = [
    {
      q: 'Is my data separate from other companies?',
      a: 'Yes. Every record belongs to exactly one organization, and that boundary is enforced in the database layer rather than by each query remembering to filter — plus a test suite whose whole job is trying to cross it.',
    },
    {
      q: 'What happens when a salesperson leaves?',
      a: 'You are shown exactly what they are carrying — live leads and open follow-ups — and asked to name a colleague to take it over. Their access ends only after the handover, and their past activity stays recorded under their name.',
    },
    {
      q: 'Can I import my existing leads?',
      a: 'Yes. Upload a CSV, confirm which column means what, and review a validated preview with duplicates flagged before anything is created.',
    },
    {
      q: 'Do you work outside my country?',
      a: 'Each organization sets its own timezone, currency, locale and country. Reports use your working days, amounts use your currency, and phone numbers are read the way your country writes them.',
    },
    {
      q: 'What do I pay today?',
      a: 'Nothing. LeadFlow is in early access, sign-up takes no card, and plan limits are not currently applied. The pricing above is published so you can plan ahead.',
    },
  ];

  return (
    <section id="faq" className="scroll-mt-20 py-16 sm:py-24">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          Questions
        </h2>

        <dl className="mt-8 divide-y divide-slate-200 border-t border-slate-200">
          {questions.map((item) => (
            <div key={item.q} className="py-5">
              <dt className="text-base font-medium text-slate-900">{item.q}</dt>
              <dd className="mt-2 text-sm text-pretty text-slate-600">{item.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function ClosingCta(): React.JSX.Element {
  return (
    <section className="border-t border-slate-200 bg-slate-900 py-16 sm:py-20">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-balance text-white sm:text-3xl">
          Stop losing leads to silence
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-pretty text-slate-300">
          Create a workspace, invite your team, and see today&rsquo;s follow-ups in a couple of
          minutes.
        </p>
        <Link
          to="/register"
          className="mt-7 inline-block rounded-lg bg-white px-6 py-3 text-sm font-medium text-slate-900 transition hover:bg-slate-100"
        >
          Create your workspace
        </Link>
      </div>
    </section>
  );
}

function MarketingFooter(): React.JSX.Element {
  return (
    <footer className="border-t border-slate-200 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 sm:px-6 md:flex-row">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-900 text-xs font-bold text-white">
            L
          </span>
          <span className="text-sm font-medium text-slate-900">LeadFlow</span>
          <span className="text-sm text-slate-400">— No lead left behind</span>
        </div>

        <nav aria-label="Footer" className="flex items-center gap-6 text-sm text-slate-500">
          <a href="#features" className="transition hover:text-slate-900">
            Features
          </a>
          <a href="#pricing" className="transition hover:text-slate-900">
            Pricing
          </a>
          <Link to="/login" className="transition hover:text-slate-900">
            Sign in
          </Link>
        </nav>
      </div>
    </footer>
  );
}
