import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { IntegrationIntakeDetail } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { ENQUIRY_TYPE_LABELS } from './enquiry-types';
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

      {/*
        What the customer said they want.
        Rendered as its own block and ONLY when something is there: an enquiry
        from a simple contact form carries none of this, and six empty dashes
        would bury the fields that do have values.
      */}
      {hasClassification(intake) && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-slate-600">Enquiry</h3>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {intake.enquiryType && (
              <Field label="Type" value={ENQUIRY_TYPE_LABELS[intake.enquiryType]} />
            )}
            {intake.quantity && <Field label="Quantity" value={intake.quantity} />}
            {intake.destinationCountry && (
              <Field label="Ships to" value={intake.destinationCountry} />
            )}
            {(intake.city || intake.state) && (
              <Field
                label="Location"
                value={[intake.city, intake.state].filter(Boolean).join(', ')}
              />
            )}
            {intake.sampleRequired !== null && (
              <Field label="Sample requested" value={intake.sampleRequired ? 'Yes' : 'No'} />
            )}
          </dl>
        </div>
      )}

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

      <SubmissionReference submissionId={intake.submissionId} />

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

/**
 * Whether this enquiry carries any classification at all.
 *
 * `sampleRequired` is compared against null rather than truth-tested, because
 * `false` is a real answer — the visitor was asked and said no — and hiding it
 * would lose the distinction from never having been asked.
 */
function hasClassification(intake: IntegrationIntakeDetail): boolean {
  return (
    intake.enquiryType !== null ||
    intake.quantity !== null ||
    intake.destinationCountry !== null ||
    intake.city !== null ||
    intake.state !== null ||
    intake.sampleRequired !== null
  );
}

/**
 * The website's own reference for this submission.
 *
 * The question this answers is support's: "did submission X reach LeadFlow?"
 * Somebody holding a reference from the website side can now paste it into the
 * queue filter and see the answer, instead of asking for a database query.
 *
 * Shown in monospace and selectable on focus because it is read aloud and
 * pasted, not skimmed. Copying is best-effort: `navigator.clipboard` is absent
 * over plain HTTP and may be refused outright, so the input beside the button
 * remains the reliable way to get the value out.
 */
function SubmissionReference({ submissionId }: { submissionId: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <label
        htmlFor={`submission-${submissionId}`}
        className="mb-1 block text-xs text-slate-500"
      >
        Submission reference
      </label>
      <div className="flex gap-2">
        <input
          id={`submission-${submissionId}`}
          readOnly
          value={submissionId}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-xs text-slate-700"
        />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(submissionId);
            setCopied(true);
          }}
          className="shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        The website&rsquo;s own id for this submission. Quote it when asking whether an enquiry
        arrived.
      </p>
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
