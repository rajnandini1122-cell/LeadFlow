import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LEAD_PRIORITIES,
  LEAD_STATUSES,
  isTerminalLeadStatus,
  type LeadPriority,
  type LeadStatus,
} from '@leadflow/api-types';
import { ApiError, apiGet } from '../../lib/api-client';
import { humanise } from '../../lib/format';
import type { LeadDetail } from './use-leads';
import {
  useAssignLead,
  useCompleteFollowUp,
  useCreateFollowUp,
  useRescheduleFollowUp,
  useUpdateLead,
  type FollowUp,
} from './use-lead-mutations';

const FOLLOW_UP_TYPES = ['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'OTHER'];

/** Local datetime string for `datetime-local`, offset-corrected. */
export function toLocalInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function defaultNextFollowUp(days = 3): string {
  const date = new Date(Date.now() + days * 86_400_000);
  date.setHours(11, 0, 0, 0);
  return toLocalInput(date);
}

/**
 * Modal shell with the accessibility behaviour every dialog needs.
 *
 * Focus is moved in on open, trapped while open, and restored to whatever
 * opened it on close. Without the trap, Tab walks into the page behind the
 * overlay, which for a keyboard user makes the dialog effectively a dead end.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;

    const focusable = (): HTMLElement[] =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href]',
        ) ?? [],
      ).filter((element) => !element.hasAttribute('disabled'));

    focusable()[0]?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) return;

      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      (opener.current as HTMLElement | null)?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="my-8 w-full max-w-lg rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-400';

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | undefined;
  required?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function fieldErrorOf(error: unknown, field: string): string | undefined {
  return error instanceof ApiError ? error.details?.[field]?.[0] : undefined;
}

// -----------------------------------------------------------------------------
// Edit lead
// -----------------------------------------------------------------------------

export function EditLeadDialog({
  lead,
  open,
  onClose,
}: {
  lead: LeadDetail;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const update = useUpdateLead(lead.id);

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    mobile: '',
    email: '',
    companyName: '',
    city: '',
    source: '',
    productInterest: '',
    estimatedValue: '',
    priority: 'MEDIUM' as LeadPriority,
  });

  // Reload from the record each time it opens, so a cancelled edit does not
  // leave stale values behind on the next open.
  useEffect(() => {
    if (!open) return;
    const [firstName = '', ...rest] = lead.name === '(no name)' ? [''] : lead.name.split(' ');

    setForm({
      firstName,
      lastName: rest.join(' '),
      mobile: lead.mobile ?? '',
      email: '',
      companyName: lead.companyName ?? '',
      city: '',
      source: '',
      productInterest: '',
      estimatedValue: lead.estimatedValue ?? '',
      priority: lead.priority,
    });
    update.reset();
  }, [open, lead]);

  if (!open) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    update.mutate(
      {
        firstName: form.firstName,
        ...(form.lastName ? { lastName: form.lastName } : {}),
        ...(form.mobile ? { mobile: form.mobile } : {}),
        ...(form.email ? { email: form.email } : {}),
        ...(form.companyName ? { companyName: form.companyName } : {}),
        ...(form.city ? { city: form.city } : {}),
        ...(form.source ? { source: form.source } : {}),
        ...(form.productInterest ? { productInterest: form.productInterest } : {}),
        ...(form.estimatedValue ? { estimatedValue: Number(form.estimatedValue) } : {}),
        priority: form.priority,
      },
      { onSuccess: onClose },
    );
  };

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <Dialog open={open} title="Edit lead" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="edit-first" required error={fieldErrorOf(update.error, 'firstName')}>
            <input id="edit-first" value={form.firstName} required onChange={(e) => set('firstName')(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Last name" htmlFor="edit-last">
            <input id="edit-last" value={form.lastName} onChange={(e) => set('lastName')(e.target.value)} className={inputClass} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mobile" htmlFor="edit-mobile" error={fieldErrorOf(update.error, 'mobile')} hint="Stored as E.164.">
            <input id="edit-mobile" value={form.mobile} onChange={(e) => set('mobile')(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Email" htmlFor="edit-email" error={fieldErrorOf(update.error, 'email')}>
            <input id="edit-email" type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} className={inputClass} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company" htmlFor="edit-company">
            <input id="edit-company" value={form.companyName} onChange={(e) => set('companyName')(e.target.value)} className={inputClass} />
          </Field>
          <Field label="City" htmlFor="edit-city">
            <input id="edit-city" value={form.city} onChange={(e) => set('city')(e.target.value)} className={inputClass} />
          </Field>
        </div>

        <Field label="Product interest" htmlFor="edit-interest">
          <input id="edit-interest" value={form.productInterest} onChange={(e) => set('productInterest')(e.target.value)} className={inputClass} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Estimated value" htmlFor="edit-value">
            <input id="edit-value" type="number" min={0} value={form.estimatedValue} onChange={(e) => set('estimatedValue')(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Priority" htmlFor="edit-priority">
            <select id="edit-priority" value={form.priority} onChange={(e) => set('priority')(e.target.value)} className={inputClass}>
              {LEAD_PRIORITIES.map((key) => (
                <option key={key} value={key}>{humanise(key)}</option>
              ))}
            </select>
          </Field>
        </div>

        {update.isError && (
          <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(update.error, 'Could not save the lead.')}
          </p>
        )}

        <DialogActions onCancel={onClose} busy={update.isPending} label="Save changes" busyLabel="Saving…" />
      </form>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Change status
// -----------------------------------------------------------------------------

export function ChangeStatusDialog({
  lead,
  open,
  onClose,
}: {
  lead: LeadDetail;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const update = useUpdateLead(lead.id);

  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [lostReason, setLostReason] = useState('');
  const [wonValue, setWonValue] = useState('');
  const [nextFollowUpAt, setNextFollowUpAt] = useState(defaultNextFollowUp());

  useEffect(() => {
    if (!open) return;
    setStatus(lead.status);
    setLostReason('');
    setWonValue(lead.estimatedValue ?? '');
    setNextFollowUpAt(defaultNextFollowUp());
    update.reset();
  }, [open, lead]);

  if (!open) return null;

  const terminal = isTerminalLeadStatus(status);
  const reopening = isTerminalLeadStatus(lead.status) && !terminal;
  const needsFollowUp = !terminal && (reopening || !lead.nextFollowUpAt);

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    update.mutate(
      {
        status,
        ...(status === 'LOST' ? { lostReason } : {}),
        ...(status === 'WON' && wonValue ? { wonValue: Number(wonValue) } : {}),
        ...(needsFollowUp ? { nextFollowUpAt: new Date(nextFollowUpAt).toISOString() } : {}),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open={open} title="Change status" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <Field label="Status" htmlFor="status-select">
          <select
            id="status-select"
            value={status}
            onChange={(event) => setStatus(event.target.value as LeadStatus)}
            className={inputClass}
          >
            {LEAD_STATUSES.map((key) => (
              <option key={key} value={key}>{humanise(key)}</option>
            ))}
          </select>
        </Field>

        {status === 'LOST' && (
          <Field
            label="Why was it lost?"
            htmlFor="lost-reason"
            required
            error={fieldErrorOf(update.error, 'lostReason')}
            hint="The most useful field in the dataset — it answers why deals are lost."
          >
            <input id="lost-reason" value={lostReason} required onChange={(e) => setLostReason(e.target.value)} className={inputClass} />
          </Field>
        )}

        {status === 'WON' && (
          <Field label="Closed value" htmlFor="won-value" hint="What it actually closed at. The estimate is kept separately.">
            <input id="won-value" type="number" min={0} value={wonValue} onChange={(e) => setWonValue(e.target.value)} className={inputClass} />
          </Field>
        )}

        {needsFollowUp && (
          <Field
            label="Next follow-up"
            htmlFor="status-followup"
            required
            error={fieldErrorOf(update.error, 'nextFollowUpAt')}
            hint="An open lead must always have a next action."
          >
            <input id="status-followup" type="datetime-local" value={nextFollowUpAt} required onChange={(e) => setNextFollowUpAt(e.target.value)} className={inputClass} />
          </Field>
        )}

        {update.isError && (
          <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(update.error, 'Could not change the status.')}
          </p>
        )}

        <DialogActions onCancel={onClose} busy={update.isPending} label="Update status" busyLabel="Updating…" />
      </form>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Reassign
// -----------------------------------------------------------------------------

export function AssignLeadDialog({
  lead,
  open,
  onClose,
}: {
  lead: LeadDetail;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const assign = useAssignLead(lead.id);
  const [assignedToId, setAssignedToId] = useState(lead.assignedTo?.id ?? '');
  const [reason, setReason] = useState('');

  const members = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => apiGet<{ id: string; fullName: string }[]>('/leads/assignable-users'),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setAssignedToId(lead.assignedTo?.id ?? '');
    setReason('');
    assign.reset();
  }, [open, lead]);

  if (!open) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    assign.mutate({ assignedToId, ...(reason ? { reason } : {}) }, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} title="Reassign lead" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <Field label="Owner" htmlFor="assign-owner" required error={fieldErrorOf(assign.error, 'assignedToId')}>
          <select id="assign-owner" value={assignedToId} required onChange={(e) => setAssignedToId(e.target.value)} className={inputClass}>
            <option value="">Choose a team member</option>
            {(members.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>{member.fullName}</option>
            ))}
          </select>
        </Field>

        <Field label="Reason" htmlFor="assign-reason" hint="Recorded on the timeline.">
          <input id="assign-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </Field>

        {assign.isError && (
          <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(assign.error, 'Could not reassign the lead.')}
          </p>
        )}

        <DialogActions onCancel={onClose} busy={assign.isPending} label="Reassign" busyLabel="Reassigning…" />
      </form>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Schedule follow-up
// -----------------------------------------------------------------------------

export function ScheduleFollowUpDialog({
  leadId,
  open,
  onClose,
}: {
  leadId: string;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const create = useCreateFollowUp(leadId);

  const [scheduledAt, setScheduledAt] = useState(defaultNextFollowUp());
  const [type, setType] = useState('CALL');
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (!open) return;
    setScheduledAt(defaultNextFollowUp());
    setType('CALL');
    setTitle('');
    create.reset();
  }, [open]);

  if (!open) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    create.mutate(
      {
        scheduledAt: new Date(scheduledAt).toISOString(),
        type,
        ...(title ? { title } : {}),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open={open} title="Schedule follow-up" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <Field label="When" htmlFor="fu-when" required error={fieldErrorOf(create.error, 'scheduledAt')}>
          <input id="fu-when" type="datetime-local" value={scheduledAt} required onChange={(e) => setScheduledAt(e.target.value)} className={inputClass} />
        </Field>

        <Field label="Type" htmlFor="fu-type">
          <select id="fu-type" value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
            {FOLLOW_UP_TYPES.map((key) => (
              <option key={key} value={key}>{humanise(key)}</option>
            ))}
          </select>
        </Field>

        <Field label="What for?" htmlFor="fu-title" hint="Optional, but future-you will thank you.">
          <input id="fu-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
        </Field>

        {create.isError && (
          <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(create.error, 'Could not schedule the follow-up.')}
          </p>
        )}

        <DialogActions onCancel={onClose} busy={create.isPending} label="Schedule" busyLabel="Scheduling…" />
      </form>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Complete follow-up
// -----------------------------------------------------------------------------

const OUTCOMES = ['Spoke to customer', 'No answer', 'Call back later', 'Sent information', 'Meeting held'];

/**
 * Completion dialog.
 *
 * The "what next" choice is mandatory and explicit, because the API refuses a
 * bare completion on an open lead. Presenting it as a choice — schedule again,
 * or close the lead — turns a validation error into the actual decision the
 * salesperson has to make anyway.
 */
export function CompleteFollowUpDialog({
  followUp,
  open,
  onClose,
}: {
  followUp: FollowUp | null;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const complete = useCompleteFollowUp();

  const [outcome, setOutcome] = useState(OUTCOMES[0] as string);
  const [notes, setNotes] = useState('');
  const [next, setNext] = useState<'schedule' | 'won' | 'lost'>('schedule');
  const [nextFollowUpAt, setNextFollowUpAt] = useState(defaultNextFollowUp());
  const [lostReason, setLostReason] = useState('');
  const [wonValue, setWonValue] = useState('');

  useEffect(() => {
    if (!open) return;
    setOutcome(OUTCOMES[0] as string);
    setNotes('');
    setNext('schedule');
    setNextFollowUpAt(defaultNextFollowUp());
    setLostReason('');
    setWonValue('');
    complete.reset();
  }, [open, followUp]);

  if (!open || !followUp) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    complete.mutate(
      {
        id: followUp.id,
        leadId: followUp.leadId,
        outcome,
        ...(notes ? { notes } : {}),
        ...(next === 'schedule'
          ? { nextFollowUpAt: new Date(nextFollowUpAt).toISOString() }
          : next === 'won'
            ? { leadStatus: 'WON' as LeadStatus, ...(wonValue ? { wonValue: Number(wonValue) } : {}) }
            : { leadStatus: 'LOST' as LeadStatus, lostReason }),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open={open} title={`Complete follow-up — ${followUp.leadName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <Field label="What happened?" htmlFor="outcome">
          <select id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} className={inputClass}>
            {OUTCOMES.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </Field>

        <Field label="Notes" htmlFor="fu-notes">
          <textarea id="fu-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
        </Field>

        <fieldset className="rounded-lg bg-slate-50 p-3">
          <legend className="px-1 text-sm font-medium text-slate-700">What next?</legend>
          <div className="mt-1 space-y-1.5">
            {([
              ['schedule', 'Schedule the next follow-up'],
              ['won', 'Mark the lead won'],
              ['lost', 'Mark the lead lost'],
            ] as const).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="next-action"
                  value={value}
                  checked={next === value}
                  onChange={() => setNext(value)}
                  className="h-4 w-4"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        {next === 'schedule' && (
          <Field label="Next follow-up" htmlFor="next-when" required error={fieldErrorOf(complete.error, 'nextFollowUpAt')}>
            <input id="next-when" type="datetime-local" value={nextFollowUpAt} required onChange={(e) => setNextFollowUpAt(e.target.value)} className={inputClass} />
          </Field>
        )}

        {next === 'won' && (
          <Field label="Closed value" htmlFor="next-won">
            <input id="next-won" type="number" min={0} value={wonValue} onChange={(e) => setWonValue(e.target.value)} className={inputClass} />
          </Field>
        )}

        {next === 'lost' && (
          <Field label="Why was it lost?" htmlFor="next-lost" required error={fieldErrorOf(complete.error, 'lostReason')}>
            <input id="next-lost" value={lostReason} required onChange={(e) => setLostReason(e.target.value)} className={inputClass} />
          </Field>
        )}

        {complete.isError && (
          <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(complete.error, 'Could not complete the follow-up.')}
          </p>
        )}

        <DialogActions onCancel={onClose} busy={complete.isPending} label="Complete" busyLabel="Saving…" />
      </form>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Reschedule
// -----------------------------------------------------------------------------

export function RescheduleFollowUpDialog({
  followUp,
  open,
  onClose,
}: {
  followUp: FollowUp | null;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const reschedule = useRescheduleFollowUp();
  const [scheduledAt, setScheduledAt] = useState(defaultNextFollowUp(1));
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) return;
    setScheduledAt(defaultNextFollowUp(1));
    setReason('');
    reschedule.reset();
  }, [open, followUp]);

  if (!open || !followUp) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    reschedule.mutate(
      {
        id: followUp.id,
        leadId: followUp.leadId,
        scheduledAt: new Date(scheduledAt).toISOString(),
        ...(reason ? { reason } : {}),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open={open} title="Reschedule follow-up" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <Field label="New date and time" htmlFor="re-when" required>
          <input id="re-when" type="datetime-local" value={scheduledAt} required onChange={(e) => setScheduledAt(e.target.value)} className={inputClass} />
        </Field>

        <Field label="Reason" htmlFor="re-reason" hint="The original stays on the timeline, so the missed attempt is visible.">
          <input id="re-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </Field>

        {reschedule.isError && (
          <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(reschedule.error, 'Could not reschedule.')}
          </p>
        )}

        <DialogActions onCancel={onClose} busy={reschedule.isPending} label="Reschedule" busyLabel="Rescheduling…" />
      </form>
    </Dialog>
  );
}

function DialogActions({
  onCancel,
  busy,
  label,
  busyLabel,
}: {
  onCancel: () => void;
  busy: boolean;
  label: string;
  busyLabel: string;
}): React.JSX.Element {
  return (
    <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
      <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-100">
        Cancel
      </button>
      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? busyLabel : label}
      </button>
    </div>
  );
}
