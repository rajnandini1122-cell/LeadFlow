import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Card,
  CardHeader,
  DueBadge,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
  StatusBadge,
} from '../../components/ui';
import {
  formatCurrency,
  formatDate,
  formatDueDate,
  telHref,
  whatsappHref,
} from '../../lib/format';
import { useAuth } from '../auth/auth-context';
import { MergeContactsDialog } from './merge-contacts-dialog';
import {
  useContact,
  useContactDuplicates,
  type Contact,
  type ContactLead,
} from './use-contacts';

/**
 * One person, and every deal ever opened with them.
 *
 * This is the view that justifies splitting contacts from leads: a returning
 * customer's third enquiry sits above the two that came before it, instead of
 * arriving as an unknown name.
 */
export function ContactDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const contact = useContact(id);
  const canReview = can('contact.update');
  const duplicates = useContactDuplicates(canReview ? id : undefined);
  const [mergeWith, setMergeWith] = useState<Contact | null>(null);

  if (contact.isPending) {
    return (
      <>
        <PageHeader title="Loading…" />
        <Card>
          <SkeletonRows rows={5} />
        </Card>
      </>
    );
  }

  if (contact.isError) {
    return (
      <Card>
        <ErrorNotice message="This contact could not be loaded." />
      </Card>
    );
  }

  const data = contact.data;
  const tel = telHref(data.mobile);
  const whatsapp = whatsappHref(data.mobile);

  return (
    <>
      <PageHeader
        title={data.name}
        subtitle={[data.companyName, data.city].filter(Boolean).join(' · ') || 'No company'}
        action={
          <div className="flex flex-wrap gap-2">
            {tel && (
              <a
                href={tel}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                Call
              </a>
            )}
            {whatsapp && (
              <a
                href={whatsapp}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-700"
              >
                WhatsApp
              </a>
            )}
          </div>
        }
      />

      {data.mergedIntoId && (
        <div className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          This record was merged into{' '}
          <Link to={`/contacts/${data.mergedIntoId}`} className="font-medium underline">
            another contact
          </Link>
          . It is kept so older links still resolve.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Leads"
              subtitle={`${data.leads.length} ${data.leads.length === 1 ? 'deal' : 'deals'} with this person`}
            />
            {data.leads.length === 0 ? (
              <EmptyState title="No leads yet" description="No deal has been opened with them." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.leads.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} />
                ))}
              </ul>
            )}
          </Card>

          {canReview && (duplicates.data?.length ?? 0) > 0 && (
            <Card>
              <CardHeader
                title="Possible duplicates"
                subtitle="Matched on an exact mobile or email. Merging is permanent."
              />
              <ul className="divide-y divide-slate-100">
                {(duplicates.data ?? []).map((candidate) => (
                  <li key={candidate.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/contacts/${candidate.id}`}
                        className="truncate text-sm font-medium text-slate-900 hover:underline"
                      >
                        {candidate.name}
                      </Link>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Same {candidate.matchedOn.join(' and ')} · {candidate.leadCount}{' '}
                        {candidate.leadCount === 1 ? 'lead' : 'leads'}
                      </p>
                    </div>
                    {can('contact.merge') && (
                      <button
                        type="button"
                        onClick={() => setMergeWith(candidate)}
                        className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                      >
                        Review merge
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader title="Details" />
          <dl className="divide-y divide-slate-100">
            <Detail label="Mobile" value={data.mobile} />
            <Detail label="Email" value={data.email} />
            <Detail label="Company" value={data.companyName} />
            <Detail label="City" value={data.city} />
            <Detail label="Added" value={formatDate(data.createdAt)} />
            <Detail label="Notes" value={data.notes} />
          </dl>
        </Card>
      </div>

      <MergeContactsDialog
        open={mergeWith !== null}
        // The record being viewed survives; the duplicate is absorbed into it.
        source={mergeWith}
        target={data}
        onClose={() => setMergeWith(null)}
      />
    </>
  );
}

function Detail({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  return (
    <div className="px-5 py-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm break-words text-slate-900">{value ?? '—'}</dd>
    </div>
  );
}

function LeadRow({ lead }: { lead: ContactLead }): React.JSX.Element {
  return (
    <li>
      <Link
        to={`/leads/${lead.id}`}
        className="flex items-center gap-3 px-5 py-3 transition hover:bg-slate-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-slate-400">{lead.leadNumber}</span>
            <StatusBadge status={lead.status} />
          </div>
          <p className="mt-1 truncate text-xs text-slate-500">
            {lead.assignedTo?.fullName ?? 'Unassigned'} · opened {formatDate(lead.createdAt)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold tabular-nums text-slate-900">
            {formatCurrency(lead.estimatedValue)}
          </p>
          <div className="mt-1">
            <DueBadge iso={lead.nextFollowUpAt} label={formatDueDate(lead.nextFollowUpAt)} />
          </div>
        </div>
      </Link>
    </li>
  );
}
