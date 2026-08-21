import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PlanView } from '@leadflow/api-types';
import { annualSaving, formatPlanPrice, statedLimit, usePlans } from './use-plans';

/**
 * The plan cards, shared by the homepage and the pricing page.
 *
 * One component so the two can never quote different prices — which is the
 * failure mode of duplicating a pricing section, and the one customers notice.
 */
export function PricingTable({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const [annual, setAnnual] = useState(false);
  const plans = usePlans();

  if (plans.isPending) {
    return (
      <div className="mt-10 grid gap-6 lg:grid-cols-3" aria-busy="true">
        {[0, 1, 2].map((index) => (
          <div key={index} className="h-96 animate-pulse rounded-2xl bg-slate-100" />
        ))}
        <span className="sr-only">Loading plans…</span>
      </div>
    );
  }

  if (plans.isError || plans.data.length === 0) {
    // Prices come from the API so there is one source of truth. The cost is
    // this state — shown honestly rather than falling back to a bundled copy
    // that would eventually be wrong.
    return (
      <div
        role="alert"
        className="mx-auto mt-10 max-w-lg rounded-xl border border-slate-200 bg-slate-50 p-6 text-center"
      >
        <p className="text-sm font-medium text-slate-900">Pricing is temporarily unavailable</p>
        <p className="mt-1.5 text-sm text-slate-600">
          You can still create an account — LeadFlow is free to start while it is in early access.
        </p>
        <Link
          to="/register"
          className="mt-4 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          Create your workspace
        </Link>
      </div>
    );
  }

  const anyAnnual = plans.data.some((plan) => plan.yearlyPrice !== null);

  return (
    <>
      {anyAnnual && (
        <div className="mt-8 flex justify-center">
          <fieldset className="inline-flex rounded-lg bg-white p-1 ring-1 ring-slate-200 ring-inset">
            <legend className="sr-only">Billing period</legend>
            {[
              { value: false, label: 'Monthly' },
              { value: true, label: 'Annual' },
            ].map((option) => (
              <label
                key={option.label}
                className={`cursor-pointer rounded-md px-4 py-1.5 text-sm font-medium transition ${
                  annual === option.value
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <input
                  type="radio"
                  name="billing-period"
                  className="sr-only"
                  checked={annual === option.value}
                  onChange={() => setAnnual(option.value)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
        </div>
      )}

      <div className="mt-10 grid items-start gap-6 lg:grid-cols-3">
        {plans.data.map((plan) => (
          <PlanCard key={plan.code} plan={plan} annual={annual} compact={compact} />
        ))}
      </div>

      <EarlyAccessNotice />
    </>
  );
}

function PlanCard({
  plan,
  annual,
  compact,
}: {
  plan: PlanView;
  annual: boolean;
  compact: boolean;
}): React.JSX.Element {
  const showYearly = annual && plan.yearlyPrice !== null;
  const price = showYearly ? (plan.yearlyPrice as string) : plan.monthlyPrice;
  const saving = annualSaving(plan);
  const isFree = Number(plan.monthlyPrice) === 0;
  const period = isFree ? '' : showYearly ? '/year' : '/month';

  return (
    <div
      className={`relative rounded-2xl bg-white p-6 sm:p-7 ${
        plan.featured
          ? 'shadow-xl shadow-slate-200/70 ring-2 ring-slate-900'
          : 'ring-1 ring-slate-200'
      }`}
    >
      {plan.featured && (
        <span className="absolute -top-3 left-6 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-medium text-white">
          Most popular
        </span>
      )}

      <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
      {plan.tagline && <p className="mt-1 text-sm text-slate-500">{plan.tagline}</p>}

      <p className="mt-5 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tracking-tight text-slate-900">
          {formatPlanPrice(price, plan.currency)}
        </span>
        {period && <span className="text-sm text-slate-500">{period}</span>}
      </p>

      {showYearly && saving !== null ? (
        <p className="mt-1 text-xs font-medium text-emerald-700">Save {saving}% paid annually</p>
      ) : (
        <p className="mt-1 text-xs text-slate-400">
          {isFree ? 'No card required' : 'per organization, not per user'}
        </p>
      )}

      <Link
        to="/register"
        className={`mt-6 block rounded-lg px-4 py-2.5 text-center text-sm font-medium transition ${
          plan.featured
            ? 'bg-slate-900 text-white hover:bg-slate-800'
            : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
        }`}
      >
        {isFree ? 'Start free' : 'Get started'}
      </Link>

      <dl className="mt-5 space-y-1 border-t border-slate-100 pt-4 text-xs text-slate-500">
        <div className="flex justify-between gap-2">
          <dt>Team members</dt>
          <dd className="text-right text-slate-700">{statedLimit(plan.maxUsers, 'members')}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Active leads</dt>
          <dd className="text-right text-slate-700">
            {statedLimit(plan.maxActiveLeads, 'leads')}
          </dd>
        </div>
      </dl>

      {!compact && (
        <ul className="mt-5 space-y-2.5">
          {plan.features.map((feature) => (
            <li key={feature} className="flex gap-2.5 text-sm text-slate-600">
              <span aria-hidden className="mt-0.5 shrink-0 text-emerald-600">
                ✓
              </span>
              <span className="text-pretty">{feature}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * States what the tiers actually mean today.
 *
 * The limits above are stored and displayed but NOT applied by the server —
 * see PLAN_LIMITS_ENFORCED in the API. Publishing "up to 3 members" while
 * allowing thirty is a promise broken at the worst possible moment, so the page
 * says so rather than letting a reader assume otherwise.
 */
export function EarlyAccessNotice(): React.JSX.Element {
  return (
    <p className="mx-auto mt-8 max-w-2xl rounded-lg bg-white px-4 py-3 text-center text-xs text-pretty text-slate-500 ring-1 ring-slate-200 ring-inset">
      LeadFlow is in early access. Sign-up takes no card, no payment is collected, and the limits
      shown above are not currently applied to accounts — the tiers describe where pricing is
      heading so you can plan, not what you will be charged today.
    </p>
  );
}
