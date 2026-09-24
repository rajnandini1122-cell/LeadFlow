import { useState } from 'react';
import type { BillingInterval, PlanView, SubscriptionView } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { annualSaving } from '../marketing/use-plans';
import { formatDate } from '../../lib/format';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import {
  STATUS_PRESENTATION,
  daysUntil,
  useChangePlan,
  useEntitlement,
  usePlanCatalogue,
  useSubscription,
} from './use-subscription';

/**
 * Plan and billing.
 *
 * No payment provider is integrated, and this screen says so rather than
 * implying a card is on file. What it does do is real: the plan and billing
 * interval are stored, changing them is recorded in the audit trail, and the
 * trial countdown is the actual period end from the database.
 */
export function BillingPage(): React.JSX.Element {
  const { can } = useAuth();
  const entitlement = useEntitlement();
  const subscription = useSubscription();
  const canManage = can('subscription.manage');

  /*
   * The entitlement is read FIRST, and decides whether this screen is about
   * money at all.
   *
   * CRAVION operates the platform: there is no plan, no period and no payment,
   * so a trial countdown would be counting down to nothing and an upgrade
   * prompt would be offering the operator a plan to buy from itself. The
   * subscription query is a 404 for that organization, which is why asking it
   * first would show an error instead.
   */
  if (entitlement.isPending) {
    return (
      <>
        <PageHeader title="Plan and billing" />
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      </>
    );
  }

  if (entitlement.data && !entitlement.data.billable) {
    return <InternalAccountCard />;
  }

  if (subscription.isPending) {
    return (
      <>
        <PageHeader title="Plan and billing" />
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      </>
    );
  }

  if (subscription.isError) {
    const notFound =
      subscription.error instanceof ApiError && subscription.error.status === 404;

    return (
      <>
        <PageHeader title="Plan and billing" />
        <Card>
          <ErrorNotice
            message={
              notFound
                ? 'This organization has no subscription on record. That should not happen — please contact support.'
                : 'Could not load your subscription.'
            }
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Plan and billing"
        subtitle="What your organization is on today"
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <CurrentPlan subscription={subscription.data} />
          {canManage && <ChangePlan subscription={subscription.data} />}
        </div>

        <div className="space-y-6">
          <Entitlements subscription={subscription.data} />
          <EarlyAccessNote />
        </div>
      </div>
    </>
  );
}

function CurrentPlan({ subscription }: { subscription: SubscriptionView }): React.JSX.Element {
  const status = STATUS_PRESENTATION[subscription.status];
  const trialDays = daysUntil(subscription.trialEndsAt);

  const tones = {
    good: 'bg-emerald-50 text-emerald-700',
    warn: 'bg-amber-50 text-amber-700',
    bad: 'bg-red-50 text-red-700',
  };

  return (
    <Card>
      <CardHeader title="Your plan" />
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl font-semibold tracking-tight text-slate-900">
            {subscription.plan.name}
          </span>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${tones[status.tone]}`}
          >
            {status.label}
          </span>
        </div>

        <p className="text-sm text-pretty text-slate-600">{status.meaning}</p>

        {subscription.status === 'TRIAL' && trialDays !== null && (
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-900">
              {trialDays === 0
                ? 'Your trial ends today'
                : `${trialDays} ${trialDays === 1 ? 'day' : 'days'} left in your trial`}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Nothing happens automatically when it ends — no card is on file and no payment
              will be taken.
            </p>
          </div>
        )}

        <dl className="divide-y divide-slate-100 border-t border-slate-100">
          <Row label="Billing period" value={subscription.billingInterval === 'YEARLY' ? 'Yearly' : 'Monthly'} />
          <Row label="Current period started" value={formatDate(subscription.currentPeriodStart)} />
          <Row
            label={subscription.status === 'TRIAL' ? 'Trial ends' : 'Current period ends'}
            value={formatDate(subscription.currentPeriodEnd)}
          />
          {subscription.cancelledAt && (
            <Row label="Cancelled" value={formatDate(subscription.cancelledAt)} />
          )}
        </dl>
      </div>
    </Card>
  );
}

function ChangePlan({ subscription }: { subscription: SubscriptionView }): React.JSX.Element {
  const plans = usePlanCatalogue();
  const change = useChangePlan();
  const [confirming, setConfirming] = useState<PlanView | null>(null);
  // What the tenant would actually save on THEIR plan, not a headline rate.
  const yearlySaving = annualSaving(subscription.plan);

  const setInterval = (billingInterval: BillingInterval): void => {
    change.mutate({ billingInterval });
  };

  return (
    <Card>
      <CardHeader
        title="Change plan"
        subtitle="Takes effect immediately and is recorded in your administrative history"
      />

      <div className="space-y-5 p-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">Billing period</legend>
          <div className="inline-flex rounded-lg bg-slate-100 p-1">
            {(['MONTHLY', 'YEARLY'] as BillingInterval[]).map((interval) => (
              <label
                key={interval}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition ${
                  subscription.billingInterval === interval
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <input
                  type="radio"
                  name="billing-interval"
                  className="sr-only"
                  checked={subscription.billingInterval === interval}
                  disabled={change.isPending}
                  onChange={() => setInterval(interval)}
                />
                {interval === 'YEARLY' ? 'Yearly' : 'Monthly'}
                {interval === 'YEARLY' && yearlySaving !== null && (
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                    −{yearlySaving}%
                  </span>
                )}
              </label>
            ))}
          </div>
        </fieldset>

        {plans.isPending ? (
          <SkeletonRows rows={3} />
        ) : plans.isError ? (
          <ErrorNotice message="Could not load the available plans." />
        ) : (
          <ul className="space-y-2">
            {plans.data.map((plan) => {
              const current = plan.code === subscription.plan.code;

              return (
                <li
                  key={plan.code}
                  className={`flex flex-wrap items-center gap-3 rounded-lg border p-4 ${
                    current ? 'border-slate-900 bg-slate-50' : 'border-slate-200'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900">{plan.name}</p>
                    {plan.tagline && (
                      <p className="mt-0.5 truncate text-xs text-slate-500">{plan.tagline}</p>
                    )}
                  </div>

                  {current ? (
                    <span className="rounded-full bg-slate-900 px-2.5 py-1 text-xs font-medium text-white">
                      Current
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={change.isPending}
                      onClick={() => setConfirming(plan)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      Switch to {plan.name}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {confirming && (
          <div
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          >
            <p>
              Move this organization to <strong>{confirming.name}</strong>?
            </p>
            <p className="mt-1 text-xs">
              No payment is taken — LeadFlow is in early access. The change is recorded against
              your account.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={change.isPending}
                onClick={() =>
                  change.mutate(
                    { planCode: confirming.code },
                    { onSuccess: () => setConfirming(null) },
                  )
                }
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
              >
                {change.isPending ? 'Changing…' : 'Yes, change plan'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-amber-900 transition hover:bg-amber-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {change.isError && (
          <p role="alert" className="text-xs text-red-600">
            {change.error instanceof ApiError
              ? change.error.message
              : 'That change could not be saved.'}
          </p>
        )}
      </div>
    </Card>
  );
}

function Entitlements({ subscription }: { subscription: SubscriptionView }): React.JSX.Element {
  const { plan, limitsEnforced } = subscription;

  return (
    <Card>
      <CardHeader title="What this plan includes" />
      <div className="p-5">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-600">Team members</dt>
            <dd className="text-right font-medium text-slate-900">
              {plan.maxUsers === null ? 'No stated limit' : plan.maxUsers.toLocaleString()}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-600">Active leads</dt>
            <dd className="text-right font-medium text-slate-900">
              {plan.maxActiveLeads === null
                ? 'No stated limit'
                : plan.maxActiveLeads.toLocaleString()}
            </dd>
          </div>
        </dl>

        {!limitsEnforced && (
          <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-pretty text-slate-500">
            These limits are not currently applied to your account. Nothing will stop you adding
            more members or leads than the numbers above.
          </p>
        )}

        {plan.features.length > 0 && (
          <ul className="mt-4 space-y-2 border-t border-slate-100 pt-4">
            {plan.features.map((feature) => (
              <li key={feature} className="flex gap-2 text-sm text-slate-600">
                <span aria-hidden className="mt-0.5 shrink-0 text-emerald-600">
                  ✓
                </span>
                <span className="text-pretty">{feature}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function EarlyAccessNote(): React.JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
      <h2 className="text-sm font-semibold text-slate-900">No payment set up</h2>
      <p className="mt-2 text-xs text-pretty text-slate-600">
        LeadFlow is in early access. There is no card on file, no invoice is generated and no
        charge will be made. When billing is introduced you will be told before anything changes.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="text-sm font-medium text-slate-900">{value}</dd>
    </div>
  );
}

/**
 * Plan and billing, for CRAVION's own organization.
 *
 * Deliberately says what is true rather than dressing the operator up as a
 * customer: there is no plan, no renewal date and no payment method, because
 * CRAVION runs the platform. It does NOT claim the account is "paid" — that
 * would be a different false statement from the one this replaces.
 *
 * No trial countdown, no upgrade prompt, no price.
 */
function InternalAccountCard(): React.JSX.Element {
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
            This organization operates LeadFlow. It has full access with no plan, no
            billing period and no renewal — there is nothing to pay and nothing to
            expire.
          </p>
          <p className="text-slate-500">
            Customer organizations are billed normally; this applies only to CRAVION’s
            own account.
          </p>
        </div>
      </Card>
    </>
  );
}
