import { Link } from 'react-router-dom';
import { PERMISSIONS, type EmailCampaignStatus } from '@leadflow/api-types';
import { useAuth } from '../auth/auth-context';
import { formatDateTime } from '../../lib/format';
import { Card, EmptyState, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { CATEGORY_LABELS, useCampaigns, useMailbox } from './use-email';

export const STATUS_STYLES: Record<EmailCampaignStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  SCHEDULED: 'bg-indigo-100 text-indigo-700',
  SENDING: 'bg-sky-100 text-sky-700',
  PAUSED: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-rose-100 text-rose-700',
};

export function CampaignsPage(): React.JSX.Element {
  const { can } = useAuth();
  const campaigns = useCampaigns();
  const mailbox = useMailbox();
  const canManage = can(PERMISSIONS.CAMPAIGN_MANAGE);

  return (
    <>
      <PageHeader
        title="Email campaigns"
        subtitle="Offers, announcements and updates to the leads and contacts who may receive them"
        action={
          <div className="flex gap-2">
            <Link
              to="/campaigns/eligibility"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
            >
              Marketing eligibility
            </Link>
            {canManage && (
              <Link
                to="/campaigns/new"
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                New campaign
              </Link>
            )}
          </div>
        }
      />
      {mailbox.data && !mailbox.data.configured && can(PERMISSIONS.EMAIL_SETTINGS_MANAGE) && (
        <p className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Connect your company mailbox in{' '}
          <Link className="underline" to="/settings/email">
            Email account
          </Link>{' '}
          before sending.
        </p>
      )}
      {campaigns.isLoading && <SkeletonRows rows={5} />}
      {campaigns.error && <ErrorNotice message={(campaigns.error as Error).message} />}
      {campaigns.data && campaigns.data.length === 0 && (
        <EmptyState
          title="No campaigns yet"
          description="Create a campaign, choose who receives it, preview it and send yourself a test."
        />
      )}
      {campaigns.data && campaigns.data.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Campaign</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Recipients</th>
                  <th
                    className="px-4 py-2 text-right font-medium"
                    title="Accepted by the mail server — not proof of inbox delivery"
                  >
                    Accepted
                  </th>
                  <th className="px-4 py-2 text-right font-medium">Failed</th>
                  <th className="px-4 py-2 text-right font-medium">Replies</th>
                  <th className="px-4 py-2 text-right font-medium">Unsubscribed</th>
                  <th className="px-4 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {campaigns.data.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <Link
                        to={c.status === 'DRAFT' ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {c.name}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {CATEGORY_LABELS[c.category]} ·{' '}
                        {c.purpose === 'PROMOTIONAL' ? 'Promotional' : 'Service message'}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[c.status]}`}
                      >
                        {c.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {c.status === 'DRAFT' ? '—' : c.counts.eligible}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{c.counts.accepted}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{c.counts.failed}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{c.counts.replies}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{c.counts.unsubscribes}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {formatDateTime(c.scheduledAt ?? c.confirmedAt ?? c.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
