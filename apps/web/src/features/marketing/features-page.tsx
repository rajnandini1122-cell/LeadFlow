import { Link } from 'react-router-dom';
import { usePageMeta } from '../../lib/use-page-meta';
import { SectionHeading } from './marketing-layout';

interface FeatureGroup {
  id: string;
  title: string;
  summary: string;
  items: { name: string; detail: string }[];
}

/**
 * Every feature listed here exists in the product today.
 *
 * Anything planned but unbuilt belongs in UPCOMING below, visibly labelled.
 * Mixing the two is how a customer signs up for something that is not there.
 */
const GROUPS: FeatureGroup[] = [
  {
    id: 'leads',
    title: 'Lead management',
    summary: 'The pipeline, and the rules that keep it honest.',
    items: [
      { name: 'Create and edit leads', detail: 'Contact details, source, product interest, estimated value and priority.' },
      { name: 'Status lifecycle', detail: 'New through to won or lost, with transitions checked — a won deal cannot be quietly reopened, and marking one lost requires a reason.' },
      { name: 'Reassignment', detail: 'Change the owner of a lead. The new owner must be an active member of your organization, and the change is recorded on the timeline.' },
      { name: 'Archive', detail: 'Soft delete only. Archiving a lead never destroys the calls and quotations attached to it.' },
      { name: 'Search and filter', detail: 'By name, company, mobile or status, across the whole pipeline rather than the page you are looking at.' },
    ],
  },
  {
    id: 'contacts',
    title: 'Contacts',
    summary: 'The person, kept separate from the deal.',
    items: [
      { name: 'Shared contact records', detail: 'A returning customer is a second lead on the same contact, so their history survives a closed deal.' },
      { name: 'Duplicate detection', detail: 'Matches on exact mobile or email only. Names and companies are deliberately not matched on, because a false positive merges two real customers.' },
      { name: 'Reviewed merge', detail: 'Nothing merges automatically. You confirm the pair and choose which value wins for each conflicting field.' },
      { name: 'Nothing is deleted', detail: 'The absorbed record is kept, pointing at its replacement, so an old link still resolves.' },
    ],
  },
  {
    id: 'follow-ups',
    title: 'Follow-ups',
    summary: 'The part that stops leads going quiet.',
    items: [
      { name: 'Every active lead has a next step', detail: 'Enforced by a database constraint, so no import, integration or bulk edit can leave one without.' },
      { name: 'Schedule, complete, reschedule, cancel', detail: 'Each with an outcome recorded, so the history of attempts is visible rather than just the latest date.' },
      { name: 'Overdue, due today, upcoming', detail: 'Bucketed in your organization’s timezone, not the server’s and not the viewer’s.' },
      { name: 'Completing schedules the next', detail: 'Closing a follow-up prompts for the next one before you leave the screen.' },
    ],
  },
  {
    id: 'activities',
    title: 'Activities and timeline',
    summary: 'What was actually said, and by whom.',
    items: [
      { name: 'Call logging', detail: 'Completed, not answered, or call back later — in one tap from the lead.' },
      { name: 'WhatsApp and dial shortcuts', detail: 'Numbers are stored in canonical E.164 form, so the shortcuts work first time from a phone.' },
      { name: 'Notes', detail: 'Free text on the timeline, attributed and timestamped.' },
      { name: 'System events', detail: 'Status changes, assignments and merges appear automatically. Clients cannot fabricate them.' },
    ],
  },
  {
    id: 'team',
    title: 'Team management',
    summary: 'Who can do what, and what happens when they leave.',
    items: [
      { name: 'Email invitations', detail: 'Invite by email with a role; the link expires and can be resent or revoked.' },
      { name: 'Roles and permissions', detail: 'Owner, admin, manager and sales rep. Every boundary is enforced by the API, never by hiding a button.' },
      { name: 'Lead visibility', detail: 'A sales rep sees their own leads; managers and above see the team’s.' },
      { name: 'Safe offboarding', detail: 'Removing or deactivating someone who holds live work requires naming a successor first.' },
      { name: 'Administrator protection', detail: 'The last remaining administrator cannot be removed, demoted or deactivated, so an organization cannot be left unmanageable.' },
      { name: 'Audit trail', detail: 'Role changes, handovers, removals and bulk reassignments, with who did them.' },
    ],
  },
  {
    id: 'reporting',
    title: 'Reporting',
    summary: 'Numbers computed across everything, not a sample.',
    items: [
      { name: 'Dashboard', detail: 'Overdue work first, then pipeline value, conversion and stage breakdown.' },
      { name: 'Daily report', detail: 'What came in, what was contacted, what closed — printable for a morning huddle.' },
      { name: 'Team performance', detail: 'Per-person leads, conversion, won value and follow-up completion rate.' },
      { name: 'Date ranges', detail: 'Today, yesterday, this or last week, this or last month, or any custom range — with each metric stating which date it is measured against.' },
      { name: 'Timezone correct', detail: 'Day boundaries use your organization’s timezone, including across daylight-saving changes.' },
    ],
  },
  {
    id: 'import',
    title: 'CSV import',
    summary: 'Bring an existing list across without guessing.',
    items: [
      { name: 'Column mapping', detail: 'The importer proposes a mapping from your header row; you confirm or correct it before anything runs.' },
      { name: 'Preview with validation', detail: 'Per-row errors and duplicate flags shown before a single lead is created.' },
      { name: 'Duplicate handling', detail: 'Rows matching an existing active lead are skipped by default rather than doubling your pipeline.' },
      { name: 'Per-row results', detail: 'Created, skipped and failed counts, with the reason for each failure.' },
    ],
  },
  {
    id: 'security',
    title: 'Accounts and security',
    summary: 'The parts that protect the data.',
    items: [
      { name: 'Multi-tenant isolation', detail: 'Each organization’s records are separated at the database layer, not by each query remembering to filter.' },
      { name: 'Password reset and change', detail: 'Self-service reset by email, and password change from inside the app.' },
      { name: 'Session management', detail: 'See where you are signed in and revoke a session; changing your password signs other devices out.' },
      { name: 'Per-organization settings', detail: 'Timezone, currency, locale, country and your own lead source list.' },
    ],
  },
];

/** Planned, not built. Listed separately and labelled, never mixed above. */
const UPCOMING = [
  'Automated follow-up reminders by push and email',
  'WhatsApp Business API messaging from inside a lead',
  'Mobile app for Android',
  'Payment and subscription billing',
];

export function FeaturesPage(): React.JSX.Element {
  usePageMeta(
    'Features — LeadFlow',
    'Lead management, contacts, follow-ups, activity timeline, team roles, reporting and CSV import.',
  );

  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pt-16 pb-10 sm:px-6 sm:pt-20">
        <SectionHeading
          title="Everything in LeadFlow"
          subtitle="Every feature on this page is built and in use today. Anything planned is listed separately at the bottom."
        />

        <nav aria-label="Feature sections" className="mt-8 flex flex-wrap gap-2">
          {GROUPS.map((group) => (
            <a
              key={group.id}
              href={`#${group.id}`}
              className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-200 hover:text-slate-900"
            >
              {group.title}
            </a>
          ))}
        </nav>
      </section>

      <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        {GROUPS.map((group) => (
          <section
            key={group.id}
            id={group.id}
            className="scroll-mt-20 border-t border-slate-200 py-12"
          >
            <div className="grid gap-8 lg:grid-cols-[280px_1fr]">
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-slate-900">
                  {group.title}
                </h2>
                <p className="mt-2 text-sm text-pretty text-slate-600">{group.summary}</p>
              </div>

              <dl className="grid gap-5 sm:grid-cols-2">
                {group.items.map((item) => (
                  <div key={item.name}>
                    <dt className="text-sm font-medium text-slate-900">{item.name}</dt>
                    <dd className="mt-1 text-sm text-pretty text-slate-600">{item.detail}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        ))}

        <section className="border-t border-slate-200 py-12">
          <div className="grid gap-8 lg:grid-cols-[280px_1fr]">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-900">
                Planned, not yet built
              </h2>
              <p className="mt-2 text-sm text-pretty text-slate-600">
                Listed so you can judge whether LeadFlow fits — these are not available today.
              </p>
            </div>

            <ul className="grid gap-3 sm:grid-cols-2">
              {UPCOMING.map((item) => (
                <li key={item} className="flex gap-2.5 text-sm text-slate-500">
                  <span className="mt-0.5 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                    Upcoming
                  </span>
                  <span className="text-pretty">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <section className="border-t border-slate-200 bg-slate-50 py-14">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">
            Ready to try it?
          </h2>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
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
        </div>
      </section>
    </>
  );
}
