import { useQuery } from '@tanstack/react-query';
import type { UserListItem } from '@leadflow/api-types';
import { apiGet } from '../../lib/api-client';
import { formatCurrencyCompact, formatDate, formatRelative } from '../../lib/format';
import {
  Avatar,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  PhaseNote,
  RoleBadge,
  SkeletonRows,
  StatTile,
} from '../../components/ui';
import { bucketLeads, useLeads } from '../leads/use-leads';

export function TeamPage(): React.JSX.Element {
  const team = useQuery({
    queryKey: ['users'],
    queryFn: () => apiGet<UserListItem[]>('/users'),
  });
  const leads = useLeads();

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
  const buckets = leads.data ? bucketLeads(leads.data.items) : null;

  /** Per-rep workload, so a manager can see who is carrying the overdue work. */
  const workload = (userId: string) => {
    if (!buckets) return { active: 0, overdue: 0, value: 0 };
    const mine = buckets.active.filter((lead) => lead.assignedTo?.id === userId);
    return {
      active: mine.length,
      overdue: buckets.overdue.filter((lead) => lead.assignedTo?.id === userId).length,
      value: mine.reduce((sum, lead) => sum + Number(lead.estimatedValue ?? 0), 0),
    };
  };

  return (
    <>
      <PageHeader title="Team" subtitle={`${members.length} members in this organization`} />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatTile label="Members" value={members.length} />
        <StatTile
          label="Active leads"
          value={buckets?.active.length ?? '—'}
          hint="Across the team"
        />
        <StatTile
          label="Overdue"
          value={buckets?.overdue.length ?? '—'}
          tone={buckets && buckets.overdue.length > 0 ? 'danger' : 'success'}
        />
      </div>

      <Card>
        <CardHeader title="Members" subtitle="Role, status and current workload" />
        {members.length === 0 ? (
          <EmptyState title="No members" description="Invite your first team member." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {members.map((member) => {
              const load = workload(member.id);
              return (
                <li key={member.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                  <Avatar name={member.fullName} />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-slate-900">
                        {member.fullName}
                      </p>
                      <RoleBadge role={member.role} />
                      {member.status !== 'ACTIVE' && (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                          {member.status}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {member.email}
                      {member.mobile ? ` · ${member.mobile}` : ''}
                    </p>
                  </div>

                  <div className="hidden text-right sm:block">
                    <p className="text-xs text-slate-500">Active leads</p>
                    <p className="text-sm font-semibold tabular-nums text-slate-900">
                      {load.active}
                      {load.overdue > 0 && (
                        <span className="ml-1.5 text-xs font-medium text-red-600">
                          {load.overdue} overdue
                        </span>
                      )}
                    </p>
                  </div>

                  <div className="hidden w-24 text-right md:block">
                    <p className="text-xs text-slate-500">Pipeline</p>
                    <p className="text-sm font-semibold tabular-nums text-slate-900">
                      {formatCurrencyCompact(load.value)}
                    </p>
                  </div>

                  <div className="hidden w-28 text-right lg:block">
                    <p className="text-xs text-slate-500">Last active</p>
                    <p className="text-sm text-slate-700">
                      {member.lastLoginAt ? formatRelative(member.lastLoginAt) : 'Never'}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      Joined {formatDate(member.joinedAt)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="mt-4">
        <PhaseNote phase="Phase 4">
          Inviting users, changing roles and suspending accounts are already
          implemented in the API and covered by the authorization tests. The
          management UI for them lands with the web console phase.
        </PhaseNote>
      </div>
    </>
  );
}
