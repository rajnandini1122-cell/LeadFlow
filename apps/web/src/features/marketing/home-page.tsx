import { Link } from 'react-router-dom';
import { usePageMeta } from '../../lib/use-page-meta';
import { SectionHeading } from './marketing-layout';
import { PricingTable } from './pricing-table';
import { SALES_EMAIL } from './contact-page';

/**
 * The homepage.
 *
 * Every claim below describes something that exists and is tested. No
 * "AI-powered", no integrations that are not built, no "enterprise security" —
 * a marketing page is a promise, and the ones that cost you a customer are the
 * ones discovered after they have signed up.
 */
export function HomePage(): React.JSX.Element {
  usePageMeta(
    'LeadFlow — Sales CRM for small teams',
    'Capture leads, assign ownership and schedule follow-ups so nothing is forgotten. Built for small sales teams.',
  );

  return (
    <>
      <Hero />
      <Problems />
      <Benefits />
      <FeatureSummary />
      <HowItWorks />
      <Ownership />
      <PricingPreview />
      <ContactCta />
      <ClosingCta />
    </>
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
          Never lose another lead
        </h1>

        <p className="mx-auto mt-5 max-w-2xl text-lg text-pretty text-slate-600">
          LeadFlow keeps every enquiry owned, scheduled and visible. Capture leads, assign them to
          a salesperson, log every call and message, and see exactly what is overdue — before the
          customer goes quiet.
        </p>

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/register"
            className="w-full rounded-lg bg-slate-900 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-800 sm:w-auto"
          >
            Start free
          </Link>
          <Link
            to="/pricing"
            className="w-full rounded-lg border border-slate-300 px-6 py-3 text-center text-sm font-medium text-slate-700 transition hover:bg-slate-50 sm:w-auto"
          >
            View pricing
          </Link>
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
 * A representative screenshot, drawn rather than captured.
 *
 * Real screenshots go stale the moment the UI changes and quietly show
 * customers a product that no longer exists. This uses the same design tokens
 * as the app, so it drifts far more slowly.
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
      aria-label="The follow-up list, showing one overdue lead, one due today and two scheduled later."
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

function Problems(): React.JSX.Element {
  const problems = [
    'An enquiry arrives, someone means to call back, and it is never seen again.',
    'Nobody can say which follow-ups are overdue right now.',
    'The spreadsheet has three versions and two of them are out of date.',
    'The same customer exists twice under slightly different spellings.',
    'A manager cannot tell what the team actually did this week.',
    'A salesperson leaves and their pipeline leaves with them.',
  ];

  return (
    <section className="border-y border-slate-200 bg-slate-50 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          title="Leads are rarely lost to competitors. They are lost to silence."
          subtitle="Most of these are not sales problems. They are record-keeping problems that become sales problems."
        />

        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {problems.map((problem) => (
            <li
              key={problem}
              className="flex gap-3 rounded-xl border border-slate-200 bg-white p-5 text-sm text-pretty text-slate-700"
            >
              <span aria-hidden className="shrink-0 text-slate-300">
                ✕
              </span>
              {problem}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Benefits(): React.JSX.Element {
  const benefits = [
    {
      title: 'One place for every lead and contact',
      body: 'Leads, the people behind them, and the full history of what was said — not spread across a spreadsheet, a phone and someone’s memory.',
    },
    {
      title: 'Never miss a follow-up',
      body: 'Every active lead must carry a next step. That rule is enforced by the database, not by a habit, so a lead genuinely cannot be left with nothing scheduled.',
    },
    {
      title: 'Clear ownership of every lead',
      body: 'One named owner, always. Reassignment is a recorded action rather than a quiet edit, so nobody has to guess whose job a customer is.',
    },
    {
      title: 'A real record of every conversation',
      body: 'Calls, notes and WhatsApp messages land on the lead’s timeline as they happen, attributed to whoever did the work.',
    },
    {
      title: 'Reporting you can act on',
      body: 'Conversion, pipeline and per-person performance over any date range, computed across your whole dataset in your organization’s timezone.',
    },
    {
      title: 'Your data stays yours',
      body: 'Each organization’s records are isolated at the database layer, and a departing employee’s leads stay with the business.',
    },
  ];

  return (
    <section className="py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          title="What you get instead"
          subtitle="Everything below is built and in use today."
        />

        <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {benefits.map((benefit) => (
            <div key={benefit.title}>
              <h3 className="text-base font-semibold text-slate-900">{benefit.title}</h3>
              <p className="mt-1.5 text-sm text-pretty text-slate-600">{benefit.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureSummary(): React.JSX.Element {
  const groups = [
    { title: 'Lead management', items: ['Create, edit and archive', 'Status lifecycle', 'Reassignment'] },
    { title: 'Contacts', items: ['Shared contact records', 'Duplicate detection', 'Reviewed merge'] },
    { title: 'Follow-ups', items: ['Schedule and complete', 'Reschedule and cancel', 'Overdue visibility'] },
    { title: 'Activities', items: ['Notes and call logging', 'WhatsApp logging', 'Full timeline'] },
    { title: 'Team', items: ['Invitations', 'Roles and permissions', 'Safe offboarding'] },
    { title: 'Reporting', items: ['Dashboard', 'Daily report', 'Team performance'] },
  ];

  return (
    <section className="border-t border-slate-200 bg-slate-50 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading title="What is included" />

        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((group) => (
            <div key={group.title} className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-slate-900">{group.title}</h3>
              <ul className="mt-3 space-y-1.5">
                {group.items.map((item) => (
                  <li key={item} className="flex gap-2 text-sm text-slate-600">
                    <span aria-hidden className="text-emerald-600">
                      ✓
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center">
          <Link
            to="/features"
            className="text-sm font-medium text-slate-700 underline underline-offset-4 transition hover:text-slate-900"
          >
            See all features
          </Link>
        </div>
      </div>
    </section>
  );
}

function HowItWorks(): React.JSX.Element {
  const steps = [
    { title: 'Create your organization', body: 'Sign up and your workspace exists. No setup call.' },
    { title: 'Invite your sales team', body: 'Send invitations and give each person a role that fits what they do.' },
    { title: 'Add or import leads', body: 'Enter them as they arrive, or bring a CSV across with a preview before anything is created.' },
    { title: 'Assign and schedule', body: 'Give every lead an owner and a next step. The system will not let an active lead have neither.' },
    { title: 'Track and review', body: 'Log calls as they happen and read the daily report each morning.' },
  ];

  return (
    <section className="py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading title="How it works" centered />

        <ol className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-5">
          {steps.map((step, index) => (
            <li key={step.title}>
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
                {index + 1}
              </span>
              <h3 className="mt-3 text-sm font-semibold text-slate-900">{step.title}</h3>
              <p className="mt-1 text-sm text-pretty text-slate-600">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/**
 * Lead ownership when someone leaves.
 *
 * Every sentence here describes behaviour that exists and is covered by the
 * offboarding test suite — the handover is refused without a named successor,
 * activity attribution is preserved, and the action is recorded.
 */
function Ownership(): React.JSX.Element {
  return (
    <section className="border-y border-slate-200 bg-slate-900 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-balance text-white sm:text-3xl">
              When a salesperson leaves, their customers stay
            </h2>
            <p className="mt-4 text-pretty text-slate-300">
              Customer relationships belong to the business, not to whoever happened to be
              handling them. LeadFlow makes that true in practice rather than in principle.
            </p>
          </div>

          <ul className="space-y-4">
            {[
              'Before anyone is removed, you are shown exactly what they hold — active leads and open follow-ups.',
              'You must name a colleague to take that work over. The removal is refused until you do.',
              'Their live leads and open follow-ups move across; nothing is left pointing at an account that no longer works.',
              'Closed deals keep their original owner, so commission and performance history stay accurate.',
              'Every call they logged stays attributed to them. The record of who did the work is not rewritten.',
              'The whole handover is recorded, with who did it and how much moved.',
            ].map((point) => (
              <li key={point} className="flex gap-3 text-sm text-pretty text-slate-200">
                <span aria-hidden className="mt-0.5 shrink-0 text-emerald-400">
                  ✓
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function PricingPreview(): React.JSX.Element {
  return (
    <section className="py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          title="Simple pricing"
          subtitle="Start free. Move up when your team does."
          centered
        />
        <PricingTable compact />

        <div className="mt-8 text-center">
          <Link
            to="/pricing"
            className="text-sm font-medium text-slate-700 underline underline-offset-4 transition hover:text-slate-900"
          >
            Compare plans in detail
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * For visitors who want a person rather than a signup form.
 *
 * Placed before the final call to action deliberately: someone still deciding
 * has a question, and sending them to a registration form instead of an answer
 * loses them.
 */
function ContactCta(): React.JSX.Element {
  return (
    <section className="border-t border-slate-200 bg-slate-50 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-balance text-slate-900 sm:text-3xl">
              Not sure it fits your team?
            </h2>
            <p className="mt-3 text-pretty text-slate-600">
              Tell us how you sell today and we will give you a straight answer about whether
              LeadFlow helps — including when it does not. A real person reads every message.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row lg:justify-end">
            <Link
              to="/contact"
              className="rounded-lg bg-slate-900 px-6 py-3 text-center text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Contact us
            </Link>
            <a
              href={`mailto:${SALES_EMAIL}`}
              className="rounded-lg border border-slate-300 bg-white px-6 py-3 text-center text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              {SALES_EMAIL}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function ClosingCta(): React.JSX.Element {
  return (
    <section className="border-t border-slate-200 bg-slate-50 py-16 sm:py-20">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-balance text-slate-900 sm:text-3xl">
          Stop losing leads to silence
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-pretty text-slate-600">
          Create a workspace, invite your team, and see today&rsquo;s follow-ups in a couple of
          minutes.
        </p>
        <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/register"
            className="w-full rounded-lg bg-slate-900 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-800 sm:w-auto"
          >
            Start free
          </Link>
          <Link
            to="/contact"
            className="w-full rounded-lg border border-slate-300 bg-white px-6 py-3 text-center text-sm font-medium text-slate-700 transition hover:bg-slate-50 sm:w-auto"
          >
            Talk to us first
          </Link>
        </div>
      </div>
    </section>
  );
}
