import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MARKETING_CONSENT_BASES,
  PERMISSIONS,
  type MarketingConsentBasis,
} from '@leadflow/api-types';
import { useAuth } from '../auth/auth-context';
import { ApiError } from '../../lib/api-client';
import { formatDate } from '../../lib/format';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
} from '../../components/ui';
import {
  BASIS_LABELS,
  useEligibility,
  useGrantEligibility,
  useSuppress,
  useWithdrawEligibility,
} from './use-email';

/**
 * Who may receive promotional email, and why.
 *
 * Nobody is eligible until someone records a reason. People who unsubscribed
 * or complained cannot be made eligible here — only they can opt back in.
 */
export function EligibilityPage(): React.JSX.Element {
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.MARKETING_CONSENT_MANAGE);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const list = useEligibility(query);
  const [selected, setSelected] = useState<string[]>([]);
  const [basis, setBasis] = useState<MarketingConsentBasis>('CONSENT');
  const [note, setNote] = useState('');
  const grant = useGrantEligibility();
  const withdraw = useWithdrawEligibility();
  const suppress = useSuppress();
  const [message, setMessage] = useState<string | null>(null);

  const selectable = useMemo(
    () =>
      (list.data ?? []).filter(
        (r) => !r.suppressed || r.suppressed === 'MANUAL' || r.suppressed === 'BOUNCED',
      ),
    [list.data],
  );
  const toggle = (email: string) =>
    setSelected((s) => (s.includes(email) ? s.filter((e) => e !== email) : [...s, email]));
  const done = (text: string) => {
    setSelected([]);
    setNote('');
    setMessage(text);
  };
  const error = grant.error ?? withdraw.error ?? suppress.error;

  return (
    <>
      <PageHeader
        title="Marketing eligibility"
        subtitle={
          <Link to="/campaigns" className="hover:underline">
            ← Email campaigns
          </Link>
        }
      />
      <p className="mb-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
        Promotional campaigns only go to addresses marked eligible here, with a recorded reason.
        Imported and existing leads start as
        <strong> not eligible</strong>. Service messages to customers don’t need this, but
        unsubscribes and bounces always apply.
      </p>

      {canManage && (
        <AddEmail
          onSaved={(email, text) => {
            setSearch(email);
            setQuery(email);
            setMessage(text);
          }}
        />
      )}

      <Card className="mb-6">
        <div className="flex flex-wrap items-end gap-3 p-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search.trim());
            }}
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email or company"
              className="w-72 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
            >
              Search
            </button>
          </form>
          {canManage && selected.length > 0 && (
            <div className="flex flex-1 flex-wrap items-end gap-2">
              <select
                value={basis}
                onChange={(e) => setBasis(e.target.value as MarketingConsentBasis)}
                className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
              >
                {MARKETING_CONSENT_BASES.map((b) => (
                  <option key={b} value={b}>
                    {BASIS_LABELS[b]}
                  </option>
                ))}
              </select>
              <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-slate-600">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="How was this obtained? (required)"
                  aria-label="How was this obtained?"
                  aria-describedby="eligibility-note-hint"
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                />
                {note.trim().length < 5 && (
                  <span id="eligibility-note-hint">
                    Describe how permission was given — at least 5 characters ({note.trim().length}
                    /5).
                  </span>
                )}
              </label>
              <button
                type="button"
                disabled={note.trim().length < 5 || grant.isPending}
                onClick={() =>
                  grant.mutate(
                    { emails: selected, basis, note: note.trim() },
                    {
                      onSuccess: (r) =>
                        done(
                          `${r.granted.length} marked eligible${r.refused.length ? `; ${r.refused.length} refused (unsubscribed or complained)` : ''}.`,
                        ),
                    },
                  )
                }
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Mark {selected.length} eligible
              </button>
              <button
                type="button"
                onClick={() =>
                  withdraw.mutate(
                    { emails: selected },
                    { onSuccess: () => done('Eligibility withdrawn.') },
                  )
                }
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
              >
                Withdraw
              </button>
              <button
                type="button"
                disabled={note.trim().length < 3}
                onClick={() =>
                  suppress.mutate(
                    { emails: selected, note: note.trim() },
                    { onSuccess: () => done('Suppressed: they will receive no campaign email.') },
                  )
                }
                className="rounded-lg border border-rose-300 px-3 py-2 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                Suppress
              </button>
            </div>
          )}
        </div>
        {message && (
          <p role="status" className="border-t border-slate-100 px-4 py-2 text-sm text-emerald-800">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="border-t border-slate-100 px-4 py-2 text-sm text-red-700">
            {error instanceof ApiError ? error.message : 'Could not update.'}
          </p>
        )}
      </Card>

      {list.isLoading && <SkeletonRows rows={6} />}
      {list.error && <ErrorNotice message={(list.error as Error).message} />}
      {list.data && list.data.length === 0 && (
        <EmptyState
          title="No email addresses"
          description="Leads and contacts with an email address appear here."
        />
      )}
      {list.data && list.data.length > 0 && (
        <Card>
          <CardHeader title={`${list.data.length} addresses`} />
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  {canManage && (
                    <th className="w-8 px-4 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={selected.length > 0 && selected.length === selectable.length}
                        onChange={(e) =>
                          setSelected(e.target.checked ? selectable.map((r) => r.email) : [])
                        }
                      />
                    </th>
                  )}
                  <th className="px-4 py-2 font-medium">Person</th>
                  <th className="px-4 py-2 font-medium">Eligibility</th>
                  <th className="px-4 py-2 font-medium">Reason / evidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.map((r) => {
                  const locked = r.suppressed === 'UNSUBSCRIBED' || r.suppressed === 'COMPLAINT';
                  return (
                    <tr key={r.email}>
                      {canManage && (
                        <td className="px-4 py-2">
                          <input
                            type="checkbox"
                            disabled={locked}
                            checked={selected.includes(r.email)}
                            onChange={() => toggle(r.email)}
                            aria-label={`Select ${r.email}`}
                          />
                        </td>
                      )}
                      <td className="px-4 py-2">
                        <span className="font-medium text-slate-900">{r.name ?? r.email}</span>
                        <span className="block text-xs text-slate-500">
                          {r.email}
                          {r.company ? ` · ${r.company}` : ''}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {r.suppressed ? (
                          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-700">
                            {r.suppressed.toLowerCase()}
                          </span>
                        ) : r.status === 'GRANTED' ? (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">
                            eligible
                          </span>
                        ) : r.status === 'WITHDRAWN' ? (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                            not eligible
                          </span>
                        ) : (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                            not recorded
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-600">
                        {r.status === 'GRANTED' && r.basis
                          ? `${BASIS_LABELS[r.basis]}${r.note ? ` — ${r.note}` : ''}`
                          : (r.note ?? '—')}
                        {r.sources.length === 1 && r.sources[0] === 'MANUAL' && (
                          <span className="block text-slate-400">Added by hand</span>
                        )}
                        {r.recordedAt && (
                          <span className="block text-slate-400">{formatDate(r.recordedAt)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

const EMAIL_SHAPE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Records one address by hand — it need not be a lead or contact. Nothing is
 * pre-chosen: the person must say whether permission exists, and an eligible
 * record needs its basis, the date it was given, how, and may add details. The
 * server still refuses addresses that unsubscribed or complained.
 */
function AddEmail({
  onSaved,
}: {
  onSaved: (email: string, message: string) => void;
}): React.JSX.Element {
  const grant = useGrantEligibility();
  const withdraw = useWithdrawEligibility();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [decision, setDecision] = useState<'ELIGIBLE' | 'NOT_ELIGIBLE' | null>(null);
  const [basis, setBasis] = useState<MarketingConsentBasis | ''>('');
  const [givenOn, setGivenOn] = useState('');
  const [how, setHow] = useState('');
  const [details, setDetails] = useState('');

  const address = email.trim().toLowerCase();
  const evidence = `Given ${givenOn} via ${how.trim()}${details.trim() ? ` — ${details.trim()}` : ''}`;
  const ready =
    EMAIL_SHAPE.test(address) &&
    (decision === 'NOT_ELIGIBLE' ||
      (decision === 'ELIGIBLE' &&
        basis !== '' &&
        givenOn !== '' &&
        givenOn <= today() &&
        how.trim().length >= 3 &&
        evidence.length <= 500));
  const pending = grant.isPending || withdraw.isPending;
  const error = grant.error ?? withdraw.error;
  const reset = () => {
    setEmail('');
    setDecision(null);
    setBasis('');
    setGivenOn('');
    setHow('');
    setDetails('');
    setOpen(false);
  };

  if (!open) {
    return (
      <div className="mb-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50"
        >
          Add email
        </button>
      </div>
    );
  }

  return (
    <Card className="mb-4">
      <CardHeader
        title="Add an email address"
        subtitle="Any address — it does not need to be a lead or contact."
      />
      <form
        className="space-y-3 p-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          if (decision === 'ELIGIBLE' && basis !== '') {
            grant.mutate(
              { emails: [address], basis, note: evidence },
              {
                onSuccess: (r) => {
                  onSaved(
                    address,
                    r.granted.length
                      ? `${address} marked eligible.`
                      : `${address} was not marked eligible: it unsubscribed or complained.`,
                  );
                  reset();
                },
              },
            );
          } else {
            withdraw.mutate(
              {
                emails: [address],
                note: `Permission not established${details.trim() ? ` — ${details.trim()}` : ''}`,
              },
              {
                onSuccess: () => {
                  onSaved(address, `${address} recorded as not eligible.`);
                  reset();
                },
              },
            );
          }
        }}
      >
        <label className="block text-slate-700">
          Email address
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            autoComplete="off"
            className="mt-1 w-full max-w-md rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-slate-700">Marketing permission</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="decision"
              checked={decision === 'ELIGIBLE'}
              onChange={() => setDecision('ELIGIBLE')}
            />
            Eligible — permission is recorded
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="decision"
              checked={decision === 'NOT_ELIGIBLE'}
              onChange={() => setDecision('NOT_ELIGIBLE')}
            />
            Not eligible — permission not established
          </label>
        </fieldset>
        {decision === 'ELIGIBLE' && (
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <label className="block text-slate-700">
              Basis
              <select
                value={basis}
                onChange={(e) => setBasis(e.target.value as MarketingConsentBasis | '')}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2"
              >
                <option value="">Choose…</option>
                {MARKETING_CONSENT_BASES.map((b) => (
                  <option key={b} value={b}>
                    {BASIS_LABELS[b]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-slate-700">
              Date permission was given
              <input
                type="date"
                value={givenOn}
                max={today()}
                onChange={(e) => setGivenOn(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block text-slate-700 sm:col-span-2">
              How it was given (source)
              <input
                value={how}
                onChange={(e) => setHow(e.target.value)}
                maxLength={120}
                placeholder="e.g. signed enquiry form, email reply"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
          </div>
        )}
        {decision && (
          <label className="block max-w-2xl text-slate-700">
            Notes (optional)
            <input
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              maxLength={300}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
        )}
        {error && (
          <p role="alert" className="text-red-700">
            {error instanceof ApiError ? error.message : 'Could not save.'}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!ready || pending}
            className="rounded-lg bg-slate-900 px-3 py-2 font-medium text-white disabled:opacity-50"
          >
            {decision === 'NOT_ELIGIBLE' ? 'Save as not eligible' : 'Save as eligible'}
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-slate-300 px-3 py-2 hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
