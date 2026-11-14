import { Link } from 'react-router-dom';
import type { CampaignReadinessCheck } from '@leadflow/api-types';

const MARK: Record<
  CampaignReadinessCheck['status'],
  { symbol: string; label: string; tone: string }
> = {
  pass: { symbol: '✓', label: 'Done', tone: 'text-emerald-700' },
  warn: { symbol: '!', label: 'Check', tone: 'text-amber-700' },
  fail: { symbol: '✕', label: 'Needs action', tone: 'text-red-700' },
};

/**
 * The server's pre-send checklist (GET /email/campaigns/:id/readiness), shown
 * as-is: the page never decides readiness itself, so a button is enabled
 * exactly when the server would accept the action.
 *
 * `only` limits the list to what needs attention (fail and warn), for places
 * where a full checklist would be noise.
 */
export function ReadinessChecklist({
  checks,
  label,
  only = 'all',
}: {
  checks: CampaignReadinessCheck[];
  label: string;
  only?: 'all' | 'attention';
}): React.JSX.Element | null {
  const shown = only === 'all' ? checks : checks.filter((c) => c.status !== 'pass');
  if (shown.length === 0) return null;
  return (
    <ul aria-label={label} className="space-y-1.5 text-xs">
      {shown.map((check) => {
        const mark = MARK[check.status];
        return (
          <li key={check.id} className="flex gap-2">
            <span aria-hidden="true" className={`w-3 shrink-0 font-bold ${mark.tone}`}>
              {mark.symbol}
            </span>
            <span className="min-w-0">
              <span className="sr-only">{mark.label}: </span>
              <span
                className={
                  check.status === 'pass' ? 'text-slate-600' : 'font-medium text-slate-900'
                }
              >
                {check.title}
              </span>
              {check.detail && <span className="block text-slate-500">{check.detail}</span>}
              {check.fix &&
                (check.fix.to.startsWith('#') ? (
                  <a href={check.fix.to} className="text-sky-700 underline">
                    {check.fix.label}
                  </a>
                ) : (
                  <Link to={check.fix.to} className="text-sky-700 underline">
                    {check.fix.label}
                  </Link>
                ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
