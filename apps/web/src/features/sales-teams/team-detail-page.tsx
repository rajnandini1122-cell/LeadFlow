import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { TeamMemberView } from '@leadflow/api-types';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  RoleBadge,
  SkeletonRows,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { TeamFormDialog } from './team-form-dialog';
import {
  useAddTeamMember,
  useAgents,
  useRemoveTeamMember,
  useSetMemberAssignment,
  useTeam,
  useUpdateTeam,
} from './use-teams';

/**
 * One team, and the people in it.
 *
 * Adding somebody here means adding an EXISTING member of the organization.
 * Bringing a new colleague in is still the invitation flow on the Team screen,
 * and this page links there rather than reimplementing it — two invite paths
 * would eventually disagree about roles.
 */
export function TeamDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const canManage = can('team.manage');

  const team = useTeam(id);
  const agents = useAgents(canManage);
  const updateTeam = useUpdateTeam(id ?? '');
  const addMember = useAddTeamMember(id ?? '');
  const removeMember = useRemoveTeamMember(id ?? '');
  const setAssignment = useSetMemberAssignment(id ?? '');

  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState('');

  if (team.isPending) {
    return (
      <div>
        <PageHeader title="Sales team" />
        <Card>
          <SkeletonRows />
        </Card>
      </div>
    );
  }

  if (team.isError || !team.data) {
    return (
      <div>
        <PageHeader title="Sales team" />
        <ErrorNotice message="This team could not be loaded. It may have been removed." />
      </div>
    );
  }

  const detail = team.data;
  const archived = detail.status === 'ARCHIVED';

  // Somebody already in the team is not a candidate to add again.
  const inTeam = new Set(detail.members.map((member) => member.userId));
  const addable = (agents.data ?? []).filter(
    (agent) => agent.status === 'ACTIVE' && !inTeam.has(agent.userId),
  );

  return (
    <div>
      <PageHeader
        title={detail.name}
        subtitle={detail.description ?? undefined}
        action={
          canManage ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() =>
                  updateTeam.mutate({ status: archived ? 'ACTIVE' : 'ARCHIVED' })
                }
                disabled={updateTeam.isPending}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {archived ? 'Reactivate' : 'Archive'}
              </button>
            </div>
          ) : undefined
        }
      />

      <p className="mb-4 text-sm text-slate-500">
        <Link to="/sales-teams" className="hover:underline">
          ← All sales teams
        </Link>
      </p>

      {archived && (
        <div className="mb-4 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600">
          This team is archived. Its history is kept and nothing was unassigned — it simply
          receives no future automatic assignment, and members cannot be added while it stays
          archived.
        </div>
      )}

      <Card className="mb-6">
        <CardHeader
          title="Manager"
          subtitle="Responsibility for the team. It grants no extra permissions."
        />
        <div className="px-5 py-4 text-sm">
          {detail.manager ? (
            <span className="text-slate-900">{detail.manager.fullName}</span>
          ) : (
            <span className="text-slate-400">No manager assigned</span>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title={`Agents (${detail.members.length})`}
          subtitle="Who is in this team, and who may receive automatically assigned work."
          action={
            canManage && !archived ? (
              <div className="flex items-center gap-2">
                <label htmlFor="add-agent" className="sr-only">
                  Add an existing member
                </label>
                <select
                  id="add-agent"
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
                >
                  <option value="">Add a member…</option>
                  {addable.map((agent) => (
                    <option key={agent.userId} value={agent.userId}>
                      {agent.fullName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!selected || addMember.isPending}
                  onClick={() =>
                    addMember.mutate(
                      { userId: selected },
                      { onSuccess: () => setSelected('') },
                    )
                  }
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            ) : undefined
          }
        />

        {detail.members.length === 0 ? (
          <EmptyState
            title="Nobody in this team yet"
            description={
              canManage
                ? 'Add people who are already in your organization. To bring somebody new in, invite them from the Team screen first.'
                : 'No agents have been added to this team yet.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
                <th className="px-5 py-2 font-medium">Agent</th>
                <th className="px-5 py-2 font-medium">Role</th>
                <th className="px-5 py-2 font-medium">Assignment</th>
                {canManage && <th className="px-5 py-2" />}
              </tr>
            </thead>
            <tbody>
              {detail.members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  canManage={canManage && !archived}
                  busy={setAssignment.isPending || removeMember.isPending}
                  onToggle={(assignmentEnabled) =>
                    setAssignment.mutate({ memberId: member.id, assignmentEnabled })
                  }
                  onRemove={() => removeMember.mutate(member.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <TeamFormDialog
        open={editing}
        team={detail}
        agents={agents.data ?? []}
        saving={updateTeam.isPending}
        error={updateTeam.error}
        onClose={() => {
          setEditing(false);
          updateTeam.reset();
        }}
        onSubmit={(values) => {
          updateTeam.mutate(
            {
              name: values.name,
              description: values.description || null,
              managerUserId: values.managerUserId || null,
            },
            { onSuccess: () => setEditing(false) },
          );
        }}
      />
    </div>
  );
}

function MemberRow({
  member,
  canManage,
  busy,
  onToggle,
  onRemove,
}: {
  member: TeamMemberView;
  canManage: boolean;
  busy: boolean;
  onToggle: (assignmentEnabled: boolean) => void;
  onRemove: () => void;
}): React.JSX.Element {
  /*
   * Why somebody is not a candidate, said plainly.
   *
   * "Paused" and "not available" look identical in a list, and an
   * administrator who cannot tell them apart will toggle the wrong thing: one
   * is this team's decision, the other is their organization membership or
   * their role, neither of which this screen can change.
   */
  const reason = !member.eligibleForAssignment
    ? member.status !== 'ACTIVE'
      ? `Not available — membership ${member.status.toLowerCase()}`
      : !member.assignmentEnabled
        ? 'Paused'
        : 'Not an assignment role'
    : null;

  return (
    <tr className="border-b border-slate-50 last:border-0">
      <td className="px-5 py-3">
        <span className="font-medium text-slate-900">{member.fullName}</span>
        <p className="text-xs text-slate-500">{member.email}</p>
      </td>
      <td className="px-5 py-3">
        <RoleBadge role={member.role} />
      </td>
      <td className="px-5 py-3">
        {canManage ? (
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={member.assignmentEnabled}
              disabled={busy}
              onChange={(event) => onToggle(event.target.checked)}
              className="rounded border-slate-300"
              aria-label={`Assignment for ${member.fullName}`}
            />
            {reason ?? 'Available'}
          </label>
        ) : (
          <span className="text-xs text-slate-600">{reason ?? 'Available'}</span>
        )}
      </td>
      {canManage && (
        <td className="px-5 py-3 text-right">
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="text-xs text-slate-500 hover:text-red-600 disabled:opacity-50"
          >
            Remove
          </button>
        </td>
      )}
    </tr>
  );
}
