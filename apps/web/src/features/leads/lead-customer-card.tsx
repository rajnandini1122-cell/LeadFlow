import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost } from '../../lib/api-client';
import { Card, CardHeader } from '../../components/ui';
import { useToast } from '../../components/toast';
import { useAssignToAccount } from '../accounts/use-accounts';
import { errorMessage } from './lead-dialogs';
import type { LeadDetail } from './use-leads';

/**
 * Which customer this lead belongs to — and, when it belongs to none, the way
 * to fix that from where the rep already is.
 *
 * Winning a deal PROMOTES the customer it is linked to; it never invents one
 * (a free-text company name is exactly how duplicate customers used to be
 * made). So a won lead with no customer did not count as a customer anywhere,
 * and the lead page offered no way to link one: it waited for a manager's
 * mapping review. Linking here, or creating the customer with the duplicate
 * check, completes New lead → Won → Customer in one place.
 */
export function LeadCustomerCard({ lead, canLink }: { lead: LeadDetail; canLink: boolean }): React.JSX.Element {
  const account = lead.account ?? null;

  return (
    <Card>
      <CardHeader title="Customer" />
      <div className="space-y-3 px-5 py-4 text-sm">
        {account ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link to={`/customers/${account.id}`} className="font-medium text-slate-900 hover:underline">
              {account.name}
            </Link>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              {STATUS_LABELS[account.status] ?? account.status}
            </span>
          </div>
        ) : (
          <>
            <p className="text-slate-600">Not linked to a customer yet.</p>
            {lead.status === 'WON' && (
              <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                This deal is won. Link it to its customer so it counts as one.
              </p>
            )}
            {canLink && <LinkCustomer lead={lead} />}
          </>
        )}
      </div>
    </Card>
  );
}

const STATUS_LABELS: Record<string, string> = {
  PROSPECT: 'Prospect',
  CUSTOMER: 'Customer',
  DORMANT: 'Dormant',
  FORMER_CUSTOMER: 'Former customer',
};

interface Suggestions {
  companyName: string | null;
  accounts: { id: string; name: string; status: string }[];
}

interface Candidate {
  id: string;
  name: string;
}

function LinkCustomer({ lead }: { lead: LeadDetail }): React.JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();
  const assign = useAssignToAccount();
  const [creating, setCreating] = useState(false);
  // Shown when "create" finds an existing company that looks the same.
  const [duplicates, setDuplicates] = useState<Candidate[] | null>(null);

  const suggestions = useQuery({
    queryKey: ['accounts', 'mapping', 'suggestions', lead.id],
    queryFn: () => apiGet<Suggestions>(`/accounts/mapping/suggestions/${lead.id}`),
  });

  const name = (lead.companyName ?? '').trim() || lead.name;
  const busy = assign.isPending || creating;

  const link = (candidate: Candidate): void => {
    assign.mutate(
      { accountId: candidate.id, leadIds: [lead.id] },
      {
        onSuccess: (result) => {
          if (result.leadsUpdated === 0) {
            toast.error('This lead is already linked to a customer.');
          } else {
            toast.success(`Linked to ${candidate.name}.`);
          }
          void queryClient.invalidateQueries({ queryKey: ['lead', lead.id] });
          setDuplicates(null);
        },
        onError: (error) => toast.error(errorMessage(error, 'Could not link the customer.')),
      },
    );
  };

  const create = async (force = false): Promise<void> => {
    setCreating(true);
    try {
      const { account } = await apiPost<{ account: Candidate }>('/accounts', { name, ...(force ? { force: true } : {}) });
      link(account);
    } catch (error) {
      const found = duplicatesFrom(error);
      if (found) setDuplicates(found);
      else toast.error(errorMessage(error, 'Could not create the customer.'));
    } finally {
      setCreating(false);
    }
  };

  const matches = suggestions.data?.accounts ?? [];

  return (
    <div className="space-y-2">
      {matches.length > 0 && !duplicates && (
        <>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Existing customers that match</p>
          <ul className="space-y-1.5">
            {matches.map((match) => (
              <li key={match.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => link(match)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-left font-medium text-slate-800 transition hover:bg-slate-50 disabled:opacity-60"
                >
                  Link to {match.name}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {duplicates ? (
        <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-amber-900">“{name}” looks like a customer you already have:</p>
          {duplicates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              disabled={busy}
              onClick={() => link(candidate)}
              className="block w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-left font-medium text-slate-800 hover:bg-amber-100 disabled:opacity-60"
            >
              Link to {candidate.name}
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => void create(true)}
            className="text-sm font-medium text-amber-900 underline disabled:opacity-60"
          >
            It’s a different company — create “{name}”
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void create()}
          className="w-full rounded-lg bg-slate-900 px-3 py-2 font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          {creating ? 'Creating…' : `Create customer “${name}”`}
        </button>
      )}
    </div>
  );
}

/** The candidates a 409 DUPLICATE_ACCOUNT names, as parallel arrays in its details. */
export function duplicatesFrom(error: unknown): Candidate[] | null {
  if (!(error instanceof ApiError) || error.code !== 'DUPLICATE_ACCOUNT') return null;
  const ids = error.details?.['duplicateAccountIds'] ?? [];
  const names = error.details?.['duplicateAccountNames'] ?? [];
  const list = ids.map((id, index) => ({ id, name: names[index] ?? 'Existing customer' }));
  return list.length > 0 ? list : null;
}
