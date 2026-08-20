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
  RoleBadge,
  SkeletonRows,
  StatTile,
} from '../../components/ui';
import { bucketLeads, useLeads } from '../leads/use-leads';
import { useAuth } from '../auth/auth-context';
import { InviteMemberDialog } from './invite-member-dialog';
import { PendingInvitations } from './pending-invitations';
import { LeaveOrganizationButton, MemberActions } from './member-actions';
import { useState } from 'react';

export function TeamPage(): React.JSX.Element {
  const { can } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canInvite = can('user.invite');

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
      <PageHeader
        title="Team"
        subtitle={`${members.length} members in this organization`}
        action={
          canInvite ? (
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              + Invite member
            </button>
          ) : undefined
        }
      />

      <InviteMemberDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />

      {(notice || error) && (
        <div className="mb-4">
          {notice && (
            <p role="status" aria-live="polite" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>
      )}

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
                  />

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

      <div className="mt-6">
        <PendingInvitations canManage={canInvite} />
      </div>

      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">Leave this organization</h2>
        <p className="mt-1 mb-3 text-sm text-slate-500">
          You will lose access immediately. Your other organizations are unaffected.
        </p>
        <LeaveOrganizationButton />
      </div>
    </>
  );
}
