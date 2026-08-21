import { Card, CardHeader, EmptyState, ErrorNotice, SkeletonRows } from '../../components/ui';
import { formatDateTime, humanise } from '../../lib/format';
import { AUDIT_LABELS, useAuditTrail, type AuditEntry } from './use-offboarding';

/**
 * Administrative history.
 *
 * Role changes, handovers and removals are irreversible from the user's point
 * of view, so there has to be a record of who did what — both to answer "why
 * did my leads move?" and to make an abuse of admin access visible after the
 * fact rather than never.
 */
export function AuditTrailCard({ enabled }: { enabled: boolean }): React.JSX.Element {
  const audit = useAuditTrail(enabled);

  return (
    <Card>
      <CardHeader
        title="Administrative history"
        subtitle="Role changes, handovers, deactivations and removals"
      />

      {audit.isPending ? (
        <SkeletonRows rows={4} />
      ) : audit.isError ? (
        <ErrorNotice message="Could not load the audit trail." />
      ) : audit.data.items.length === 0 ? (
        <EmptyState
          title="Nothing recorded yet"
          description="Administrative actions will be listed here as they happen."
        />
      ) : (
        <ul className="divide-y divide-slate-100">
          {audit.data.items.map((entry) => (
            <li key={entry.id} className="px-5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-slate-900">
                  {AUDIT_LABELS[entry.action] ?? humanise(entry.action.replace(/\./g, ' '))}
                </p>
                <p className="text-xs text-slate-400">{formatDateTime(entry.createdAt)}</p>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {entry.actor ? `By ${entry.actor.fullName}` : 'By the system'}
                {describe(entry)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The consequential details, in words.
 *
 * Only the fields that tell a reader what actually changed — dumping the raw
 * before/after JSON onto the screen would be technically complete and
 * practically unreadable.
 */
function describe(entry: AuditEntry): string {
  const after = entry.after ?? {};
  const parts: string[] = [];

  const leads = Number(after['leadsReassigned'] ?? 0);
  const historical = Number(after['historicalLeadsReassigned'] ?? 0);
  const followUps = Number(after['followUpsReassigned'] ?? 0);

  if (typeof after['action'] === 'string') {
    parts.push(after['action'] === 'REMOVE' ? 'removed' : 'deactivated');
  }
  if (leads > 0) parts.push(`${leads} active ${leads === 1 ? 'lead' : 'leads'} moved`);
  if (historical > 0) parts.push(`${historical} closed deals moved`);
  if (followUps > 0) {
    parts.push(`${followUps} ${followUps === 1 ? 'follow-up' : 'follow-ups'} moved`);
  }
  if (typeof after['role'] === 'string' && typeof entry.before?.['role'] === 'string') {
    parts.push(`${humanise(String(entry.before['role']))} → ${humanise(after['role'])}`);
  }
  if (after['steppedDown'] === true) parts.push('previous owner stepped down');

  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}
