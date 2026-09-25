import { Link } from 'react-router-dom';
import {
  COMPANY_LEGAL_NAME,
  COMPANY_SALES_EMAIL,
  COMPANY_WEBSITE,
  OperatedBy,
} from '../../components/brand';
import { usePageMeta } from '../../lib/use-page-meta';
import { SectionHeading } from './marketing-layout';

/**
 * About.
 *
 * Two jobs: say plainly what LeadFlow is and who operates it, and explain the
 * decisions behind the product so a visitor can judge whether they match how
 * their team sells.
 *
 * WHAT IS DELIBERATELY ABSENT, and why. There is no founding anecdote, no dated
 * milestone, no customer count, no revenue figure, no team size and no award.
 * None of those is verified anywhere in this repository, and an invented one
 * would be the first false thing on the site — on the page whose whole purpose
 * is to be believed. Every capability named below exists as a module in the API
 * today; the journey section carries an explicit note that it describes the
 * product's capability layering rather than a corporate timeline, because
 * without that note an ordered list reads as dated history.
 *
 * Company facts come from the constants in components/brand, never retyped, so
 * the legal name, website and sales address cannot drift between here, the
 * footer and the application.
 */
export function AboutPage(): React.JSX.Element {
  usePageMeta(
    'About — LeadFlow',
    `LeadFlow is a customer lead management and sales operations platform developed and operated by ${COMPANY_LEGAL_NAME}.`,
  );

  return (
    <>
      <WhatItIs />
      <TheProblem />
      <Journey />
      <Philosophy />
      <WhoItIsFor />
      <Ownership />
    </>
  );
}

/**
 * The opening answer: what this is, and who runs it.
 *
 * Ownership appears here rather than only in the footer. Somebody deciding
 * whether to put their pipeline into a product is entitled to know who operates
 * it without hunting for it.
 */
function WhatItIs(): React.JSX.Element {
  return (
    <section className="mx-auto max-w-6xl px-4 pt-16 pb-14 sm:px-6 sm:pt-20">
      <SectionHeading
        title="A lead management platform, built and run by one company"
        subtitle="LeadFlow is a customer lead management and sales operations platform. It is developed and operated by CRAVION Ventures."
      />

      <div className="mt-8 max-w-3xl space-y-4 text-pretty text-slate-600">
        <p>
          LeadFlow helps an organization capture enquiries, organize the people behind them,
          assign work to the right salesperson, keep follow-ups scheduled, and see what is
          actually happening across the team. It is one product with one purpose: no lead left
          behind.
        </p>
        <p>
          It is developed and operated by{' '}
          <a
            href={COMPANY_WEBSITE}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 transition hover:decoration-slate-900"
          >
            {COMPANY_LEGAL_NAME}
          </a>
          . The same company builds the product, runs the service and answers the email — there
          is no reseller in between.
        </p>
      </div>
    </section>
  );
}

/**
 * The problem, stated as the thing that goes wrong rather than as a market
 * opportunity. No figures, because no research is cited in this repository.
 */
function TheProblem(): React.JSX.Element {
  return (
    <section className="border-t border-slate-200 bg-slate-50 py-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          The problem it addresses
        </h2>

        <div className="mt-4 space-y-4 text-pretty text-slate-600">
          <p>
            Most enquiries are not lost to a competitor. They are lost to silence — nobody was
            clearly responsible, no next step was ever scheduled, and by the time anyone
            noticed, the customer had moved on. A spreadsheet records what happened; it does not
            tell anybody what to do next, and it cannot refuse to let a lead go quiet.
          </p>
          <p>
            That failure is quiet, which is what makes it expensive. Nothing errors. The
            pipeline still looks full. The only symptom is a conversation that stopped, and by
            then there is nothing to act on.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * How the product came to be shaped the way it is.
 *
 * Every stage names a capability that exists in the API today — the modules are
 * given in the source comments beside each item. Undated on purpose: the
 * repository contains no verified dates for any of this, and inventing them
 * would turn an honest account of what was built into a fabricated history.
 */
function Journey(): React.JSX.Element {
  const stages = [
    {
      title: 'A problem worth fixing properly',
      body: 'Enquiries were arriving faster than any spreadsheet could keep honest. Ownership was implied rather than recorded, and the next step lived in somebody’s memory. The gap was not reporting — it was that nothing in the system could insist on an owner and a next action.',
    },
    {
      // Proven by: modules/leads, modules/follow-ups, and the
      // leads_active_requires_followup CHECK constraint in the schema.
      title: 'LeadFlow was built around one enforced rule',
      body: 'Every active lead must have an owner and a scheduled next step. That is a database constraint rather than a reminder, so no import, bulk edit or future integration can produce a lead with nothing scheduled. The lead lifecycle, the follow-up scheduling and the activity timeline were built around keeping that rule true.',
    },
    {
      // Proven by: modules/contacts, modules/accounts, modules/products.
      title: 'The platform evolved to separate the person from the deal',
      body: 'A returning customer should not arrive as a stranger. Contacts, company accounts and product interest became records of their own, so a closed deal does not take the relationship’s history with it — and a duplicate is something you review and merge deliberately, never something the system silently decides.',
    },
    {
      // Proven by: modules/teams, modules/territories, modules/assignment-rules
      // (priority-ordered rules with a round-robin rotation cursor).
      title: 'Then to handle teams rather than individuals',
      body: 'Teams, territories and rule-based assignment followed, because a growing group stops being a list of names. Incoming work can be routed by rule and rotated across a team, roles decide who sees what, and removing somebody who holds live work requires naming a successor first.',
    },
    {
      // Proven by: modules/omnichannel (ChannelType = WHATSAPP | FACEBOOK |
      // INSTAGRAM; providers/whatsapp, providers/messenger) and
      // modules/integrations/website for signed form intake.
      title: 'And to bring the conversations into one place',
      body: 'Enquiries do not only arrive by form. Conversations from WhatsApp, Instagram and Messenger are captured against the lead they belong to, alongside a signed intake route for submissions from your own website, so the thread and the pipeline record are not two separate stories.',
    },
    {
      // Proven by: modules/reports (overview, daily, team performance),
      // modules/dashboard.
      title: 'Operational visibility is where it continues',
      body: 'Dashboards, a daily report and per-person performance came from the same requirement as the rest: a manager should be able to see what is overdue and what is moving without asking anybody. This is the part still actively developing.',
    },
  ];

  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <SectionHeading
        title="How the product took shape"
        subtitle="Each stage describes a capability the platform gained, and roughly the order the problems were solved in."
      />

      {/*
        The honesty note, and it is not a disclaimer for its own sake.
        An ordered list of stages reads as a dated corporate timeline whether or
        not dates are printed. This says plainly that it is not one, which is
        cheaper than being asked later which year any of it happened in.
      */}
      <p className="mt-4 max-w-2xl text-sm text-slate-500">
        This describes how the product’s capabilities were layered, not a dated company history.
        No launch dates or milestones are claimed.
      </p>

      <ol className="mt-10 max-w-3xl space-y-8">
        {stages.map((stage, index) => (
          <li key={stage.title} className="flex gap-4 sm:gap-6">
            {/*
              The number is real information here: these are sequential, and the
              order is the point. Marked aria-hidden because the ordered list
              already conveys position to a screen reader, and hearing "1" twice
              is noise.
            */}
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500"
            >
              {index + 1}
            </span>
            <div>
              <h3 className="font-semibold text-slate-900">{stage.title}</h3>
              <p className="mt-1.5 text-pretty text-slate-600">{stage.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The product decisions, kept because they are the substance of the page. */
function Philosophy(): React.JSX.Element {
  const principles = [
    {
      title: 'One rule, enforced rather than encouraged',
      body: 'Every active lead must have an owner and a scheduled next step. That is a database constraint, not a reminder — no import, bulk edit or future integration can produce a lead with nothing scheduled. Most CRMs make this a best practice and then watch it erode.',
    },
    {
      title: 'The record of what happened is not rewritten',
      body: 'Reassigning a lead moves who is responsible from now on. It does not change who made the calls last month. Archiving is always a soft delete, because the history of a relationship is the part worth keeping.',
    },
    {
      title: 'Data belongs to the organization',
      body: 'A salesperson leaving is an operational event, not a data loss event. Their live work is handed to a named colleague before their access ends, and the handover is refused until someone is named.',
    },
    {
      title: 'Isolation is structural',
      body: 'Tenant separation is applied at the data-access layer, so it holds whether or not each individual query remembered to filter. It fails closed: code without a tenant context refuses to run rather than running unscoped.',
    },
    {
      title: 'Say what is true',
      body: 'The features page lists what exists and labels what does not. The pricing page says plainly that limits are not yet applied. A claim discovered to be false after signing up costs more than the sale it won.',
    },
  ];

  return (
    <section className="border-t border-slate-200 bg-slate-50 py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          title="Why LeadFlow works the way it does"
          subtitle="The decisions behind the product, so you can judge whether they match how your team sells."
        />

        <div className="mt-10 max-w-3xl space-y-10">
          {principles.map((principle) => (
            <div key={principle.title}>
              <h3 className="text-lg font-semibold text-slate-900">{principle.title}</h3>
              <p className="mt-2 text-pretty text-slate-600">{principle.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WhoItIsFor(): React.JSX.Element {
  return (
    <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h2 className="text-xl font-semibold tracking-tight text-slate-900">Who it is for</h2>
      <p className="mt-3 text-pretty text-slate-600">
        Small and growing sales teams who sell by talking to people — where enquiries arrive
        steadily, several conversations are needed to close, and the current system is a
        spreadsheet plus somebody&rsquo;s memory. It is not a marketing automation platform, a
        help desk, or an enterprise sales suite.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link
          to="/register"
          className="w-full rounded-lg bg-slate-900 px-6 py-3 text-center text-sm font-medium text-white transition hover:bg-slate-800 sm:w-auto"
        >
          Start free
        </Link>
        <Link
          to="/features"
          className="w-full rounded-lg border border-slate-300 px-6 py-3 text-center text-sm font-medium text-slate-700 transition hover:bg-slate-50 sm:w-auto"
        >
          See the features
        </Link>
      </div>
    </section>
  );
}

/**
 * Who operates the platform, stated once more as a section of its own.
 *
 * The footer carries the same notice on every page; this is the page where
 * somebody has come looking for it, so it gets a heading and the website link
 * rather than six-point type at the bottom.
 */
function Ownership(): React.JSX.Element {
  return (
    /*
     * Deliberately light rather than the dark treatment used elsewhere on the
     * public site. `OperatedBy` is reused here verbatim, and it carries its own
     * slate-500 text with a slate-600 link — on a slate-900 ground that is a
     * contrast failure, and overriding it by appending a colour class is not
     * reliable either, since same-specificity Tailwind utilities are resolved by
     * stylesheet order rather than by attribute order. Keeping the section light
     * lets the shared component render exactly as designed.
     */
    <section className="border-t border-slate-200 bg-slate-50 py-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          Who operates LeadFlow
        </h2>

        <p className="mt-4 text-pretty text-slate-600">
          LeadFlow is developed and operated by{' '}
          <span className="font-medium text-slate-900">{COMPANY_LEGAL_NAME}</span>. Product
          development, the running service and customer enquiries are all handled by the same
          company.
        </p>

        <dl className="mt-8 grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
              Company website
            </dt>
            <dd className="mt-2 text-sm">
              <a
                href={COMPANY_WEBSITE}
                target="_blank"
                rel="noreferrer"
                className="font-medium break-words text-slate-900 underline decoration-slate-300 underline-offset-2 transition hover:decoration-slate-900"
              >
                www.cravionventures.com
              </a>
            </dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
              Enquiries
            </dt>
            <dd className="mt-2 text-sm">
              <a
                href={`mailto:${COMPANY_SALES_EMAIL}`}
                className="font-medium break-words text-slate-900 underline decoration-slate-300 underline-offset-2 transition hover:decoration-slate-900"
              >
                {COMPANY_SALES_EMAIL}
              </a>
            </dd>
          </div>
        </dl>

        {/*
          Reuses the shared notice rather than restating it, so this page cannot
          describe the operator differently from every other page's footer.
        */}
        <div className="mt-8 border-t border-slate-200 pt-6">
          <OperatedBy />
        </div>
      </div>
    </section>
  );
}
