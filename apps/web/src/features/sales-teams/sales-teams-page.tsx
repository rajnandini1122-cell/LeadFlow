import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { TeamFormDialog } from './team-form-dialog';
import { useAgents, useCreateTeam, useTeams } from './use-teams';

/**
 * Sales teams.
 *
 * Structure only: who is in which team, and who is available. There is no
 * routing here — no round-robin, no territories, no workload balancing — and
 * nothing on this screen moves a customer from one person to another. Those
 * are the assignment phase's decisions, and this is what it will read.
 *
 * Named "Sales teams" rather than "Teams" because the existing Team screen is
 * the organization's member directory, and two things called Team would be one
 * thing nobody could find.
 */
export function SalesTeamsPage(): React.JSX.Element {
  const { can } = useAuth();
  const canManage = can('team.manage');

  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const teams = useTeams(includeArchived);
  // Only needed for the manager picker, which only an administrator sees.
  const agents = useAgents(canManage);
  const createTeam = useCreateTeam();

  if (teams.isPending) {
    return (
      <div>
        <PageHeader title="Sales teams" subtitle="Who sells what, and with whom." />
        <Card>
          <SkeletonRows />
        </Card>
      </div>
    );
  }

  if (teams.isError) {
    return (
      <div>
        <PageHeader title="Sales teams" />
        <ErrorNotice message="Sales teams could not be loaded. Please try again." />
      </div>
    );
  }

  const rows = teams.data ?? [];

  return (
    <div>
      <PageHeader
        title="Sales teams"
        subtitle="Who sells what, and with whom. Assignment rules will use these teams."
        action={
          canManage ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              New team
            </button>
          ) : undefined
        }
      />

      <Card>
        <CardHeader
          title={`${rows.length} ${rows.length === 1 ? 'team' : 'teams'}`}
          action={
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
                className="rounded border-slate-300"
              />
              Show archived
            </label>
          }
        />

        {rows.length === 0 ? (
          <EmptyState
            title="No sales teams yet"
            description={
              canManage
                ? 'Create a team, then add the people already in your organization to it.'
                : 'An administrator has not created any sales teams yet.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
                <th className="px-5 py-2 font-medium">Team</th>
                <th className="px-5 py-2 font-medium">Manager</th>
                <th className="px-5 py-2 font-medium">Agents</th>
                <th className="px-5 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((team) => (
                <tr key={team.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-5 py-3">
                    <Link
                      to={`/sales-teams/${team.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {team.name}
                    </Link>
                    {team.description && (
                      <p className="mt-0.5 text-xs text-slate-500">{team.description}</p>
                    )}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {team.manager?.fullName ?? <span className="text-slate-400">Unassigned</span>}
                  </td>
                  <td className="px-5 py-3 text-slate-600">{team.activeMemberCount}</td>
                  <td className="px-5 py-3">
                    <span
                      className={
                        team.status === 'ACTIVE'
                          ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700'
                          : 'rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500'
                      }
                    >
                      {team.status === 'ACTIVE' ? 'Active' : 'Archived'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <TeamFormDialog
        open={creating}
        agents={agents.data ?? []}
        saving={createTeam.isPending}
        error={createTeam.error}
        onClose={() => {
          setCreating(false);
          createTeam.reset();
        }}
        onSubmit={(values) => {
          createTeam.mutate(
            {
              name: values.name,
              ...(values.description ? { description: values.description } : {}),
              ...(values.managerUserId ? { managerUserId: values.managerUserId } : {}),
            },
            { onSuccess: () => setCreating(false) },
          );
        }}
      />
    </div>
  );
}
