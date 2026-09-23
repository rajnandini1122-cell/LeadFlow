import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UserListItem } from '@leadflow/api-types';
import { apiGet } from '../../lib/api-client';
import { formatCurrencyCompact, formatDate, formatRelative } from '../../lib/format';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  RoleBadge,
  SkeletonRows,
  StatTile,
} from '../../components/ui';
import { UserAvatar } from '../../components/user-avatar';
import { useAuth } from '../auth/auth-context';
import { DateRangePicker, RangeSummary } from '../reports/date-range-picker';
import {
  useTeamReport,
  type RangeSelection,
  type TeamMemberPerformance,
} from '../reports/use-reports';
import { InviteMemberDialog } from './invite-member-dialog';
import { OffboardMemberDialog } from './offboard-member-dialog';
import { TransferAdminDialog } from './transfer-admin-dialog';
import { AuditTrailCard } from './audit-trail-card';
import { PendingInvitations } from './pending-invitations';
import { LeaveOrganizationButton, MemberActions } from './member-actions';

/**
 * Team roster and performance.
 *
 * Performance figures come from the reporting API, aggregated per member in a
 * fixed number of grouped queries. The previous version counted a page of leads
 * in the browser, which meant a rep's workload was understated the moment the
 * organization outgrew that page — and understated silently.
 */
export function TeamPage(): React.JSX.Element {
  const { user, can } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeSelection>({ preset: 'this_month' });
  const [offboarding, setOffboarding] = useState<UserListItem | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  const canInvite = can('user.invite');
  const canSeePerformance = can('report.view');
  const canManageMembers = can('user.update');
  const isOwner = user?.role === 'OWNER';

  const team = useQuery({
    queryKey: ['users'],
    queryFn: () => apiGet<UserListItem[]>('/users'),
  });
  const performance = useTeamReport(range, canSeePerformance);

  if (team.isPending) {
    return (
      <>
        <PageHeader title="Team" />
        <Card>
          <SkeletonRows rows={5} />
        </Card>
      </>
    );
  }

  if (team.isError) {
    return (
      <Card>
        <ErrorNotice message="Could not load the team. This needs the user.view permission." />
      </Card>
    );
  }

  const members = team.data;
  const byUser = new Map<string, TeamMemberPerformance>(
    (performance.data?.members ?? []).map((row) => [row.userId, row]),
  );

  const totals = (performance.data?.members ?? []).reduce(
    (sum, row) => ({
      active: sum.active + row.activeLeads,
      overdue: sum.overdue + row.overdueFollowUps,
      won: sum.won + row.wonLeads,
    }),
    { active: 0, overdue: 0, won: 0 },
  );

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={`${members.length} members in this organization`}
        action={
          <div className="flex flex-wrap gap-2">
            {isOwner && (
              <button
                type="button"
                onClick={() => setTransferOpen(true)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Transfer admin
              </button>
            )}
            {canInvite && (
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                + Invite member
              </button>
            )}
          </div>
        }
      />

      <InviteMemberDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />

      <OffboardMemberDialog
        member={offboarding}
        open={offboarding !== null}
        onClose={() => setOffboarding(null)}
        onDone={(message) => {
          setNotice(message);
          setError(null);
        }}
      />

      <TransferAdminDialog
        open={transferOpen}
        members={members}
        currentUserId={user?.id}
        onClose={() => setTransferOpen(false)}
        onDone={(message) => {
          setNotice(message);
          setError(null);
        }}
      />

      {(notice || error) && (
        <div className="mb-4">
          {notice && (
            <p
              role="status"
              aria-live="polite"
              className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            >
              {notice}
            </p>
          )}
          {error && (
            <p
              role="alert"
              aria-live="assertive"
              className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </p>
          )}
        </div>
      )}

      {canSeePerformance && (
        <div className="mb-5 space-y-2">
          <DateRangePicker value={range} onChange={setRange} />
          {performance.data && (
            <RangeSummary range={performance.data.range} scope={performance.data.scope} />
          )}
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatTile label="Members" value={members.length} />
        <StatTile
          label="Active leads"
          value={canSeePerformance ? (performance.data ? totals.active : '—') : '—'}
          hint="Across the team, right now"
        />
        <StatTile
          label="Overdue follow-ups"
          value={canSeePerformance ? (performance.data ? totals.overdue : '—') : '—'}
          tone={totals.overdue > 0 ? 'danger' : 'success'}
        />
      </div>

      <Card>
        <CardHeader
          title="Members"
          subtitle={
            canSeePerformance
              ? 'Role, status and performance for the selected range'
              : 'Role and status'
          }
        />
        {members.length === 0 ? (
          <EmptyState title="No members" description="Invite your first team member." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {members.map((member) => (
              <li key={member.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                <UserAvatar name={member.fullName} avatarUrl={member.avatarUrl} />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {member.fullName}
                    </p>
                    <RoleBadge role={member.role} />
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        member.status === 'ACTIVE'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {member.status === 'ACTIVE' ? 'Active' : member.status}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {member.email}
                    {member.mobile ? ` · ${member.mobile}` : ''}
                  </p>
                </div>

                {canSeePerformance && (
                  <Performance row={byUser.get(member.id)} loading={performance.isPending} />
                )}

                <MemberActions
                  member={member}
                  onError={(message) => {
                    setError(message);
                    setNotice(null);
                  }}
                  onSuccess={(message) => {
                    setNotice(message);
                    setError(null);
                  }}
                  onOffboard={setOffboarding}
                />

                <div className="hidden w-28 text-right lg:block">
                  <p className="text-xs text-slate-500">Last active</p>
                  <p className="text-sm text-slate-700">
                    {member.lastLoginAt ? formatRelative(member.lastLoginAt) : 'Never'}
                  </p>
                  <p className="text-[11px] text-slate-400">Joined {formatDate(member.joinedAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canSeePerformance && performance.data && performance.data.members.length > 0 && (
        <div className="mt-6">
          <PerformanceTable members={performance.data.members} />
        </div>
      )}

      <div className="mt-6">
        <PendingInvitations canManage={canInvite} />
      </div>

      {canManageMembers && (
        <div className="mt-6">
          <AuditTrailCard enabled={canManageMembers} />
        </div>
      )}

      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">Leave this organization</h2>
        <p className="mt-1 mb-3 text-sm text-slate-500">
          You will lose access immediately. Your other organizations are unaffected. If you
          still own active leads or open follow-ups you must hand them to a colleague first.
        </p>
        <LeaveOrganizationButton
          colleagues={members
            .filter((member) => member.status === 'ACTIVE' && member.id !== user?.id)
            .map((member) => ({ id: member.id, fullName: member.fullName }))}
        />
      </div>
    </>
  );
}

/** Compact per-member figures shown inline on the roster. */
function Performance({
  row,
  loading,
}: {
  row: TeamMemberPerformance | undefined;
  loading: boolean;
}): React.JSX.Element {
  return (
    <>
      <div className="hidden text-right sm:block">
        <p className="text-xs text-slate-500">Active leads</p>
        <p className="text-sm font-semibold tabular-nums text-slate-900">
          {loading ? '…' : (row?.activeLeads ?? 0)}
          {(row?.overdueFollowUps ?? 0) > 0 && (
            <span className="ml-1.5 text-xs font-medium text-red-600">
              {row?.overdueFollowUps} overdue
            </span>
          )}
        </p>
      </div>

      <div className="hidden w-24 text-right md:block">
        <p className="text-xs text-slate-500">Pipeline</p>
        <p className="text-sm font-semibold tabular-nums text-slate-900">
          {loading ? '…' : formatCurrencyCompact(row?.pipelineValue ?? '0')}
        </p>
      </div>
    </>
  );
}

/**
 * The full performance breakdown.
 *
 * A table rather than more inline columns: at this width the roster row is
 * already carrying as much as it can, and these are numbers a manager compares
 * ACROSS people rather than reads one at a time.
 */
function PerformanceTable({
  members,
}: {
  members: TeamMemberPerformance[];
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader
        title="Performance"
        subtitle="Leads by created date · deals by close date · follow-ups by scheduled date"
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
              <th scope="col" className="px-5 py-2 font-medium">
                Member
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Assigned
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Created
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Active
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Won
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Lost
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Won value
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Conv.
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Overdue
              </th>
              <th scope="col" className="px-5 py-2 text-right font-medium">
                Follow-up rate
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.map((row) => (
              <tr key={row.userId} className="hover:bg-slate-50">
                <th scope="row" className="px-5 py-2.5 text-left font-medium text-slate-900">
                  {row.fullName}
                  <span className="block text-[11px] font-normal text-slate-400">
                    {row.activityCount} activities
                  </span>
                </th>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {row.leadsAssigned}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {row.leadsCreated}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {row.activeLeads}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">
                  {row.wonLeads}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                  {row.lostLeads}
                </td>
                <td className="px-3 py-2.5 text-right font-medium tabular-nums text-slate-900">
                  {formatCurrencyCompact(row.wonValue)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {row.conversionRate}%
                </td>
                <td
                  className={`px-3 py-2.5 text-right tabular-nums ${
                    row.overdueFollowUps > 0 ? 'font-semibold text-red-600' : 'text-slate-400'
                  }`}
                >
                  {row.overdueFollowUps}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-slate-700">
                  {row.followUpCompletionRate}%
                  <span className="block text-[11px] text-slate-400">
                    {row.completedFollowUps} done
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
