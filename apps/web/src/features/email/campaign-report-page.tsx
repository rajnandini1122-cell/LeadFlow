import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PERMISSIONS, type EmailRecipientStatus } from '@leadflow/api-types';
import { useAuth } from '../auth/auth-context';
import { ApiError } from '../../lib/api-client';
import { formatDateTime } from '../../lib/format';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
} from '../../components/ui';
import { STATUS_STYLES } from './campaigns-page';
import { BroadcastRecoveryPanel } from './broadcast-recovery-panel';
import {
  CATEGORY_LABELS,
  useCampaign,
  useCampaignAction,
  useCampaignRecipients,
  useCampaignReplies,
} from './use-email';

const RECIPIENT_LABELS: Record<EmailRecipientStatus, string> = {
  QUEUED: 'Queued',
  SENDING: 'Being sent',
  ACCEPTED: 'Accepted by mail server',
  FAILED: 'Failed',
  UNCERTAIN: 'Unknown (not resent)',
  CANCELLED: 'Cancelled',
  SKIPPED: 'Skipped',
};

/**
 * One campaign's outcome, in the words that are true. "Accepted" means the
 * mail server took the message — not that it reached an inbox. There are no
 * open or click figures: LeadFlow does not track them, so it does not show them.
 */
export function CampaignReportPage(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { can } = useAuth();
  const live = useCampaign(id, true);
  const action = useCampaignAction();
  const [status, setStatus] = useState<EmailRecipientStatus | ''>('');
  const recipients = useCampaignRecipients(id, status);
  const replies = useCampaignReplies(id);

  if (live.isLoading) return <SkeletonRows rows={8} />;
  if (live.error || !live.data)
    return <ErrorNotice message={(live.error as Error | null)?.message ?? 'Campaign not found.'} />;
  const c = live.data;
  const n = c.counts;
  const canSend = can(PERMISSIONS.CAMPAIGN_SEND);
  // A broadcast waiting for review is decided in the recovery panel, not by resume/cancel.
  const inReview = c.broadcast?.needsReview === true;
  const run = (verb: 'pause' | 'resume' | 'cancel') => {
    if (
      verb === 'cancel' &&
      !window.confirm('Cancel this campaign? Messages still queued will not be sent.')
    )
      return;
    action.mutate({ id, action: verb });
  };

  const tiles: { label: string; value: number; hint?: string }[] = [
    { label: 'Matched the filters', value: n.selected },
    { label: 'Eligible', value: n.eligible },
    {
      label: 'Left out',
      value: Object.values(n.excluded).reduce((a, b) => a + (b ?? 0), 0),
      hint: Object.entries(n.excluded)
        .filter(([, v]) => v)
        .map(([k, v]) => `${v} ${k.toLowerCase().replace('_', ' ')}`)
        .join(', '),
    },
    { label: 'Queued', value: n.queued + n.sending },
    { label: 'Attempted', value: n.attempted },
    { label: 'Accepted by mail server', value: n.accepted, hint: 'Not proof of inbox delivery' },
    { label: 'Temporary failures (retrying)', value: n.retrying },
    { label: 'Permanent failures', value: n.failed },
    {
      label: 'Unknown outcome',
      value: n.uncertain,
      hint: 'Connection lost while sending; never resent',
    },
    { label: 'Skipped at send time', value: n.skipped, hint: 'Unsubscribed or no longer eligible' },
    { label: 'Replies', value: n.replies },
    { label: 'Unsubscribes', value: n.unsubscribes },
  ];

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={
          <span>
            <Link to="/campaigns" className="hover:underline">
              ← All campaigns
            </Link>{' '}
            · {CATEGORY_LABELS[c.category]} ·{' '}
            {c.purpose === 'PROMOTIONAL' ? 'Promotional' : 'Service message'}
          </span>
        }
        action={
          canSend && (
            <div className="flex gap-2">
              {(c.status === 'SENDING' || c.status === 'SCHEDULED') && (
                <button
                  type="button"
                  onClick={() => run('pause')}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
                >
                  Pause
                </button>
              )}
              {c.status === 'PAUSED' && !inReview && (
                <button
                  type="button"
                  onClick={() => run('resume')}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
                >
                  Resume
                </button>
              )}
              {['SCHEDULED', 'SENDING', 'PAUSED'].includes(c.status) && !inReview && (
                <button
                  type="button"
                  onClick={() => run('cancel')}
                  className="rounded-lg border border-rose-300 px-3 py-2 text-sm text-rose-700 hover:bg-rose-50"
                >
                  Cancel
                </button>
              )}
            </div>
          )
        }
      />
      {action.error && (
        <ErrorNotice
          message={
            action.error instanceof ApiError
              ? action.error.message
              : 'Could not update the campaign.'
          }
        />
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[c.status]}`}
        >
          {c.status.toLowerCase()}
        </span>
        {c.scheduledAt && c.status === 'SCHEDULED' && (
          <span className="text-slate-600">Starts {formatDateTime(c.scheduledAt)}</span>
        )}
        {c.startedAt && (
          <span className="text-slate-600">Started {formatDateTime(c.startedAt)}</span>
        )}
        {c.completedAt && (
          <span className="text-slate-600">Finished {formatDateTime(c.completedAt)}</span>
        )}
        {c.pauseReason && (
          <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-800">{c.pauseReason}</span>
        )}
      </div>

      {c.broadcast && (
        <BroadcastRecoveryPanel campaignId={c.id} broadcast={c.broadcast} canDecide={canSend} />
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="rounded-xl border border-slate-200 bg-white p-3"
            title={t.hint}
          >
            <p className="text-xs text-slate-500">{t.label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{t.value}</p>
            {t.hint && <p className="mt-0.5 truncate text-[11px] text-slate-400">{t.hint}</p>}
          </div>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Recipients"
            action={
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as EmailRecipientStatus | '')}
                className="rounded border border-slate-300 px-2 py-1 text-xs"
              >
                <option value="">All</option>
                {(Object.keys(RECIPIENT_LABELS) as EmailRecipientStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {RECIPIENT_LABELS[s]}
                  </option>
                ))}
              </select>
            }
          />
          {recipients.data && recipients.data.length === 0 && (
            <EmptyState title="Nobody here" description="No recipient has this status." />
          )}
          <ul className="max-h-[480px] divide-y divide-slate-100 overflow-y-auto text-sm">
            {recipients.data?.map((r) => (
              <li key={r.id} className="px-5 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate">
                    {r.leadId ? (
                      <Link to={`/leads/${r.leadId}`} className="hover:underline">
                        {r.name ?? r.email}
                      </Link>
                    ) : (
                      (r.name ?? r.email)
                    )}
                    <span className="block truncate text-xs text-slate-500">{r.email}</span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-600">
                    {RECIPIENT_LABELS[r.status]}
                  </span>
                </div>
                {(r.lastResponse || r.skipReason) && (
                  <p
                    className="mt-1 truncate text-xs text-slate-500"
                    title={r.lastResponse ?? r.skipReason ?? ''}
                  >
                    {r.lastSmtpCode ? `${r.lastSmtpCode} · ` : ''}
                    {r.lastResponse ?? r.skipReason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader
            title="Replies"
            subtitle="Read from your inbox every few minutes. Shown as text only."
          />
          {replies.data && replies.data.length === 0 && (
            <EmptyState
              title="No replies yet"
              description="Replies to this campaign appear here and on the lead’s history."
            />
          )}
          <ul className="max-h-[480px] divide-y divide-slate-100 overflow-y-auto text-sm">
            {replies.data?.map((r) => (
              <li key={r.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-slate-900">{r.leadName ?? r.fromAddress}</span>
                  <span className="text-xs text-slate-500">{formatDateTime(r.receivedAt)}</span>
                </div>
                <p className="text-xs text-slate-500">
                  {r.fromAddress} · {r.subject}
                </p>
                {r.snippet && (
                  <p className="mt-1 whitespace-pre-wrap text-slate-700">{r.snippet}</p>
                )}
                {r.leadId && (
                  <Link
                    to={`/leads/${r.leadId}`}
                    className="mt-2 inline-block text-xs font-medium text-slate-900 underline"
                  >
                    Open lead and schedule a follow-up
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
