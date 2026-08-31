import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PERMISSIONS } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import {
  ACCOUNT_STATUS_PRESENTATION,
  formatCustomerKpi,
  useChangeAccountStatus,
  useCustomer360,
  type AccountStatus,
  type Customer360,
  type Opportunity,
} from './use-accounts';

/**
 * Customer 360 — one customer's whole relationship on one screen.
 *
 * Everything here is assembled from what LeadFlow already records: leads are
 * the opportunities, the lead timeline is the activity, and conversations come
 * from the existing inbox. Nothing on this page is a second copy of any of
 * them.
 *
 * The commercial figures are labelled CRM opportunity figures because that is
 * what they are — there is no order table behind them, and implying invoiced
 * revenue would be a lie that gets quoted in a meeting.
 */
export function Customer360Page(): React.JSX.Element {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const customer = useCustomer360(id);

  if (customer.isPending) return <SkeletonRows rows={8} />;

  if (customer.isError) {
    const message =
      customer.error instanceof ApiError
        ? customer.error.message
        : 'Could not load this customer.';

    return (
      <>
        <PageHeader title="Customer" subtitle="" />
        <ErrorNotice message={message} />
        <Link to="/customers" className="mt-4 inline-block text-sm text-slate-600 underline">
          ← Back to customers
        </Link>
      </>
    );
  }

  const data = customer.data;
  const presentation = ACCOUNT_STATUS_PRESENTATION[data.account.status];

  return (
    <>
      <PageHeader
        title={data.account.name}
        subtitle={
          [
            presentation.label,
            data.account.industry,
            data.account.city,
            data.account.owner ? `Owner: ${data.account.owner.fullName}` : null,
          ]
            .filter(Boolean)
            .join(' · ')
        }
        action={
          <Link
            to="/customers"
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            All customers
          </Link>
        }
      />

      <Header data={data} canChangeStatus={can(PERMISSIONS.ACCOUNT_STATUS_CHANGE)} accountId={id} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Opportunities
            title="Open opportunities"
            subtitle="What is being worked on right now."
            data={data.openOpportunities}
            open
          />
          <Opportunities
            title="History"
            subtitle="Every opportunity that has closed, won or lost."
            data={data.closedOpportunities}
            open={false}
          />
          <ProductHistory data={data} />
          <Activity data={data} />
        </div>

        <div className="space-y-4">
          <Contacts data={data} />
          <AccountFollowUps data={data} />
          <Conversations data={data} />
          <CrossSell data={data} />
        </div>
      </div>
    </>
  );
}

/**
 * The commercial summary.
 *
 * `basis` is shown, not hidden: these are CRM opportunity figures, and the
 * difference from invoiced revenue matters to anyone reading them.
 */
function Header({
  data,
  canChangeStatus,
  accountId,
}: {
  data: Customer360;
  canChangeStatus: boolean;
  accountId: string;
}): React.JSX.Element {
  const presentation = ACCOUNT_STATUS_PRESENTATION[data.account.status];

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${presentation.className}`}
          >
            {presentation.label}
          </span>
          {data.commercial.isRepeatCustomer && (
            /* The single most useful fact on the page. */
            <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-800">
              Repeat customer · {data.commercial.wonCount} deals
            </span>
          )}
          {data.account.website && (
            <a
              href={data.account.website.startsWith('http') ? data.account.website : `https://${data.account.website}`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-slate-500 underline"
            >
              {data.account.domain ?? data.account.website}
            </a>
          )}
        </div>

        {canChangeStatus && <StatusControl accountId={accountId} current={data.account.status} />}
      </div>

      <div className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Won value" value={formatCustomerKpi(data.commercial.wonValue, 'currency')} note={`${data.commercial.wonCount} won`} />
        <Tile
          label="Average deal"
          // Null when nothing has been won — a dash, never a zero.
          value={formatCustomerKpi(data.commercial.averageDealValue, 'currency')}
        />
        <Tile
          label="Open pipeline"
          value={formatCustomerKpi(data.commercial.openPipeline, 'currency')}
          note={`${data.commercial.openCount} open`}
        />
        <Tile
          label="Customer since"
          value={
            data.commercial.firstWonAt
              ? new Date(data.commercial.firstWonAt).toLocaleDateString()
              : '—'
          }
          note={
            data.commercial.lastWonAt
              ? `Last won ${new Date(data.commercial.lastWonAt).toLocaleDateString()}`
              : 'Never bought'
          }
        />
      </div>

      <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
        Figures are CRM opportunities, not invoiced revenue — LeadFlow does not hold orders.
      </p>
    </Card>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): React.JSX.Element {
  return (
    <div className="bg-white p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</p>
      {note && <p className="mt-0.5 text-xs text-slate-400">{note}</p>}
    </div>
  );
}

/**
 * Reclassifying a relationship.
 *
 * PROSPECT → CUSTOMER is deliberately not offered: that transition is earned by
 * winning an opportunity, and the server refuses it. Offering a control that
 * always fails would be worse than not offering one.
 */
function StatusControl({
  accountId,
  current,
}: {
  accountId: string;
  current: AccountStatus;
}): React.JSX.Element {
  const change = useChangeAccountStatus();
  const [failure, setFailure] = useState<string | null>(null);

  const options: Record<AccountStatus, AccountStatus[]> = {
    PROSPECT: ['FORMER_CUSTOMER'],
    CUSTOMER: ['DORMANT', 'FORMER_CUSTOMER'],
    DORMANT: ['CUSTOMER', 'FORMER_CUSTOMER'],
    FORMER_CUSTOMER: ['CUSTOMER', 'DORMANT'],
  };

  const available = options[current];
  if (available.length === 0) return <span />;

  return (
    <div className="flex items-center gap-2">
      {failure && <span className="text-xs text-red-700">{failure}</span>}
      <select
        value=""
        aria-label="Change customer status"
        disabled={change.isPending}
        onChange={(event) => {
          const status = event.target.value as AccountStatus;
          if (!status) return;
          setFailure(null);
          change.mutate(
            { id: accountId, status },
            {
              onError: (error) =>
                setFailure(error instanceof ApiError ? error.message : 'Could not change status.'),
            },
          );
        }}
        className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
      >
        <option value="">Change status…</option>
        {available.map((status) => (
          <option key={status} value={status}>
            Mark {ACCOUNT_STATUS_PRESENTATION[status].label.toLowerCase()}
          </option>
        ))}
      </select>
    </div>
  );
}

function Opportunities({
  title,
  subtitle,
  data,
  open,
}: {
  title: string;
  subtitle: string;
  data: { items: Opportunity[]; total: number };
  open: boolean;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />

      {data.items.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-500">
          {open ? 'Nothing open right now.' : 'Nothing has closed yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.items.map((opportunity) => (
            <li key={opportunity.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    to={`/leads/${opportunity.id}`}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {opportunity.product?.name ?? opportunity.leadNumber}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {opportunity.leadNumber}
                    {opportunity.contact ? ` · ${opportunity.contact.name}` : ''}
                    {opportunity.source ? ` · ${opportunity.source}` : ''}
                  </p>

                  {/*
                    What the customer actually asked for, kept beside the
                    standardised product rather than replaced by it.
                  */}
                  {opportunity.productInterest && (
                    <p className="mt-1 text-pretty text-sm text-slate-600">
                      {opportunity.productInterest}
                    </p>
                  )}
                </div>

                <div className="text-right">
                  <p className="text-sm font-medium tabular-nums text-slate-900">
                    {opportunity.status === 'WON'
                      ? formatCustomerKpi(opportunity.wonValue, 'currency')
                      : formatCustomerKpi(opportunity.estimatedValue, 'currency')}
                  </p>
                  <p className="text-xs text-slate-500">{opportunity.status}</p>
                  {opportunity.lostReason && (
                    <p className="text-xs text-red-600">{opportunity.lostReason}</p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data.total > data.items.length && (
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          Showing {data.items.length} of {data.total}.
        </p>
      )}
    </Card>
  );
}

/** What this customer has asked about, bought and turned down. */
function ProductHistory({ data }: { data: Customer360 }): React.JSX.Element {
  return (
    <Card>
      <CardHeader
        title="Products"
        subtitle="What this customer asks about, and what they actually buy."
      />

      {data.products.items.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-500">
          No opportunity here has a product attached yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Product</th>
                <th className="px-4 py-2.5 text-right font-medium">Enquiries</th>
                <th className="px-4 py-2.5 text-right font-medium">Won</th>
                <th className="px-4 py-2.5 text-right font-medium">Won value</th>
                <th className="px-4 py-2.5 text-right font-medium">Lost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.products.items.map((product) => (
                <tr key={product.productId}>
                  <td className="px-4 py-3">
                    <span className="font-medium text-slate-900">{product.name}</span>
                    {!product.active && (
                      <span className="ml-2 text-xs text-slate-400">retired</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{product.enquiries}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{product.won}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {product.won > 0 ? formatCustomerKpi(product.wonValue, 'currency') : '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{product.lost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/*
        The coverage figure. A customer with two mapped leads out of forty is
        not a two-product customer, and without this they would look like one.
      */}
      {data.products.leadsWithoutProduct > 0 && (
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-amber-700">
          {data.products.leadsWithoutProduct} opportunit
          {data.products.leadsWithoutProduct === 1 ? 'y has' : 'ies have'} no product attached and
          {data.products.leadsWithoutProduct === 1 ? ' is' : ' are'} not counted above.
        </p>
      )}
    </Card>
  );
}

function Contacts({ data }: { data: Customer360 }): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="People" subtitle={`${data.contacts.total} at this company.`} />

      {data.contacts.items.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-500">Nobody recorded here yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.contacts.items.map((contact) => (
            <li key={contact.id} className="p-4">
              <Link
                to={`/contacts/${contact.id}`}
                className="font-medium text-slate-900 hover:underline"
              >
                {contact.name}
              </Link>
              <p className="text-xs text-slate-500">
                {[contact.mobile, contact.email].filter(Boolean).join(' · ') || 'No contact details'}
              </p>
              {contact.leadCount > 0 && (
                <p className="text-xs text-slate-400">
                  {contact.leadCount} opportunit{contact.leadCount === 1 ? 'y' : 'ies'}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Follow-ups on the RELATIONSHIP, not on a deal.
 *
 * "Call ABC Foods on Monday about a repeat order" is real work with no open
 * enquiry behind it. Before accounts, recording it meant creating a fake lead,
 * which corrupted every conversion figure.
 */
function AccountFollowUps({ data }: { data: Customer360 }): React.JSX.Element {
  return (
    <Card>
      <CardHeader
        title="Customer follow-ups"
        subtitle="Actions on the relationship. Each opportunity carries its own."
      />

      {data.followUps.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-500">Nothing scheduled.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.followUps.map((followUp) => (
            <li key={followUp.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    {followUp.title ?? followUp.type}
                  </p>
                  <p className="text-xs text-slate-500">
                    {new Date(followUp.scheduledAt).toLocaleDateString()} ·{' '}
                    {followUp.assignedTo.fullName}
                  </p>
                </div>
                {followUp.isOverdue && (
                  <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                    Overdue
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Conversations({ data }: { data: Customer360 }): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="Conversations" subtitle={`${data.conversations.total} across all channels.`} />

      {data.conversations.items.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-500">No messages linked yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.conversations.items.map((conversation) => (
            <li key={conversation.id} className="p-4">
              <Link
                to={`/inbox?conversation=${conversation.id}`}
                className="text-sm font-medium text-slate-900 hover:underline"
              >
                {conversation.channel}
                {conversation.contactName ? ` · ${conversation.contactName}` : ''}
              </Link>
              <p className="text-xs text-slate-500">
                {conversation.messageCount} message
                {conversation.messageCount === 1 ? '' : 's'}
                {conversation.lastMessageAt
                  ? ` · ${new Date(conversation.lastMessageAt).toLocaleDateString()}`
                  : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Activity({ data }: { data: Customer360 }): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="Activity" subtitle="Rolled up from every opportunity." />

      {data.activities.items.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-500">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.activities.items.map((activity) => (
            <li key={activity.id} className="flex items-start gap-3 p-4">
              <span className="mt-1 text-xs text-slate-400">◦</span>
              <div className="min-w-0">
                <p className="text-sm text-slate-800">{activity.description ?? activity.type}</p>
                <p className="text-xs text-slate-500">
                  <Link to={`/leads/${activity.leadId}`} className="hover:underline">
                    {activity.leadNumber}
                  </Link>
                  {activity.performedBy ? ` · ${activity.performedBy.fullName}` : ''} ·{' '}
                  {new Date(activity.createdAt).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data.activities.total > data.activities.items.length && (
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          Showing {data.activities.items.length} of {data.activities.total}.
        </p>
      )}
    </Card>
  );
}

/**
 * Products this customer has never asked about.
 *
 * A set difference over what actually happened — no model, no score, no ranking
 * pretending to know what they want next. The rep judges it.
 */
function CrossSell({ data }: { data: Customer360 }): React.JSX.Element {
  if (data.crossSell.length === 0) return <span />;

  return (
    <Card>
      <CardHeader
        title="Never asked about"
        subtitle="Products you sell that this customer has not enquired about."
      />
      <ul className="divide-y divide-slate-100">
        {data.crossSell.map((product) => (
          <li key={product.productId} className="px-4 py-2.5 text-sm text-slate-700">
            {product.name}
            {product.category && <span className="text-slate-400"> · {product.category}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
