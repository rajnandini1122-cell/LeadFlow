import { useQuery } from '@tanstack/react-query';
import type { Paginated, UserListItem } from '@idea001/api-types';
import { apiGet } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';

interface LeadSummary {
  id: string;
  leadNumber: string;
  name: string;
  companyName: string | null;
  status: string;
  priority: string;
  nextFollowUpAt: string | null;
  assignedTo: { id: string; fullName: string } | null;
}

/**
 * Phase 1 dashboard.
 *
 * Deliberately thin: it proves the authenticated round trip end to end (real
 * token, real tenant scoping, real data) without pretending the aggregated KPIs
 * of spec §24 exist yet. Those need the dashboard API from Phase 4.
 */
export function DashboardPage(): React.JSX.Element {
  const { user } = useAuth();

  const leads = useQuery({
    queryKey: ['leads'],
    queryFn: () => apiGet<Paginated<LeadSummary>>('/leads', { limit: 10 }),
  });

  const team = useQuery({
    queryKey: ['users'],
    queryFn: () => apiGet<UserListItem[]>('/users'),
    // Sales reps cannot list users; asking would just produce a 403.
    enabled: user?.permissions.includes('user.view') ?? false,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{greeting()}, {user?.fullName}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {user?.organization.name} · {user?.organization.timezone}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Leads visible to you"
          value={leads.isPending ? '…' : String(leads.data?.items.length ?? 0)}
        />
        <StatCard
          label="Team members"
          value={team.isPending && team.isFetching ? '…' : String(team.data?.length ?? '—')}
        />
        <StatCard label="Your role" value={user?.role ?? '—'} />
      </div>

      <section className="rounded-xl border border-slate-200 bg-white">
        <header className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-medium text-slate-900">Recent leads</h2>
        </header>

        {leads.isPending ? (
          <p className="px-4 py-6 text-sm text-slate-500">Loading…</p>
        ) : leads.isError ? (
          <p className="px-4 py-6 text-sm text-red-600">Could not load leads.</p>
        ) : leads.data.items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            No leads yet. Lead creation arrives in Phase 2.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {leads.data.items.map((lead) => (
              <li key={lead.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">{lead.name}</p>
                  <p className="text-xs text-slate-500">
                    {lead.leadNumber}
                    {lead.companyName ? ` · ${lead.companyName}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                    {lead.status}
                  </span>
                  <p className="mt-1 text-xs text-slate-500">
                    {lead.nextFollowUpAt
                      ? `Follow up ${new Date(lead.nextFollowUpAt).toLocaleDateString()}`
                      : 'No follow-up'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
