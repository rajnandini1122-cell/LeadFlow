import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PERMISSIONS } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { Card, CardHeader, EmptyState, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import {
  ACCOUNT_STATUS_PRESENTATION,
  useAccountMappingProgress,
  useAccounts,
  useCreateAccount,
} from './use-accounts';

/**
 * The customer list.
 *
 * A customer is the RELATIONSHIP — long-lived, and quite separate from any one
 * enquiry. The status column shows where each relationship stands, and it never
 * moves because of a single deal: an account with five wins, one loss and one
 * open enquiry is still a customer.
 */
export function CustomersPage(): React.JSX.Element {
  const { can } = useAuth();
  const canCreate = can(PERMISSIONS.ACCOUNT_CREATE);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);

  const accounts = useAccounts({
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
    limit: 100,
  });
  const progress = useAccountMappingProgress();

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="The companies you sell to, and the ones you hope to."
        action={
          canCreate ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              + New customer
            </button>
          ) : undefined
        }
      />

      {/*
        How much of the pipeline is actually attributed to a customer.
        Without this, a customer list built from 12 of 400 leads looks exactly
        like one built from all 400.
      */}
      {progress.data && progress.data.unmapped > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <p className="text-amber-900">
            <strong className="font-medium">{progress.data.unmapped}</strong> lead
            {progress.data.unmapped === 1 ? ' has' : 's have'} no customer attached, so
            {progress.data.unmapped === 1 ? ' it is' : ' they are'} missing from every figure here.
            {progress.data.withoutCompanyName > 0 && (
              <span className="text-amber-800">
                {' '}
                {progress.data.withoutCompanyName} of them recorded no company name at all.
              </span>
            )}
          </p>
          {canCreate && (
            <Link
              to="/customers/mapping"
              className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-medium text-amber-900 transition hover:bg-amber-100"
            >
              Match them up →
            </Link>
          )}
        </div>
      )}

      <Card>
        <CardHeader title="All customers" subtitle="Most recently active first." />

        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, domain, phone or city…"
            aria-label="Search customers"
            className="min-w-56 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Filter by status"
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="">Every status</option>
            <option value="PROSPECT">Prospects</option>
            <option value="CUSTOMER">Customers</option>
            <option value="DORMANT">Dormant</option>
            <option value="FORMER_CUSTOMER">Former customers</option>
          </select>
        </div>

        {accounts.isPending ? (
          <SkeletonRows rows={6} />
        ) : accounts.isError ? (
          <ErrorNotice message="Could not load customers." />
        ) : accounts.data.items.length === 0 ? (
          <EmptyState
            title={search || status ? 'Nothing matches that' : 'No customers yet'}
            description={
              search || status
                ? 'Try a different search.'
                : 'Add a company, or match your existing leads to one.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Company</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Owner</th>
                  <th className="px-4 py-2.5 text-right font-medium">Opportunities</th>
                  <th className="px-4 py-2.5 text-right font-medium">Contacts</th>
                  <th className="px-4 py-2.5 font-medium">Last won</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {accounts.data.items.map((account) => {
                  const presentation = ACCOUNT_STATUS_PRESENTATION[account.status];

                  return (
                    <tr key={account.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link
                          to={`/customers/${account.id}`}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {account.name}
                        </Link>
                        {(account.city || account.domain) && (
                          <p className="text-xs text-slate-500">
                            {[account.city, account.domain].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${presentation.className}`}
                        >
                          {presentation.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {account.owner?.fullName ?? <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                        {account.leadCount}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                        {account.contactCount}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {account.lastWonAt ? (
                          new Date(account.lastWonAt).toLocaleDateString()
                        ) : (
                          // Never bought. A dash, not a zero or a blank.
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {accounts.data && accounts.data.total > accounts.data.items.length && (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Showing {accounts.data.items.length} of {accounts.data.total}. Search to narrow the
            list.
          </p>
        )}
      </Card>

      {creating && <NewCustomerDialog onClose={() => setCreating(false)} />}
    </>
  );
}

/**
 * Creating a customer.
 *
 * The interesting part is the duplicate response. When something that looks
 * like the same company already exists the server refuses and NAMES it, with
 * the fields that matched — so the choice is made on evidence. Confirming is a
 * real option, because franchises and separately-run branches exist.
 */
function NewCustomerDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const create = useCreateAccount();

  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [industry, setIndustry] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<
    { id: string; name: string; confidence: string; matchedOn: string }[]
  >([]);

  const submit = (event: FormEvent, force = false): void => {
    event.preventDefault();
    setFailure(null);

    create.mutate(
      {
        name,
        ...(website ? { website } : {}),
        ...(phone ? { phone } : {}),
        ...(city ? { city } : {}),
        ...(industry ? { industry } : {}),
        ...(force ? { force: true } : {}),
      },
      {
        onSuccess: () => onClose(),
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'DUPLICATE_ACCOUNT') {
            const details = (error.details ?? {}) as Record<string, string[]>;
            const ids = details['duplicateAccountIds'] ?? [];

            setDuplicates(
              ids.map((id, index) => ({
                id,
                name: details['duplicateAccountNames']?.[index] ?? 'Unknown',
                confidence: details['duplicateConfidences']?.[index] ?? 'LOW',
                matchedOn: details['duplicateMatchedOn']?.[index] ?? '',
              })),
            );
            setFailure(error.message);
            return;
          }

          setFailure(error instanceof ApiError ? error.message : 'Could not create that customer.');
        },
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-900">New customer</h2>
        <p className="mt-1 text-sm text-slate-500">
          Every new record starts as a prospect. It becomes a customer by winning an opportunity.
        </p>

        <form onSubmit={(event) => submit(event)} className="mt-4 space-y-3">
          <Field label="Company name" required value={name} onChange={setName} />
          <Field label="Website" value={website} onChange={setWebsite} placeholder="abcfoods.com" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phone" value={phone} onChange={setPhone} />
            <Field label="City" value={city} onChange={setCity} />
          </div>
          <Field label="Industry" value={industry} onChange={setIndustry} />

          {failure && (
            <div role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p>{failure}</p>

              {duplicates.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {duplicates.map((duplicate) => (
                    <li key={duplicate.id} className="flex items-center justify-between gap-2">
                      <Link
                        to={`/customers/${duplicate.id}`}
                        className="font-medium underline"
                        onClick={onClose}
                      >
                        {duplicate.name}
                      </Link>
                      {/* The evidence, so this is a judgement not a guess. */}
                      <span className="text-xs text-amber-700">
                        {duplicate.confidence.toLowerCase()} · matched on {duplicate.matchedOn}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"
            >
              Cancel
            </button>

            {duplicates.length > 0 && (
              <button
                type="button"
                onClick={(event) => submit(event, true)}
                disabled={create.isPending}
                className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 disabled:opacity-50"
              >
                It is a different company
              </button>
            )}

            <button
              type="submit"
              disabled={!name.trim() || create.isPending}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {create.isPending ? 'Saving…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      />
    </label>
  );
}
