import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CALL_OUTCOME_RULES,
  type CallOutcome,
  type LeadStatus,
} from '@leadflow/api-types';
import { formatDateTime, humanise } from '../../lib/format';
import { newIdempotencyKey } from '../../lib/idempotency';
import { zonedDefault, zonedFromNow, zonedInputToIso } from '../../lib/zoned-input';
import { useToast } from '../../components/toast';
import { ContactPicker, Dialog, Field, errorMessage, fieldErrorOf, inputClass } from './lead-dialogs';
import { useLeadContacts } from './use-lead-contacts';
import { useRecordOutcome } from './use-lead-mutations';

/**
 * "How did the call go?" — one dialog for every call outcome.
 *
 * Replaces three paths that disagreed with each other: "Complete" with a free
 * text outcome (where "No answer" COMPLETED the task), the separate "No answer"
 * button, and the Call button that logged a completed call on the dial click.
 * Now: pick what happened, and the dialog asks only for what that outcome needs.
 */

const REACHED: CallOutcome[] = [
  'CONNECTED_REQUIREMENT',
  'SAMPLE_REQUESTED',
  'QUOTATION_REQUESTED',
  'AWAITING_RESPONSE',
  'CONNECTED_CALL_BACK',
  'CONNECTED_NO_REQUIREMENT',
  'NOT_INTERESTED',
];
const NOT_REACHED: CallOutcome[] = ['NOT_ANSWERED', 'BUSY', 'UNREACHABLE', 'WRONG_NUMBER'];

/** Stages from which "mark qualified" is a step forward. */
const BEFORE_QUALIFIED: LeadStatus[] = ['NEW', 'CONTACTED', 'FOLLOW_UP'];

const PRESETS = [
  { label: 'In 1 hour', value: () => zonedFromNow(1) },
  { label: 'In 2 hours', value: () => zonedFromNow(2) },
  { label: 'Tomorrow 11 am', value: () => zonedDefault(1, 11) },
  { label: 'In 3 days', value: () => zonedDefault(3, 11) },
  { label: 'Next week', value: () => zonedDefault(7, 11) },
] as const;

const NEXT_TYPES = ['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'OTHER'];

/** The suggested next action for an outcome, as a datetime-local value in the org timezone. */
function suggestedNext(outcome: CallOutcome): string {
  const hours = CALL_OUTCOME_RULES[outcome].defaultNextInHours;
  // Short retries are relative to now; anything a day or more lands at 11:00.
  return hours < 24 ? zonedFromNow(hours) : zonedDefault(Math.round(hours / 24), 11);
}

/**
 * What the agent had entered, kept until it is saved or deliberately cancelled.
 *
 * A session can end mid-entry (expired sign-in on a phone left in a pocket).
 * Signing in again used to mean the dialog — and everything typed into it —
 * was gone. The draft lives in sessionStorage (this tab or app session only,
 * never shared, cleared on save or Cancel) and comes back when the dialog is
 * next opened for the same lead.
 */
interface OutcomeDraft {
  outcome: CallOutcome;
  note: string;
  nextAt: string;
  nextType: string;
  close: boolean;
  lostReason: string;
  markQualified: boolean;
  productInterest: string;
  quantity: string;
  expectedPurchaseDate: string;
  savedAt: number;
}

const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const draftKey = (leadId: string): string => `leadflow.outcome-draft.${leadId}`;

export function readOutcomeDraft(leadId: string): OutcomeDraft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(leadId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as OutcomeDraft;
    if (!draft.outcome || !(draft.outcome in CALL_OUTCOME_RULES)) return null;
    if (Date.now() - draft.savedAt > DRAFT_MAX_AGE_MS) return null;
    return draft;
  } catch {
    return null;
  }
}
function writeOutcomeDraft(leadId: string, draft: OutcomeDraft): void {
  try {
    sessionStorage.setItem(draftKey(leadId), JSON.stringify(draft));
  } catch {
    // Storage unavailable: the form still works, it just cannot be restored.
  }
}
export function clearOutcomeDraft(leadId: string): void {
  try {
    sessionStorage.removeItem(draftKey(leadId));
  } catch {
    // Nothing to clear.
  }
}

export interface LogOutcomeLead {
  id: string;
  name: string;
  status: LeadStatus;
}

export function LogOutcomeDialog({
  lead,
  followUpId,
  open,
  onClose,
  initialOutcome,
}: {
  /** May be built inline: the dialog keys its state on `lead.id`, not on identity. */
  lead: LogOutcomeLead;
  /** The follow-up being worked, when opened from a queue row. */
  followUpId?: string | undefined;
  open: boolean;
  onClose: () => void;
  initialOutcome?: CallOutcome | undefined;
}): React.JSX.Element | null {
  const record = useRecordOutcome(lead.id);
  const toast = useToast();

  const [outcome, setOutcome] = useState<CallOutcome | null>(initialOutcome ?? null);
  const [nextAt, setNextAt] = useState('');
  const [nextType, setNextType] = useState('CALL');
  const [close, setClose] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const [markQualified, setMarkQualified] = useState(false);
  const [productInterest, setProductInterest] = useState('');
  const [quantity, setQuantity] = useState('');
  const [expectedPurchaseDate, setExpectedPurchaseDate] = useState('');
  const [note, setNote] = useState('');
  const [contactId, setContactId] = useState('');
  const contacts = useLeadContacts(open ? lead.id : undefined);
  useEffect(() => {
    if (open) setContactId('');
  }, [open, lead.id]);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [restored, setRestored] = useState(false);
  // A draft waiting to be applied once its outcome's defaults would run.
  const pendingDraft = useRef<OutcomeDraft | null>(null);

  // Fresh state per opening, including a fresh key: reopening is a new call —
  // unless an unsaved entry for this lead is waiting, which comes back.
  useEffect(() => {
    if (!open) return;
    const draft = initialOutcome ? null : readOutcomeDraft(lead.id);
    pendingDraft.current = draft;
    setRestored(draft !== null);
    setOutcome(draft?.outcome ?? initialOutcome ?? null);
    setNote(draft?.note ?? '');
    setProductInterest(draft?.productInterest ?? '');
    setQuantity(draft?.quantity ?? '');
    setExpectedPurchaseDate(draft?.expectedPurchaseDate ?? '');
    setIdempotencyKey(newIdempotencyKey());
    record.reset();
    // Keyed on the lead's id, not the object: callers build it inline, and a
    // new object per render would reset the form while the agent types.
  }, [open, initialOutcome, lead.id]);

  // Each outcome brings its own sensible defaults.
  useEffect(() => {
    if (!outcome) return;
    const draft = pendingDraft.current;
    if (draft && draft.outcome === outcome) {
      pendingDraft.current = null;
      setNextAt(draft.nextAt);
      setNextType(draft.nextType);
      setClose(draft.close);
      setLostReason(draft.lostReason);
      setMarkQualified(draft.markQualified);
      return;
    }
    const rule = CALL_OUTCOME_RULES[outcome];
    setNextAt(suggestedNext(outcome));
    setNextType('CALL');
    setClose(false);
    setLostReason(rule.defaultLostReason ?? '');
    setMarkQualified(rule.suggestsQualified && BEFORE_QUALIFIED.includes(lead.status));
  }, [outcome, lead.id, lead.status]);

  // Keep the entry as it is typed, so an interruption cannot lose it.
  useEffect(() => {
    if (!open || !outcome || pendingDraft.current) return;
    writeOutcomeDraft(lead.id, {
      outcome, note, nextAt, nextType, close, lostReason, markQualified,
      productInterest, quantity, expectedPurchaseDate, savedAt: Date.now(),
    });
  }, [open, lead.id, outcome, note, nextAt, nextType, close, lostReason, markQualified, productInterest, quantity, expectedPurchaseDate]);

  /**
   * A deliberate close discards the entry; an interruption does not.
   *
   * Stable on purpose: the Dialog re-runs its focus effect when onClose
   * changes, and a new function per keystroke moved focus out of the note.
   */
  const cancel = useCallback((): void => {
    clearOutcomeDraft(lead.id);
    onClose();
  }, [lead.id, onClose]);

  if (!open) return null;

  const rule = outcome ? CALL_OUTCOME_RULES[outcome] : null;
  const canQualify = rule?.suggestsQualified === true && BEFORE_QUALIFIED.includes(lead.status);

  /** What saving will do, said before it happens. */
  const consequence = (): string => {
    if (!rule) return '';
    if (close) return `The lead will be closed as Lost${lostReason ? ` — “${lostReason}”` : ''}. Open follow-ups are cancelled.`;
    if (!rule.reached) {
      return `Stage stays at ${humanise(lead.status)} — nobody was reached. The follow-up stays open and moves to the retry time.`;
    }
    const stage =
      markQualified && canQualify
        ? 'Stage moves to Qualified. '
        : lead.status === 'NEW'
          ? 'Stage moves to Contacted. '
          : '';
    return `${stage}This follow-up is marked done and the next one is scheduled.`;
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!outcome || !rule) return;

    record.mutate(
      {
        idempotencyKey,
        outcome,
        ...(followUpId ? { followUpId } : {}),
        ...(contactId ? { contactId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(close
          ? { close: true, ...(lostReason.trim() ? { lostReason: lostReason.trim() } : {}) }
          : { nextFollowUpAt: zonedInputToIso(nextAt), nextType }),
        ...(canQualify && markQualified ? { markQualified: true } : {}),
        ...(rule.capturesRequirement
          ? {
              ...(productInterest.trim() ? { productInterest: productInterest.trim() } : {}),
              ...(quantity.trim() ? { quantity: quantity.trim() } : {}),
              ...(expectedPurchaseDate ? { expectedPurchaseDate } : {}),
            }
          : {}),
      },
      {
        onSuccess: (result) => {
          clearOutcomeDraft(lead.id);
          toast.success(
            close
              ? `${rule.label}. ${lead.name} closed as Lost.`
              : `${rule.label}. Next: ${formatDateTime(result.nextFollowUpAt)}.`,
          );
          onClose();
        },
      },
    );
  };

  const outcomeButton = (code: CallOutcome) => (
    <button
      key={code}
      type="button"
      role="radio"
      aria-checked={outcome === code}
      onClick={() => setOutcome(code)}
      className={`rounded-lg px-3 py-2 text-left text-sm transition ${
        outcome === code
          ? 'bg-slate-900 text-white'
          : 'bg-white text-slate-700 ring-1 ring-slate-200 ring-inset hover:bg-slate-50'
      }`}
    >
      {CALL_OUTCOME_RULES[code].label}
    </button>
  );

  return (
    <Dialog open={open} title={`How did the call go? — ${lead.name}`} onClose={cancel}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        {restored && (
          <p role="status" className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
            Restored what you entered before. Check it and save.
          </p>
        )}
        <ContactPicker
          id="oc-contact"
          label="Who did you call?"
          contacts={contacts.data}
          value={contactId}
          onChange={setContactId}
          error={fieldErrorOf(record.error, 'contactId')}
        />
        <fieldset>
          <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-700">
            Reached them
          </legend>
          <div role="radiogroup" aria-label="Reached them" className="grid gap-1.5 sm:grid-cols-2">
            {REACHED.map(outcomeButton)}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700">
            Couldn’t reach
          </legend>
          <div role="radiogroup" aria-label="Couldn’t reach" className="grid grid-cols-2 gap-1.5">
            {NOT_REACHED.map(outcomeButton)}
          </div>
        </fieldset>

        {rule && (
          <>
            {rule.capturesRequirement && (
              <div className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field label="What do they need?" htmlFor="oc-product" error={fieldErrorOf(record.error, 'productInterest')}>
                    <input id="oc-product" value={productInterest} maxLength={200} onChange={(e) => setProductInterest(e.target.value)} placeholder="e.g. Dehydrated onion flakes" className={inputClass} />
                  </Field>
                </div>
                <Field label="Quantity" htmlFor="oc-qty" error={fieldErrorOf(record.error, 'quantity')}>
                  <input id="oc-qty" value={quantity} maxLength={100} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 500 kg monthly" className={inputClass} />
                </Field>
                <Field label="Expected purchase" htmlFor="oc-date" error={fieldErrorOf(record.error, 'expectedPurchaseDate')}>
                  <input id="oc-date" type="date" value={expectedPurchaseDate} onChange={(e) => setExpectedPurchaseDate(e.target.value)} className={inputClass} />
                </Field>
              </div>
            )}

            {canQualify && (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={markQualified} onChange={(e) => setMarkQualified(e.target.checked)} className="h-4 w-4" />
                Mark the lead Qualified
              </label>
            )}

            {rule.offersClose && (
              <fieldset className="space-y-1.5 rounded-lg bg-slate-50 p-3">
                <legend className="px-1 text-sm font-medium text-slate-700">What next?</legend>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="radio" name="oc-next" checked={!close} onChange={() => setClose(false)} className="h-4 w-4" />
                  Schedule the next action
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="radio" name="oc-next" checked={close} onChange={() => setClose(true)} className="h-4 w-4" />
                  Close the lead as Lost
                </label>
              </fieldset>
            )}

            {close ? (
              <Field label="Why was it lost?" htmlFor="oc-lost" required error={fieldErrorOf(record.error, 'lostReason')}>
                <input id="oc-lost" value={lostReason} maxLength={255} onChange={(e) => setLostReason(e.target.value)} className={inputClass} />
              </Field>
            ) : (
              <div className="space-y-2">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <Field
                    label={rule.reached ? 'Next action' : 'Try again'}
                    htmlFor="oc-when"
                    required
                    error={fieldErrorOf(record.error, 'nextFollowUpAt')}
                  >
                    <input id="oc-when" type="datetime-local" value={nextAt} required onChange={(e) => setNextAt(e.target.value)} className={inputClass} />
                  </Field>
                  <Field label="By" htmlFor="oc-type">
                    <select id="oc-type" value={nextType} onChange={(e) => setNextType(e.target.value)} className={inputClass}>
                      {NEXT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {humanise(t)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setNextAt(preset.value())}
                      className="rounded-full border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Field label="Note" htmlFor="oc-note" hint="Goes on the timeline with this call.">
              <textarea id="oc-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
            </Field>

            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="outcome-consequence">
              {consequence()}
            </p>
          </>
        )}

        {record.isError && (
          <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(record.error, 'Could not save the call outcome.')}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button type="button" onClick={cancel} className="rounded-lg px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-100">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!rule || record.isPending || (!close && !nextAt) || (close && !lostReason.trim())}
            aria-busy={record.isPending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {record.isPaused
              ? // Offline: the save is held and sent on reconnect.
                'Waiting for connection…'
              : record.isPending
              ? 'Saving…'
              : !rule
                ? 'Choose what happened'
                : close
                  ? 'Save and close lead'
                  : rule.reached
                    ? 'Save outcome'
                    : 'Save and schedule retry'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
