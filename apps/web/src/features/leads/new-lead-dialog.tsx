import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { OrganizationDetail } from '@leadflow/api-types';
import {
  LEAD_PRIORITIES,
  LEAD_STATUSES,
  isTerminalLeadStatus,
  type LeadPriority,
  type LeadStatus,
} from '@leadflow/api-types';
import { ApiError, apiGet, apiPost } from '../../lib/api-client';
import { currencySymbol, humanise } from '../../lib/format';
import type { LeadSummary } from './use-leads';

/**
 * Neutral fallback, used only when an organization has configured none of its
 * own. Previously this was a fixed India-centric list baked into the client.
 */
const FALLBACK_SOURCES = [
  'Website',
  'Referral',
  'Inbound call',
  'Email',
  'Trade show',
  'Social media',
  'Partner',
  'Outbound',
  'Other',
];

interface ExistingLead {
  id: string;
  leadNumber: string;
  name: string;
  status: string;
}

/** Default follow-up: tomorrow at 11:00, a sane working-hours slot. */
function defaultFollowUp(): string {
  const date = new Date(Date.now() + 86_400_000);
  date.setHours(11, 0, 0, 0);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/**
 * Values a caller can seed the form with.
 *
 * Added for "Create lead" in the channel review queue, which knows the
 * customer's name, number and what they asked for. It is a PREFILL and nothing
 * more: the form still renders, the user still edits and submits it, and the
 * ordinary POST /leads still applies every validation and duplicate check. A
 * conversation must not be able to conjure a lead the user never saw.
 */
export interface NewLeadPrefill {
  firstName?: string | undefined;
  lastName?: string | undefined;
  mobile?: string | undefined;
  email?: string | undefined;
  companyName?: string | undefined;
  source?: string | undefined;
  productInterest?: string | undefined;
}

export function NewLeadDialog({
  open,
  onClose,
  prefill,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  prefill?: NewLeadPrefill | undefined;
  /**
   * Called with the created lead so a caller can act on it — the review queue
   * uses this to link the originating conversation. Runs after the lead exists,
   * never instead of creating it.
   */
  onCreated?: ((lead: LeadSummary) => void) | undefined;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [city, setCity] = useState('');
  const [source, setSource] = useState('');
  const [productInterest, setProductInterest] = useState('');
  const [estimatedValue, setEstimatedValue] = useState('');
  const [status, setStatus] = useState<LeadStatus>('NEW');
  const [priority, setPriority] = useState<LeadPriority>('MEDIUM');
  const [assignedToId, setAssignedToId] = useState('');
  const [nextFollowUpAt, setNextFollowUpAt] = useState(defaultFollowUp());

  const [duplicate, setDuplicate] = useState<ExistingLead | null>(null);

  const organization = useQuery({
    queryKey: ['organization'],
    queryFn: () => apiGet<OrganizationDetail>('/organizations/current'),
    enabled: open,
  });

  const sources =
    organization.data?.settings.leadSources.length
      ? organization.data.settings.leadSources
      : FALLBACK_SOURCES;

  const assignable = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => apiGet<{ id: string; fullName: string }[]>('/leads/assignable-users'),
    enabled: open,
  });

  const reset = (): void => {
    setFirstName('');
    setLastName('');
    setMobile('');
    setEmail('');
    setCompanyName('');
    setCity('');
    setProductInterest('');
    setEstimatedValue('');
    setStatus('NEW');
    setPriority('MEDIUM');
    setAssignedToId('');
    setNextFollowUpAt(defaultFollowUp());
    setDuplicate(null);
  };

  /*
   * Seed the fields when the dialog opens with a prefill.
   *
   * Keyed on `open` so reopening restores the suggestion after the user has
   * edited it, and so a prefill never overwrites what someone is currently
   * typing.
   */
  useEffect(() => {
    if (!open || !prefill) return;
    if (prefill.firstName !== undefined) setFirstName(prefill.firstName);
    if (prefill.lastName !== undefined) setLastName(prefill.lastName);
    if (prefill.mobile !== undefined) setMobile(prefill.mobile);
    if (prefill.email !== undefined) setEmail(prefill.email);
    if (prefill.companyName !== undefined) setCompanyName(prefill.companyName);
    if (prefill.source !== undefined) setSource(prefill.source);
    if (prefill.productInterest !== undefined) setProductInterest(prefill.productInterest);
    // Depends on `open` alone, deliberately: see the comment above.
  }, [open]);

  // Escape closes, matching every other dialog people use.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const terminal = isTerminalLeadStatus(status);

  const create = useMutation({
    mutationFn: (allowDuplicate: boolean) =>
      apiPost<LeadSummary>('/leads', {
        firstName,
        ...(lastName ? { lastName } : {}),
        mobile,
        ...(email ? { email } : {}),
        ...(companyName ? { companyName } : {}),
        ...(city ? { city } : {}),
        ...(source ? { source } : {}),
        ...(productInterest ? { productInterest } : {}),
        ...(estimatedValue ? { estimatedValue: Number(estimatedValue) } : {}),
        status,
        priority,
        ...(assignedToId ? { assignedToId } : {}),
        // A terminal lead has no next action — the server rejects one, and the
        // database CHECK constraint would too.
        ...(terminal ? {} : { nextFollowUpAt: new Date(nextFollowUpAt).toISOString() }),
        ...(allowDuplicate ? { allowDuplicate: true } : {}),
      }),
    onSuccess: (lead) => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      onCreated?.(lead);
      reset();
      onClose();
    },
    onError: (error) => {
      // 409 is not a failure to show as a red box — it is a decision the user
      // needs to make, so it becomes a branch in the UI.
      if (error instanceof ApiError && error.code === 'DUPLICATE_LEAD' && error.details) {
        setDuplicate({
          id: error.details['existingLeadId']?.[0] ?? '',
          leadNumber: error.details['existingLeadNumber']?.[0] ?? '',
          name: error.details['existingLeadName']?.[0] ?? '',
          status: error.details['existingLeadStatus']?.[0] ?? '',
        });
      }
    },
  });

  if (!open) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setDuplicate(null);
    create.mutate(false);
  };

  const fieldError = (field: string): string | undefined => {
    if (!(create.error instanceof ApiError)) return undefined;
    return create.error.details?.[field]?.[0];
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="my-8 w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">New lead</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {duplicate && (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-4">
            <p className="text-sm font-medium text-amber-900">This customer already exists</p>
            <p className="mt-1 text-sm text-amber-800">
              <span className="font-mono text-xs">{duplicate.leadNumber}</span> —{' '}
              {duplicate.name} ({humanise(duplicate.status)}) has the same mobile number.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                to={`/leads/${duplicate.id}`}
                onClick={onClose}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800"
              >
                Open existing lead
              </Link>
              <button
                type="button"
                onClick={() => create.mutate(true)}
                disabled={create.isPending}
                className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
              >
                Create anyway
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-600 transition hover:bg-amber-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" required error={fieldError('firstName')}>
              <input
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                required
                minLength={2}
                className={inputClass}
              />
            </Field>
            <Field label="Last name">
              <input
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Mobile"
              required
              hint="Local or international format. Stored as E.164 and used to detect duplicates."
              error={fieldError('mobile')}
            >
              <input
                value={mobile}
                onChange={(event) => setMobile(event.target.value)}
                required
                inputMode="tel"
                placeholder="Phone number"
                className={inputClass}
              />
            </Field>
            <Field label="Email" error={fieldError('email')}>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company">
              <input
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="City">
              <input
                value={city}
                onChange={(event) => setCity(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Product interest">
            <input
              value={productInterest}
              onChange={(event) => setProductInterest(event.target.value)}
              placeholder="What are they asking about?"
              className={inputClass}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Source">
              <select
                value={source}
                onChange={(event) => setSource(event.target.value)}
                className={inputClass}
              >
                <option value="">Not specified</option>
                {sources.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </Field>
            <Field
              label="Estimated value"
              hint={currencySymbol()}
              error={fieldError('estimatedValue')}
            >
              <input
                type="number"
                min={0}
                value={estimatedValue}
                onChange={(event) => setEstimatedValue(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Priority">
              <select
                value={priority}
                onChange={(event) => setPriority(event.target.value as LeadPriority)}
                className={inputClass}
              >
                {LEAD_PRIORITIES.map((option) => (
                  <option key={option} value={option}>
                    {humanise(option)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Status">
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as LeadStatus)}
                className={inputClass}
              >
                {LEAD_STATUSES.map((option) => (
                  <option key={option} value={option}>
                    {humanise(option)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Assign to">
              <select
                value={assignedToId}
                onChange={(event) => setAssignedToId(event.target.value)}
                className={inputClass}
              >
                <option value="">Unassigned</option>
                {(assignable.data ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.fullName}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* The product promise, enforced in the form as well as the database. */}
          <Field
            label="Next follow-up"
            required={!terminal}
            hint={
              terminal
                ? 'Not needed — a won or lost lead has no next action.'
                : 'Every active lead must have one. No lead left behind.'
            }
            error={fieldError('nextFollowUpAt')}
          >
            <input
              type="datetime-local"
              value={nextFollowUpAt}
              onChange={(event) => setNextFollowUpAt(event.target.value)}
              required={!terminal}
              disabled={terminal}
              className={inputClass}
            />
          </Field>

          {create.isError && !duplicate && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {create.error instanceof ApiError
                ? create.error.message
                : 'Could not create the lead.'}
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              {create.isPending ? 'Creating…' : 'Create lead'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-1 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-400';

function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  // Explicit `| undefined`: with exactOptionalPropertyTypes, an optional prop
  // will not accept an explicitly-undefined value, and fieldError() returns
  // undefined whenever there is no error for that field.
  required?: boolean | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-red-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}
