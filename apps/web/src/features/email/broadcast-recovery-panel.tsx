import { useState, type FormEvent } from 'react';
import type { EmailBroadcastExposure, EmailBroadcastView } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { formatDateTime } from '../../lib/format';
import { Card, CardHeader } from '../../components/ui';
import { useResolveBroadcast } from './use-email';

type Decision = 'retry' | 'abandon';

const STATE_LABELS: Record<string, string> = {
  PENDING: 'Preparing contacts',
  CONTACTS_SYNCED: 'Contacts synced',
  SEGMENT_READY: 'Audience ready',
  DRAFT_CREATED: 'Draft created at Resend',
  SEND_REQUESTED: 'Send requested — confirming with Resend',
  HANDED_OFF: 'Handed to Resend',
  CANCELLED_AT_PROVIDER: 'Cancelled at Resend',
  BLOCKED: 'Paused by a safety check',
  NEEDS_REVIEW: 'Needs review',
};

export const EXPOSURE_TEXT: Record<EmailBroadcastExposure, string> = {
  NOT_SENT: 'No send was ever requested from Resend. Nobody has received this campaign.',
  MAY_HAVE_BEEN_SENT:
    'A send was requested, but Resend never confirmed the result. Some or all recipients may already have received it. LeadFlow will not send again without a fresh status check.',
  HANDED_TO_RESEND:
    'Resend has accepted this broadcast. Recipients may have received it, and sent emails cannot be recalled.',
};

const OUTCOME_LABELS: Record<string, string> = {
  retrying: 'Retrying from the confirmed draft',
  abandoned: 'Abandoned',
  already_handed_off: 'Resend had already accepted it — recorded, not resent',
  cancelled_at_provider: 'Resend had cancelled it',
  refused: 'Refused',
};

/**
 * The recovery panel for a Resend broadcast LeadFlow would not decide on by
 * itself (NEEDS_REVIEW). It only ever calls the one resolution endpoint; the
 * server reads Resend's live status first and decides what is safe. The page
 * cannot make a retry happen that the server would refuse.
 */
export function BroadcastRecoveryPanel({
  campaignId,
  broadcast,
  canDecide,
}: {
  campaignId: string;
  broadcast: EmailBroadcastView;
  canDecide: boolean;
}): React.JSX.Element {
  const [decision, setDecision] = useState<{ action: Decision; version: number } | null>(null);
  const b = broadcast;

  return (
    <Card className="mb-6">
      <CardHeader title="Resend broadcast" />
      <div className="space-y-4 p-4 text-sm">
        {b.needsReview && (
          <div
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900"
          >
            <p className="font-medium">This broadcast needs a decision.</p>
            <p className="mt-1">
              LeadFlow stopped instead of guessing. Nothing more is sent until an administrator
              decides below.
            </p>
          </div>
        )}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <Fact label="State">
            {b.state ? (STATE_LABELS[b.state] ?? b.state) : '—'}
            {b.stateAt && <span className="text-slate-500"> · {formatDateTime(b.stateAt)}</span>}
          </Fact>
          <Fact label="Last check with Resend">
            {b.lastCheckedAt ? (
              <>
                {formatDateTime(b.lastCheckedAt)}
                {b.lastProviderStatus && (
                  <span className="text-slate-500"> · Resend said “{b.lastProviderStatus}”</span>
                )}
              </>
            ) : (
              'Not checked yet'
            )}
          </Fact>
          <Fact label="Resend broadcast ID">
            {b.providerBroadcastId ? (
              <code className="break-all text-xs">{b.providerBroadcastId}</code>
            ) : (
              'Not created yet'
            )}
          </Fact>
          <Fact label="Send requested">
            {b.sendRequestedAt ? formatDateTime(b.sendRequestedAt) : 'Never'}
          </Fact>
          {b.error && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-slate-500">Reason</dt>
              <dd className="text-slate-800">{b.error}</dd>
            </div>
          )}
          <div className="sm:col-span-2">
            <dt className="text-xs text-slate-500">Could anyone already have it?</dt>
            <dd className="text-slate-800" data-testid="broadcast-exposure">
              {EXPOSURE_TEXT[b.exposure]}
            </dd>
          </div>
        </dl>

        {b.needsReview && canDecide && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setDecision({ action: 'retry', version: b.version })}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Recheck &amp; retry if safe
            </button>
            <button
              type="button"
              onClick={() => setDecision({ action: 'abandon', version: b.version })}
              className="rounded-lg border border-rose-300 px-3 py-2 text-sm text-rose-700 hover:bg-rose-50"
            >
              Abandon campaign
            </button>
          </div>
        )}
        {b.needsReview && !canDecide && (
          <p className="text-slate-600">
            Only an organisation administrator can decide what happens to this broadcast.
          </p>
        )}

        {b.reviews.length > 0 && <ReviewHistory reviews={b.reviews} />}
      </div>

      {decision && (
        <ConfirmDecision
          campaignId={campaignId}
          broadcast={b}
          action={decision.action}
          version={decision.version}
          onClose={() => setDecision(null)}
        />
      )}
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}

/** What each decision actually does, given what LeadFlow knows right now. */
export function consequences(action: Decision, b: EmailBroadcastView): string[] {
  if (action === 'retry') {
    return [
      'LeadFlow first asks Resend for the broadcast’s live status.',
      'If Resend shows it queued, scheduled or sent, that is recorded and it is NOT sent again.',
      b.providerBroadcastId
        ? 'Only if Resend confirms it is still an unsent draft does LeadFlow re-check every recipient’s eligibility and request the send — once.'
        : 'No broadcast exists at Resend yet: LeadFlow restarts from contact sync. Every step is safe to repeat, and eligibility is re-checked before the send.',
      'If Resend’s status cannot be read, nothing changes and the campaign stays here.',
    ];
  }
  return [
    'LeadFlow first asks Resend for the broadcast’s live status. If Resend already queued or sent it, that is recorded instead — sent emails cannot be recalled.',
    'Otherwise the campaign is cancelled in LeadFlow and cannot be resumed or sent.',
    b.exposure === 'MAY_HAVE_BEEN_SENT'
      ? 'If Resend’s status cannot be read, recipients are marked “Unknown outcome”, because they may already have it.'
      : 'Recipients still waiting are marked cancelled.',
  ];
}

function ConfirmDecision({
  campaignId,
  broadcast,
  action,
  version,
  onClose,
}: {
  campaignId: string;
  broadcast: EmailBroadcastView;
  action: Decision;
  version: number;
  onClose: () => void;
}): React.JSX.Element {
  const resolve = useResolveBroadcast();
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  // The page refreshes while the dialog is open: a decision on an older picture is not allowed.
  const stale = broadcast.version !== version || !broadcast.needsReview;
  const title = action === 'retry' ? 'Recheck & retry if safe' : 'Abandon campaign';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (resolve.isPending || stale) return;
    setFailure(null);
    resolve.mutate(
      { id: campaignId, action, reason: reason.trim(), expectedVersion: version },
      {
        onSuccess: () => onClose(),
        onError: (error) =>
          setFailure(error instanceof ApiError ? error.message : 'Could not reach LeadFlow.'),
      },
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="broadcast-decision-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
      >
        <h2 id="broadcast-decision-title" className="text-lg font-semibold text-slate-900">
          {title}
        </h2>
        <p className="mt-2 text-sm text-slate-700">{EXPOSURE_TEXT[broadcast.exposure]}</p>
        <h3 className="mt-4 text-sm font-medium text-slate-900">What will happen</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {consequences(action, broadcast).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <label className="mt-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Reason (kept in the audit trail)
          </span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={3}
            required
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="e.g. Checked Resend: the broadcast is still a draft"
          />
        </label>

        {stale && (
          <p role="alert" className="mt-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This broadcast changed while the dialog was open (someone else may have acted). Close
            this and look again before deciding.
          </p>
        )}
        {failure && (
          <p role="alert" className="mt-3 rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {failure}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
          >
            Close
          </button>
          <button
            type="submit"
            disabled={resolve.isPending || stale || reason.trim().length < 3}
            className={`rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              action === 'retry'
                ? 'bg-slate-900 hover:bg-slate-800'
                : 'bg-rose-600 hover:bg-rose-700'
            }`}
          >
            {resolve.isPending
              ? 'Checking with Resend…'
              : action === 'retry'
                ? 'Confirm: recheck and retry if safe'
                : 'Confirm: abandon campaign'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ReviewHistory({ reviews }: { reviews: EmailBroadcastView['reviews'] }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-slate-900">Decisions</h3>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {reviews.map((r) => (
          <li key={r.id} className="p-3">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-medium text-slate-800">
                {r.action === 'retry' ? 'Recheck & retry' : 'Abandon'} —{' '}
                {OUTCOME_LABELS[r.outcome] ?? r.outcome}
              </span>
              <span className="text-xs text-slate-500">
                {r.actorName ?? 'Unknown user'} · {formatDateTime(r.createdAt)}
              </span>
            </div>
            <p className="mt-1 text-slate-700">“{r.reason}”</p>
            {r.refusal && <p className="mt-1 text-rose-700">{r.refusal}</p>}
            <p className="mt-1 text-xs text-slate-500">
              {r.previousState ?? '—'} ({r.previousStatus.toLowerCase()}) →{' '}
              {r.resultingState ?? '—'} ({r.resultingStatus.toLowerCase()})
              {r.providerStatus && ` · Resend said “${r.providerStatus}”`}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
