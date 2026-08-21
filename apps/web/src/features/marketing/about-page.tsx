import { Link } from 'react-router-dom';
import { usePageMeta } from '../../lib/use-page-meta';
import { SectionHeading } from './marketing-layout';

/**
 * About.
 *
 * Deliberately about the product's design decisions rather than an invented
 * company story. There is no funding round, no team of forty and no founding
 * anecdote to tell — writing one would be the first false thing on the site.
 */
export function AboutPage(): React.JSX.Element {
  usePageMeta(
    'About — LeadFlow',
    'Why LeadFlow works the way it does: one rule, enforced, and data that belongs to the business.',
  );

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
    <>
      <section className="mx-auto max-w-6xl px-4 pt-16 pb-14 sm:px-6 sm:pt-20">
        <SectionHeading
          title="Why LeadFlow works the way it does"
          subtitle="A short account of the decisions behind the product, so you can judge whether they match how your team sells."
        />
      </section>

      <section className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <div className="space-y-10">
          {principles.map((principle) => (
            <div key={principle.title}>
              <h2 className="text-lg font-semibold text-slate-900">{principle.title}</h2>
              <p className="mt-2 text-pretty text-slate-600">{principle.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-slate-200 bg-slate-50 py-16">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">
            Who it is for
          </h2>
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
        </div>
      </section>
    </>
  );
}
