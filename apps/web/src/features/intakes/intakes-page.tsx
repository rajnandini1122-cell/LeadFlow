import { useState } from 'react';
import { Link } from 'react-router-dom';
import { INTAKE_STATUSES, type IntakeStatus, type IntegrationIntakeListItem } from '@leadflow/api-types';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { IntakeDetail } from './intake-detail';
import { useIntakes } from './use-intakes';

const PAGE_SIZE = 25;

/**
 * The website enquiry queue.
 *
 * An operations screen: what arrived, and what routing did with it. The
 * question it exists to answer is "did this become somebody's work, and if not
 * why" — so the outcome is as prominent as the customer's name, and the raw
 * submission is one click away rather than dumped into a table.
 */
export function IntakesPage(): React.JSX.Element {
  const { can } = useAuth();
  const canManage = can('integration_intake.manage');

  const [status, setStatus] = useState<IntakeStatus | ''>('');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const intakes = useIntakes({
    ...(status ? { status } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  if (intakes.isPending) {
    return (
      <div>
        <PageHeader title="Website enquiries" subtitle="What arrived, and where it went." />
        <Card>
          <SkeletonRows />
        </Card>
      </div>
    );
  }

  if (intakes.isError) {
    return (
      <div>
        <PageHeader title="Website enquiries" />
        <ErrorNotice message="The enquiry queue could not be loaded. Please try again." />
      </div>
    );
  }

  const { items, total } = intakes.data ?? { items: [], total: 0 };
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <div>
      <PageHeader
        title="Website enquiries"
        subtitle="Every submission, and what routing did with it. The enquiry itself is never changed here."
      />

      <Card>
        <CardHeader
          title={`${total} ${total === 1 ? 'enquiry' : 'enquiries'}`}
          subtitle="Newest first."
          action={
            <select
              aria-label="Filter by status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as IntakeStatus | '');
                setPage(0);
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
            >
              <option value="">All statuses</option>
              {INTAKE_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {STATUS_LABELS[option]}
                </option>
              ))}
            </select>
          }
        />

        {items.length === 0 ? (
          <EmptyState
            title="No enquiries yet"
            description="Submissions from the website appear here as soon as they arrive."
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
                <th className="px-5 py-2 font-medium">Arrived</th>
                <th className="px-5 py-2 font-medium">From</th>
                <th className="px-5 py-2 font-medium">Asked about</th>
                <th className="px-5 py-2 font-medium">Outcome</th>
                <th className="px-5 py-2 font-medium">Went to</th>
              </tr>
            </thead>
            <tbody>
              {items.map((intake) => (
                <IntakeRow
                  key={intake.id}
                  intake={intake}
                  canManage={canManage}
                  expanded={expanded === intake.id}
                  onToggle={() =>
                    setExpanded((current) => (current === intake.id ? null : intake.id))
                  }
                />
              ))}
            </tbody>
          </table>
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
            <span>
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                disabled={page === 0}
                className="rounded-lg border border-slate-300 px-2 py-1 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(lastPage, current + 1))}
                disabled={page >= lastPage}
                className="rounded-lg border border-slate-300 px-2 py-1 disabled:opacity-40"
              >
                Next
              </button>
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}

function IntakeRow({
  intake,
  canManage,
  expanded,
  onToggle,
}: {
  intake: IntegrationIntakeListItem;
  canManage: boolean;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <>
      <tr className="border-b border-slate-50 last:border-0">
        <td className="px-5 py-3 text-xs text-slate-500">
          {new Date(intake.receivedAt).toLocaleString()}
        </td>
        <td className="px-5 py-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="text-left font-medium text-slate-900 hover:underline"
          >
            {intake.name || 'Someone who left no name'}
          </button>
          {intake.company && <p className="mt-0.5 text-xs text-slate-500">{intake.company}</p>}
        </td>
        <td className="max-w-xs truncate px-5 py-3 text-xs text-slate-600">
          {intake.productInterest || <span className="text-slate-400">—</span>}
        </td>
        <td className="px-5 py-3">
          <StatusPill status={intake.status} />
          {/* The reason, not just the state. "Blocked" on its own sends an
              operator looking; "no rule matches" tells them what to fix. */}
          {intake.processingCode && (
            <p className="mt-0.5 text-xs text-slate-500">{CODE_LABELS[intake.processingCode] ?? intake.processingCode}</p>
          )}
        </td>
        <td className="px-5 py-3 text-xs text-slate-600">
          {intake.createdLead ? (
            <Link to={`/leads/${intake.createdLead.id}`} className="underline">
              {intake.createdLead.leadNumber}
            </Link>
          ) : (
            <span className="text-slate-400">—</span>
          )}
          {intake.assignedTo && <p className="mt-0.5">{intake.assignedTo.fullName}</p>}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-slate-50 bg-slate-50/50">
          <td colSpan={5} className="p-0">
            <IntakeDetail intakeId={intake.id} canManage={canManage} />
          </td>
        </tr>
      )}
    </>
  );
}

function StatusPill({ status }: { status: IntakeStatus }): React.JSX.Element {
  const styles: Record<IntakeStatus, string> = {
    PROCESSED: 'bg-emerald-50 text-emerald-700',
    RECEIVED: 'bg-slate-100 text-slate-600',
    // Amber, not red: a blocked enquiry is somebody's to-do, not an incident.
    BLOCKED: 'bg-amber-50 text-amber-700',
    DUPLICATE: 'bg-amber-50 text-amber-700',
    FAILED: 'bg-red-50 text-red-700',
  };

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

const STATUS_LABELS: Record<IntakeStatus, string> = {
  RECEIVED: 'Waiting',
  PROCESSED: 'Became a lead',
  BLOCKED: 'Needs configuration',
  DUPLICATE: 'Needs review',
  FAILED: 'Failed',
};

/** The machine codes, said in words. */
const CODE_LABELS: Record<string, string> = {
  NO_MATCH: 'No rule matches this enquiry',
  NO_ELIGIBLE_AGENTS: 'Nobody in that team can take work',
  DUPLICATE_LEAD: 'An active lead already exists for this number',
  NO_NAME: 'The enquiry carries no name',
};
