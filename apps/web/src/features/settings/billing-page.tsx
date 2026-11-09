import { useState } from 'react';
import type {
  BillingInterval,
  BillingPaymentView,
  BillingSummaryView,
  EntitlementState,
  PlanPriceView,
} from '@leadflow/api-types';
import { formatDate } from '../../lib/format';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { useBillingSummary, useCheckout } from './use-billing';

/**
 * Plan and billing: where an organization sees how long it has, what it is
 * on, what it has paid, and pays. Everything shown comes from the server —
 * prices, GST and dates included — and paying grants nothing until the server
 * has verified the payment with Razorpay.
 *
 * Reachable after a trial or paid period has ended (the API keeps billing open
 * when it restricts CRM features), because paying is how access returns.
 */
export function BillingPage(): React.JSX.Element {
  const summary = useBillingSummary();

  if (summary.isPending) {
    return (
      <>
        <PageHeader title="Plan and billing" />
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      </>
    );
  }
  if (summary.isError) {
    return (
      <>
        <PageHeader title="Plan and billing" />
        <Card>
          <ErrorNotice message="Could not load your billing details. Please try again." />
        </Card>
      </>
    );
  }
  const data = summary.data;
  if (!data.billable) return <ExemptAccountCard />;

  return (
    <>
      <PageHeader title="Plan and billing" subtitle="Your LeadFlow subscription" />
      {data.message && <ExpiredBanner message={data.message} supportEmail={data.supportEmail} />}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <StatusCard data={data} />
          <PlansCard data={data} />
          <PaymentHistory payments={data.payments} />
        </div>
        <div className="space-y-6">
          <SupportCard data={data} />
        </div>
      </div>
    </>
  );
}

const STATE_LABEL: Record<EntitlementState, { label: string; tone: 'good' | 'warn' | 'bad' }> = {
  EXEMPT: { label: 'Exempt', tone: 'good' },
  PENDING_REVIEW: { label: 'Active', tone: 'good' },
  TRIALING: { label: 'Free trial', tone: 'good' },
  ACTIVE: { label: 'Premium', tone: 'good' },
  LIFETIME: { label: 'Lifetime Premium', tone: 'good' },
  COMPLIMENTARY: { label: 'Premium (complimentary)', tone: 'good' },
  PAST_DUE: { label: 'Renewal due', tone: 'warn' },
  EXPIRED: { label: 'Expired', tone: 'bad' },
  CANCELLED: { label: 'Cancelled', tone: 'bad' },
  SUSPENDED: { label: 'Suspended', tone: 'bad' },
  DEACTIVATED: { label: 'Deactivated', tone: 'bad' },
};

const TONES = {
  good: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-800',
  bad: 'bg-red-50 text-red-700',
};

function ExpiredBanner({ message, supportEmail }: { message: string; supportEmail: string }): React.JSX.Element {
  return (
    <div role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p className="font-medium">{message}</p>
      <p className="mt-1">
        Your leads, contacts and records are kept safe. Choose a plan below, or{' '}
        <a className="underline" href={`mailto:${supportEmail}`}>
          contact support
        </a>
        .
      </p>
    </div>
  );
}

function StatusCard({ data }: { data: BillingSummaryView }): React.JSX.Element {
  const state = STATE_LABEL[data.state];
  const ending = data.accessEndsAt !== null;
  return (
    <Card>
      <CardHeader title="Your subscription" />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl font-semibold tracking-tight text-slate-900">{data.planName ?? 'LeadFlow'}</span>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${TONES[state.tone]}`}>{state.label}</span>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {data.state === 'TRIALING' && (
            <Fact label="Free trial" value={`${data.daysRemaining} day${data.daysRemaining === 1 ? '' : 's'} remaining`} />
          )}
          {data.trialEndsAt && <Fact label="Trial ends" value={formatDate(data.trialEndsAt)} />}
          {data.lifetime && <Fact label="Access" value="Lifetime — no renewal" />}
          {!data.lifetime && ending && data.state !== 'TRIALING' && (
            <Fact label={data.state === 'PAST_DUE' ? 'Renew by' : 'Renews or ends'} value={formatDate(data.accessEndsAt)} />
          )}
          {data.interval && <Fact label="Billing" value={intervalLabel(data.interval)} />}
          {data.state === 'PENDING_REVIEW' && <Fact label="Access" value="Active while your plan is confirmed" />}
        </dl>
        <p className="text-xs text-slate-500">
          Plans renew manually: you pay again before the period ends. Nothing is charged automatically.
        </p>
      </div>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function intervalLabel(interval: BillingInterval): string {
  return interval === 'MONTHLY' ? 'Monthly' : interval === 'YEARLY' ? 'Yearly' : 'Lifetime';
}

export function rupees(amount: string): string {
  const value = Number(amount);
  return `₹${value.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function PlansCard({ data }: { data: BillingSummaryView }): React.JSX.Element {
  const checkout = useCheckout();
  const [paid, setPaid] = useState<string | null>(null);
  const renewing = data.state === 'ACTIVE' || data.state === 'PAST_DUE';
  const error = checkout.error instanceof Error ? checkout.error.message : null;

  return (
    <Card>
      <CardHeader
        title={renewing ? 'Renew subscription' : 'Upgrade to Premium'}
        subtitle="Prices exclude GST; 18% GST is added at checkout"
      />
      <div className="grid gap-4 p-5 sm:grid-cols-3">
        {data.prices.map((price) => (
          <PriceOption
            key={price.id}
            price={price}
            disabled={!data.checkoutEnabled || !data.canPay || checkout.isPending || data.lifetime}
            busy={checkout.isPending && checkout.variables === price.interval}
            action={data.lifetime ? 'Included' : renewing && price.interval !== 'LIFETIME' ? 'Renew' : 'Upgrade'}
            onSelect={() =>
              checkout.mutate(price.interval, {
                onSuccess: (payment) => {
                  if (payment) setPaid(`Payment ${payment.receipt} received. Thank you!`);
                },
              })
            }
          />
        ))}
      </div>
      <div className="space-y-2 px-5 pb-5 text-sm">
        {paid && <p className="rounded-md bg-emerald-50 p-3 text-emerald-800">{paid}</p>}
        {error && <p className="rounded-md bg-red-50 p-3 text-red-700">{error}</p>}
        {!data.checkoutEnabled && (
          <p className="text-slate-600">
            Online payment is being switched on. To subscribe now, write to{' '}
            <a className="underline" href={`mailto:${data.supportEmail}`}>
              {data.supportEmail}
            </a>
            .
          </p>
        )}
        {data.checkoutEnabled && !data.canPay && (
          <p className="text-slate-600">Only the organization owner can pay for the subscription.</p>
        )}
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">What Lifetime includes</summary>
          <p className="mt-2 text-pretty">{data.lifetimeScope}</p>
        </details>
      </div>
    </Card>
  );
}

function PriceOption({
  price,
  disabled,
  busy,
  action,
  onSelect,
}: {
  price: PlanPriceView;
  disabled: boolean;
  busy: boolean;
  action: string;
  onSelect: () => void;
}): React.JSX.Element {
  const per = price.interval === 'MONTHLY' ? '/month' : price.interval === 'YEARLY' ? '/year' : ' once';
  return (
    <div className="flex flex-col rounded-lg border border-slate-200 p-4">
      <p className="text-sm font-medium text-slate-900">{intervalLabel(price.interval)}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-900">
        {rupees(price.baseAmount)}
        <span className="text-sm font-normal text-slate-500">{per}</span>
      </p>
      <p className="mt-1 text-xs text-slate-500">
        + {rupees(price.taxAmount)} GST ({price.taxRatePercent}%) = <strong>{rupees(price.totalAmount)}</strong>
      </p>
      <p className="mt-1 text-xs text-slate-500">{price.renewal === 'NONE' ? 'One payment, no renewal' : 'Renewed manually'}</p>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className="mt-4 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Opening…' : action}
      </button>
    </div>
  );
}

const PAYMENT_STATUS: Record<string, string> = {
  CREATED: 'Not completed',
  PAID: 'Paid',
  FAILED: 'Failed',
  EXPIRED: 'Abandoned',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partly refunded',
};

function PaymentHistory({ payments }: { payments: BillingPaymentView[] }): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="Payment history" />
      {payments.length === 0 ? (
        <p className="p-5 text-sm text-slate-500">No payments yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2 font-medium">Date</th>
                <th className="px-5 py-2 font-medium">Receipt</th>
                <th className="px-5 py-2 font-medium">Plan</th>
                <th className="px-5 py-2 font-medium">Amount (incl. GST)</th>
                <th className="px-5 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="px-5 py-2">{formatDate(p.paidAt ?? p.createdAt)}</td>
                  <td className="px-5 py-2 font-mono text-xs">{p.receipt}</td>
                  <td className="px-5 py-2">{intervalLabel(p.interval)}</td>
                  <td className="px-5 py-2">
                    {rupees(p.totalAmount)}
                    <span className="block text-xs text-slate-500">
                      {rupees(p.baseAmount)} + {rupees(p.taxAmount)} GST
                    </span>
                  </td>
                  <td className="px-5 py-2">{PAYMENT_STATUS[p.status] ?? p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SupportCard({ data }: { data: BillingSummaryView }): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="Need help?" />
      <div className="space-y-3 p-5 text-sm text-slate-600">
        <p>
          Questions about your plan, a receipt or a payment? Write to{' '}
          <a className="font-medium underline" href={`mailto:${data.supportEmail}`}>
            {data.supportEmail}
          </a>
          .
        </p>
        <p className="text-xs text-slate-500">
          A full refund ends what that payment bought. Your data is never deleted when a trial or subscription ends.
        </p>
      </div>
    </Card>
  );
}

function ExemptAccountCard(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Plan and billing" />
      <Card>
        <CardHeader title="Internal CRAVION account" />
        <div className="space-y-3 px-4 pb-4 text-sm text-slate-600">
          <p>
            <span className="inline-flex items-center rounded-full bg-slate-900 px-2.5 py-0.5 text-xs font-medium text-white">
              Platform Owner
            </span>
          </p>
          <p>
            This organization operates LeadFlow. It has full access with no plan, no billing period and
            no renewal — there is nothing to pay and nothing to expire.
          </p>
        </div>
      </Card>
    </>
  );
}
