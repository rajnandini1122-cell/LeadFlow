import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useBillingSummary } from '../features/settings/use-billing';

/**
 * The subscription line at the top of every page, for people who can see
 * billing (owners and admins): days left in the last week of a trial, a
 * renewal due, or access ended. Silent otherwise, and for exempt accounts.
 *
 * Also listens for the API's 402 SUBSCRIPTION_REQUIRED and sends the user to
 * Billing — the server is the authority; this only follows it.
 */
export function SubscriptionBanner({ canViewBilling }: { canViewBilling: boolean }): React.JSX.Element | null {
  const navigate = useNavigate();
  const location = useLocation();
  const summary = useBillingSummary(canViewBilling);

  useEffect(() => {
    const onRequired = () => {
      if (!location.pathname.startsWith('/settings/billing')) navigate('/settings/billing');
    };
    window.addEventListener('leadflow:subscription-required', onRequired);
    return () => window.removeEventListener('leadflow:subscription-required', onRequired);
  }, [navigate, location.pathname]);

  const data = summary.data;
  if (!data || !data.billable) return null;
  const days = data.daysRemaining;
  let tone = '';
  let text = '';
  let cta = 'View plans';
  if (data.message) {
    tone = 'bg-red-50 text-red-800 border-red-200';
    text = data.message;
    cta = data.state === 'EXPIRED' && data.interval ? 'Renew subscription' : 'Upgrade to Premium';
  } else if (data.state === 'PAST_DUE') {
    tone = 'bg-amber-50 text-amber-900 border-amber-200';
    text = `Your LeadFlow Premium period has ended. Renew within ${days ?? 0} day${days === 1 ? '' : 's'} to keep using LeadFlow CRM.`;
    cta = 'Renew subscription';
  } else if (data.state === 'TRIALING' && days !== null && days <= 7) {
    tone = 'bg-amber-50 text-amber-900 border-amber-200';
    text = `Your free trial ends in ${days} day${days === 1 ? '' : 's'}. Upgrade to Premium to keep using LeadFlow CRM.`;
    cta = 'Upgrade to Premium';
  } else {
    return null;
  }
  return (
    <div role="status" className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-sm lg:px-8 ${tone}`}>
      <span>{text}</span>
      <Link to="/settings/billing" className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white">
        {cta}
      </Link>
    </div>
  );
}
