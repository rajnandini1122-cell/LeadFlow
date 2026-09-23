import { Link } from 'react-router-dom';
import type { IntegrationIntakeDetail } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { useIntake, useRetryIntake } from './use-intakes';

/**
 * One enquiry, in full.
 *
 * The customer's own message is the point of this panel. Everything else on
 * the screen is about routing; this is the only place the words somebody
 * actually typed appear, and a salesperson picking up a lead needs them more
 * than they need a rule name.
 */
export function IntakeDetail({
  intakeId,
  canManage,
}: {
  intakeId: string;
  canManage: boolean;
}): React.JSX.Element {
  const detail = useIntake(intakeId);
  const retry = useRetryIntake();

  if (detail.isPending) {
    return <p className="px-5 py-4 text-xs text-slate-500">Loading enquiry…</p>;
  }

  if (detail.isError || !detail.data) {
    return (
      <p role="alert" className="px-5 py-4 text-xs text-red-600">
        This enquiry could not be loaded.
      </p>
    );
  }

  const intake = detail.data;
  const retryable = intake.status === 'BLOCKED' || intake.status === 'FAILED';

  return (
    <div className="space-y-4 px-5 py-4" data-testid="intake-detail">
      {intake.message && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-slate-600">What they wrote</h3>
          <p className="whitespace-pre-wrap rounded-lg bg-white px-3 py-2 text-sm text-slate-800">
            {intake.message}
          </p>
        </div>
      )}

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Field label="Email" value={intake.email} />
        <Field label="Phone" value={intake.phone} />
        <Field label="Country" value={intake.country} />
        <Field label="Asked about" value={intake.productInterest} />
        <Field label="Page" value={intake.sourcePage} />
        <Field label="Arrived" value={new Date(intake.receivedAt).toLocaleString()} />
      </dl>

      <div>
        <h3 className="mb-1 text-xs font-medium text-slate-600">Routing</h3>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Field label="Territory" value={intake.territory?.name ?? null} />
          <Field label="Rule" value={intake.rule?.name ?? null} />
          <Field label="Team" value={intake.team?.name ?? null} />
          <Field label="Agent" value={intake.assignedTo?.fullName ?? null} />
        </dl>
      </div>

      {intake.createdLead && (
        <p className="text-sm text-slate-700">
          Became{' '}
          <Link
            to={`/leads/${intake.createdLead.id}`}
            className="font-medium text-slate-900 underline"
          >
            {intake.createdLead.leadNumber}
          </Link>
        </p>
      )}

      {intake.status === 'DUPLICATE' && (
        <DuplicateNotice
          matchedLeadId={intake.matchedLeadId}
          reason={intake.failureReason}
        />
      )}

      {intake.failureReason && intake.status !== 'DUPLICATE' && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {intake.failureReason}
        </p>
      )}

      {retryable && canManage && (
        <div>
          <button
            type="button"
            onClick={() => retry.mutate(intakeId)}
            disabled={retry.isPending}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {retry.isPending ? 'Routing…' : 'Retry routing'}
          </button>
          {/* Says exactly what the button does, because the obvious guess —
              "resend to the customer", "edit and resubmit" — is wrong. */}
          <p className="mt-1 text-xs text-slate-500">
            Runs the routing again on this same enquiry. Nothing the customer sent is changed.
          </p>
          {retry.isError && (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {retry.error instanceof ApiError
                ? retry.error.message
                : 'This enquiry could not be routed.'}
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-slate-400">
        {intake.processingAttempts === 0
          ? 'Not yet processed.'
          : `Processed ${intake.processingAttempts} ${
              intake.processingAttempts === 1 ? 'time' : 'times'
            }${
              intake.lastProcessingAt
                ? `, last ${new Date(intake.lastProcessingAt).toLocaleString()}`
                : ''
            }.`}
      </p>
    </div>
  );
}

/**
 * Held for a person to decide.
 *
 * Deliberately offers no "create anyway". Both the intake boundary and the
 * conversion stop here so somebody can look; a button that overrode that would
 * be the decision made by whoever clicked first, with no record of what they
 * were shown.
 */
function DuplicateNotice({
  matchedLeadId,
  reason,
}: {
  matchedLeadId: string | null;
  reason: string | null;
}): React.JSX.Element {
  return (
    <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <p className="font-medium">Looks like somebody already in the CRM.</p>
      <p className="mt-0.5">{reason ?? 'Held for review — nothing existing was changed.'}</p>
      {matchedLeadId && (
        <Link to={`/leads/${matchedLeadId}`} className="mt-1 inline-block underline">
          Open the matching lead
        </Link>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-slate-800">{value || <span className="text-slate-400">—</span>}</dd>
    </div>
  );
}

export type { IntegrationIntakeDetail };
