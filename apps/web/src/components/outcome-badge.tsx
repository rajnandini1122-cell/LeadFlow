import { AWAITING_RESPONSE_OUTCOMES, CALL_OUTCOME_RULES, isCallOutcome } from '@leadflow/api-types';
import { formatRelative } from '../lib/format';

/**
 * What the last call established — kept visibly DIFFERENT from the sales stage.
 *
 * A stage pill ("Qualified") and an outcome pill ("Not answered") side by side
 * read as two facts only if they do not look alike. Outcomes are outlined and
 * prefixed with a phone glyph; stages stay the solid pills they always were.
 */
export function OutcomeBadge({
  outcome,
  at,
}: {
  outcome: string | null | undefined;
  /** When it was logged — shown as "2 h ago" when given. */
  at?: string | null | undefined;
}): React.JSX.Element | null {
  if (!outcome || !isCallOutcome(outcome)) return null;
  const rule = CALL_OUTCOME_RULES[outcome];

  const tone = !rule.reached
    ? 'text-amber-800 ring-amber-300 bg-amber-50'
    : AWAITING_RESPONSE_OUTCOMES.includes(outcome)
      ? 'text-sky-800 ring-sky-300 bg-sky-50'
      : 'text-emerald-800 ring-emerald-300 bg-emerald-50';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone}`}
      title={at ? `Last call: ${rule.label}` : rule.label}
    >
      <span aria-hidden>☎</span>
      <span>{rule.label}</span>
      {at && <span className="font-normal opacity-70">· {formatRelative(at)}</span>}
    </span>
  );
}
