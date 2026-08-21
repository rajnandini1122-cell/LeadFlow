import { Link } from 'react-router-dom';
import { usePageMeta } from '../../lib/use-page-meta';
import { SectionHeading } from './marketing-layout';
import { PricingTable } from './pricing-table';

const FAQ = [
  {
    q: 'What do I pay today?',
    a: 'Nothing. LeadFlow is in early access, sign-up takes no card, and no payment is collected. The plans above are published so you can plan ahead.',
  },
  {
    q: 'Are the limits enforced?',
    a: 'Not currently. The limits shown describe the intended shape of each tier; the application does not yet apply them to accounts. When that changes it will be announced rather than switched on quietly.',
  },
  {
    q: 'Is pricing per user?',
    a: 'No. Each plan is priced per organization, with a stated number of team members included.',
  },
  {
    q: 'What happens to my data if I stop paying?',
    a: 'Your records remain yours. Nothing is deleted when a subscription lapses — access is what changes, and export is available while you have access.',
  },
  {
    q: 'Can I change plan later?',
    a: 'Yes, from inside the app. Changing plan takes effect immediately and is recorded in your organization’s audit trail.',
  },
  {
    q: 'Is my data separate from other companies?',
    a: 'Yes. Every record belongs to exactly one organization, and that boundary is enforced in the database layer rather than by each query remembering to filter — with a test suite whose whole purpose is trying to cross it.',
  },
];

export function PricingPage(): React.JSX.Element {
  usePageMeta(
    'Pricing — LeadFlow',
    'Simple per-organization pricing. Start free while LeadFlow is in early access.',
  );

  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pt-16 pb-16 sm:px-6 sm:pt-20">
        <SectionHeading
          title="Simple pricing"
          subtitle="Priced per organization, not per user. Start free and move up when your team does."
          centered
        />
        <PricingTable />
      </section>

      <section className="border-t border-slate-200 bg-slate-50 py-16">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Questions</h2>

          <dl className="mt-8 divide-y divide-slate-200 border-t border-slate-200">
            {FAQ.map((item) => (
              <div key={item.q} className="py-5">
                <dt className="text-base font-medium text-slate-900">{item.q}</dt>
                <dd className="mt-2 text-sm text-pretty text-slate-600">{item.a}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/register"
              className="w-full rounded-lg bg-slate-900 px-6 py-3 text-center text-sm font-medium text-white transition hover:bg-slate-800 sm:w-auto"
            >
              Start free
            </Link>
            <Link
              to="/contact"
              className="w-full rounded-lg border border-slate-300 px-6 py-3 text-center text-sm font-medium text-slate-700 transition hover:bg-slate-50 sm:w-auto"
            >
              Ask a question
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
