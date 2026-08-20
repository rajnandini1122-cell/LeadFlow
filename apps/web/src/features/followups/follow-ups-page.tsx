import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatCurrencyCompact, formatDate, formatDueDate, telHref, whatsappHref } from '../../lib/format';
import {
  Avatar,
  Card,
  DueBadge,
  EmptyState,
  ErrorNotice,
  PageHeader,
  PhaseNote,
  PriorityBadge,
  SkeletonRows,
  StatusBadge,
} from '../../components/ui';
import { bucketLeads, useLeads, type LeadSummary } from '../leads/use-leads';

type Tab = 'overdue' | 'today' | 'upcoming' | 'closed';

/**
 * Follow-up centre (spec §15).
 *
 * Phase 1 derives these buckets from `leads.next_follow_up_at` rather than from
 * a follow_ups table, because the follow-up engine is Phase 6. The buckets are
 * real — every active lead is guaranteed a next action by a database CHECK
 * constraint — but completing and rescheduling need the engine.
 */
export function FollowUpsPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('overdue');
  const leads = useLeads();

  if (leads.isPending) {
    return (
      <>
        <PageHeader title="Follow-ups" />
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      </>
    );
  }

  if (leads.isError) {
    return (
      <Card>
        <ErrorNotice message="Could not load follow-ups." />
      </Card>
    );
  }

  const b = bucketLeads(leads.data.items);
  const closed = [...b.won, ...b.lost];

  const tabs: { key: Tab; label: string; rows: LeadSummary[]; tone?: 'danger' }[] = [
    { key: 'overdue', label: 'Overdue', rows: b.overdue, tone: 'danger' },
    { key: 'today', label: 'Today', rows: b.today },
    { key: 'upcoming', label: 'Upcoming', rows: b.upcoming },
    { key: 'closed', label: 'Closed', rows: closed },
  ];

  const active = tabs.find((entry) => entry.key === tab) ?? tabs[0]!;

  return (
    <>
      <PageHeader
        title="Follow-ups"
        subtitle={
          b.overdue.length > 0
            ? `${b.overdue.length} overdue — these are the leads at risk of being forgotten`
            : 'Nothing overdue. Every active lead has a future follow-up.'
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium transition ${
              tab === entry.key
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50'
            }`}
          >
            {entry.label}
            <span
              className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                tab === entry.key
                  ? 'bg-white/20 text-white'
                  : entry.tone === 'danger' && entry.rows.length > 0
                    ? 'bg-red-100 text-red-700'
                    : 'bg-slate-100 text-slate-500'
              }`}
            >
              {entry.rows.length}
            </span>
          </button>
        ))}
      </div>

      <Card>
        {active.rows.length === 0 ? (
          <EmptyState
            icon={active.key === 'overdue' ? '✓' : '○'}
            title={
              active.key === 'overdue'
                ? 'Nothing overdue'
                : active.key === 'today'
                  ? 'Nothing due today'
                  : active.key === 'upcoming'
                    ? 'Nothing scheduled ahead'
                    : 'No closed leads'
            }
            description={
              active.key === 'overdue'
                ? 'Every active lead has a follow-up scheduled for today or later.'
                : 'Leads will appear here as their follow-up dates arrive.'
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {active.rows.map((lead) => (
              <FollowUpRow key={lead.id} lead={lead} closed={active.key === 'closed'} />
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-4">
        <PhaseNote phase="Phase 6">
          These buckets are derived from each lead&rsquo;s next follow-up date.
          Marking a follow-up complete, rescheduling it, and the push
          notifications that fire when one becomes due arrive with the follow-up
          engine and its background worker.
        </PhaseNote>
      </div>
    </>
  );
}

function FollowUpRow({ lead, closed }: { lead: LeadSummary; closed: boolean }): React.JSX.Element {
  const tel = telHref(lead.mobile);
  const whatsapp = whatsappHref(lead.mobile);

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3.5 transition hover:bg-slate-50">
      <Avatar name={lead.name} />

      <Link to={`/leads/${lead.id}`} className="min-w-0 flex-1 group">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-slate-900 group-hover:underline">
            {lead.name}
          </p>
          <StatusBadge status={lead.status} />
          {!closed && <PriorityBadge priority={lead.priority} />}
        </div>
        <p className="mt-0.5 truncate text-xs text-slate-500">
          {lead.companyName}
          {lead.assignedTo ? ` · ${lead.assignedTo.fullName}` : ''}
        </p>
      </Link>

      <div className="text-right">
        <p className="text-sm font-semibold tabular-nums text-slate-900">
          {formatCurrencyCompact(lead.estimatedValue)}
        </p>
        <div className="mt-1">
          {closed ? (
            <span className="text-xs text-slate-400">{formatDate(lead.createdAt)}</span>
          ) : (
            <DueBadge iso={lead.nextFollowUpAt} label={formatDueDate(lead.nextFollowUpAt)} />
          )}
        </div>
      </div>

      {!closed && (
        <div className="flex gap-1.5">
          <a
            href={tel ?? undefined}
            aria-disabled={!tel}
            title="Call"
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              tel
                ? 'bg-slate-900 text-white hover:bg-slate-800'
                : 'pointer-events-none bg-slate-100 text-slate-400'
            }`}
          >
            Call
          </a>
          <a
            href={whatsapp ?? undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!whatsapp}
            title="WhatsApp"
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              whatsapp
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'pointer-events-none bg-slate-100 text-slate-400'
            }`}
          >
            WhatsApp
          </a>
        </div>
      )}
    </li>
  );
}
