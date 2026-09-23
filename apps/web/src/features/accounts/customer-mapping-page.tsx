import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../lib/api-client';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import {
  useAccountMappingProgress,
  useAccountOptions,
  useAssignToAccount,
  useCreateAccount,
  useMappingSuggestions,
} from './use-accounts';

/**
 * Matching historical leads to customers.
 *
 * The whole screen exists because NOTHING IS GUESSED. Leads carry a free-text
 * company name typed by whoever took the call, so one customer appears as "ABC
 * Foods", "ABC Foods Pvt Ltd", "abc foods" and "ABC". Deciding those are one
 * company is a judgement — and deciding it wrong fuses two businesses'
 * opportunities and revenue into one record, with no undo.
 *
 * So the server proposes and shows its evidence: every original spelling in the
 * group, and any existing customer the group matches exactly. A person reads it
 * and confirms. The free text is never overwritten — it is the evidence.
 */
export function CustomerMappingPage(): React.JSX.Element {
  const progress = useAccountMappingProgress();
  const suggestions = useMappingSuggestions();

  return (
    <>
      <PageHeader
        title="Match leads to customers"
        subtitle="Group historical enquiries so one company reads as one relationship."
        action={
          <Link
            to="/customers"
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Back to customers
          </Link>
        }
      />

      {progress.data && (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
          <span className="text-slate-600">
            <strong className="font-medium text-slate-900">{progress.data.mapped}</strong> matched
          </span>
          <span className="text-slate-600">
            <strong className="font-medium text-slate-900">{progress.data.unmapped}</strong>{' '}
            remaining
          </span>
          {progress.data.percentMapped !== null && (
            <span className="text-slate-500">{progress.data.percentMapped}% classified</span>
          )}
          {/*
            Reported, never hidden. Without it the backfill could look finished
            while a pile of records still had nothing to group on.
          */}
          {progress.data.withoutCompanyName > 0 && (
            <span className="text-amber-700">
              {progress.data.withoutCompanyName} recorded no company name and cannot be grouped
              automatically
            </span>
          )}
        </div>
      )}

      {suggestions.isPending ? (
        <SkeletonRows rows={5} />
      ) : suggestions.isError ? (
        <ErrorNotice message="Could not load suggestions." />
      ) : suggestions.data.groups.length === 0 ? (
        <Card>
          <p className="p-8 text-center text-sm text-slate-500">
            Every lead with a company name already has a customer. Nothing to match.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {suggestions.data.groups.map((group) => (
            <SuggestionGroup key={group.normalizedName} group={group} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * One proposed group.
 *
 * Shows every spelling found, so the reviewer can see exactly what is being
 * grouped and refuse if two different companies have collided.
 */
function SuggestionGroup({
  group,
}: {
  group: {
    normalizedName: string;
    variants: string[];
    leadCount: number;
    leads: { id: string; leadNumber: string; companyName: string | null; status: string }[];
    existingAccounts: { id: string; name: string; status: string }[];
  };
}): React.JSX.Element {
  const assign = useAssignToAccount();
  const createAccount = useCreateAccount();
  const accounts = useAccountOptions('');

  const [selected, setSelected] = useState<Set<string>>(new Set(group.leads.map((lead) => lead.id)));
  const [target, setTarget] = useState(group.existingAccounts[0]?.id ?? '');
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyTo = (accountId: string): void => {
    setFailure(null);
    setResult(null);

    assign.mutate(
      { accountId, leadIds: [...selected] },
      {
        onSuccess: (response) => {
          setResult(
            response.leadsUpdated === response.requested
              ? `${response.leadsUpdated} matched. Their company text is unchanged.`
              : `${response.leadsUpdated} of ${response.requested} matched — the rest already had a customer.`,
          );
          setSelected(new Set());
        },
        onError: (error) =>
          setFailure(error instanceof ApiError ? error.message : 'Could not match those leads.'),
      },
    );
  };

  /** Creates the company from the most complete spelling, then attaches. */
  const createAndAssign = (): void => {
    setFailure(null);

    const name = [...group.variants].sort((a, b) => b.length - a.length)[0] ?? group.normalizedName;

    createAccount.mutate(
      { name, force: true },
      {
        onSuccess: (created) => {
          const accountId = (created as { account: { id: string } }).account.id;
          applyTo(accountId);
        },
        onError: (error) =>
          setFailure(error instanceof ApiError ? error.message : 'Could not create that customer.'),
      },
    );
  };

  return (
    <Card>
      <CardHeader
        title={group.variants[0] ?? group.normalizedName}
        subtitle={`${group.leadCount} lead${group.leadCount === 1 ? '' : 's'} written ${
          group.variants.length === 1 ? 'this way' : `${group.variants.length} different ways`
        }.`}
      />

      {/* The evidence. Every spelling being grouped, spelled out. */}
      {group.variants.length > 1 && (
        <div className="flex flex-wrap gap-2 border-b border-slate-100 px-4 py-3">
          {group.variants.map((variant) => (
            <span
              key={variant}
              className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-700"
            >
              {variant}
            </span>
          ))}
        </div>
      )}

      {group.existingAccounts.length > 0 && (
        <p className="border-b border-slate-100 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
          {group.existingAccounts.length === 1
            ? 'A customer with this name already exists — attach to it rather than creating a second record.'
            : 'More than one existing customer matches this name. Pick the right one.'}
        </p>
      )}

      <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto">
        {group.leads.map((lead) => (
          <li key={lead.id} className="flex items-center gap-3 px-4 py-2.5">
            <input
              type="checkbox"
              checked={selected.has(lead.id)}
              onChange={() => toggle(lead.id)}
              aria-label={`Select ${lead.leadNumber}`}
            />
            <span className="text-sm text-slate-700">{lead.companyName}</span>
            <span className="ml-auto text-xs text-slate-400">
              {lead.leadNumber} · {lead.status}
            </span>
          </li>
        ))}
      </ul>

      {failure && (
        <p role="alert" className="mx-4 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {failure}
        </p>
      )}

      {result && (
        <p
          role="status"
          className="mx-4 mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {result}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 p-4">
        <select
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          aria-label="Attach to customer"
          className="min-w-48 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
        >
          <option value="">Choose an existing customer…</option>
          {group.existingAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} (matches this name)
            </option>
          ))}
          {(accounts.data?.items ?? [])
            .filter((account) => !group.existingAccounts.some((match) => match.id === account.id))
            .map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
        </select>

        <button
          type="button"
          onClick={() => applyTo(target)}
          disabled={!target || selected.size === 0 || assign.isPending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          {assign.isPending ? 'Matching…' : `Attach ${selected.size || ''}`}
        </button>

        <button
          type="button"
          onClick={createAndAssign}
          disabled={selected.size === 0 || createAccount.isPending || assign.isPending}
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          {createAccount.isPending ? 'Creating…' : 'Create this customer'}
        </button>
      </div>
    </Card>
  );
}
