import { useEffect, useState, type FormEvent } from 'react';
import {
  QUALIFICATION_NOTE_OUTCOMES,
  REFINEMENT_OUTCOMES,
  type LeadQualification,
} from '@leadflow/api-types';
import { Card, CardHeader, SkeletonRows } from '../../components/ui';
import { useToast } from '../../components/toast';
import { formatDateTime } from '../../lib/format';
import { zonedInputToIso } from '../../lib/zoned-input';
import { ContactPicker, Dialog, DialogActions, Field, errorMessage, fieldErrorOf, inputClass } from './lead-dialogs';
import { useLeadContacts } from './use-lead-contacts';
import {
  useLeadQualification,
  useQualificationNote,
  useRefineLead,
  useRevertToRough,
} from './use-lead-qualification';

/** "Rough" / "Refined" pill, for lists and the lead header. */
export function QualificationBadge({ qualification }: { qualification: LeadQualification | undefined }): React.JSX.Element | null {
  if (!qualification) return null;
  return qualification === 'ROUGH' ? (
    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">Rough</span>
  ) : (
    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">Refined</span>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  ...REFINEMENT_OUTCOMES,
  EXISTING_LEAD: 'Already being worked before qualification started',
};

/**
 * Rough -> Refined on the lead page.
 *
 * Rough: what still needs verifying, a qualification note, and Mark as Refined
 * (for people allowed to qualify). Refined: who refined it, when and why, and
 * Revert to Rough with a reason.
 */
export function LeadQualificationCard({
  leadId,
  canUpdate,
  canQualify,
  noteOpen,
  onNoteOpenChange,
}: {
  leadId: string;
  canUpdate: boolean;
  canQualify: boolean;
  /** Lets the page's Call button open the qualification note for a Rough lead. */
  noteOpen: boolean;
  onNoteOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const view = useLeadQualification(leadId);
  const [refining, setRefining] = useState(false);
  const [reverting, setReverting] = useState(false);
  const data = view.data;

  return (
    <Card>
      <CardHeader
        title="Qualification"
        subtitle={data ? (data.qualification === 'ROUGH' ? 'Rough — verify before sales follow-up' : 'Refined — in the sales workflow') : undefined}
        action={<QualificationBadge qualification={data?.qualification} />}
      />
      {view.isPending || !data ? (
        <SkeletonRows rows={2} />
      ) : data.qualification === 'ROUGH' ? (
        <div className="space-y-3 px-5 py-4 text-sm">
          <ul className="space-y-1">
            <Check ok={data.checklist.company} label="Company name or customer recorded" />
            <Check ok={data.checklist.contact} label="A contact with a phone number or email" />
            <Check ok={null} label="Business fit confirmed (when you refine)" />
          </ul>
          <p className="text-xs text-slate-500">
            Rough leads stay out of the sales follow-up queues and overdue counts. Research and qualify them here.
          </p>
          <div className="flex flex-wrap gap-2">
            {canUpdate && (
              <button type="button" onClick={() => onNoteOpenChange(true)} className={secondary}>
                Log qualification note
              </button>
            )}
            {canQualify && (
              <button type="button" onClick={() => setRefining(true)} className={primary}>
                Mark as Refined
              </button>
            )}
          </div>
          {!canQualify && <p className="text-xs text-slate-500">A manager or admin marks leads as Refined.</p>}
        </div>
      ) : (
        <div className="space-y-2 px-5 py-4 text-sm">
          <p className="text-slate-700">
            {OUTCOME_LABEL[data.refinementOutcome ?? ''] ?? 'Refined'}
            {data.refinementNote ? ` — ${data.refinementNote}` : ''}
          </p>
          {data.refinedAt && (
            <p className="text-xs text-slate-500">
              {data.refinedBy ? `By ${data.refinedBy.fullName}, ` : ''}
              {formatDateTime(data.refinedAt)}
            </p>
          )}
          {canQualify && (
            <button type="button" onClick={() => setReverting(true)} className={secondary}>
              Revert to Rough
            </button>
          )}
        </div>
      )}

      <NoteDialog leadId={leadId} open={noteOpen} onClose={() => onNoteOpenChange(false)} />
      <RefineDialog
        leadId={leadId}
        open={refining}
        checklist={data?.checklist}
        onClose={() => setRefining(false)}
      />
      <RevertDialog leadId={leadId} open={reverting} onClose={() => setReverting(false)} />
    </Card>
  );
}

const primary =
  'rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:opacity-50';
const secondary =
  'rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50';

function Check({ ok, label }: { ok: boolean | null; label: string }): React.JSX.Element {
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
          ok === null ? 'bg-slate-100 text-slate-500' : ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-50 text-red-600'
        }`}
      >
        {ok === null ? '•' : ok ? '✓' : '!'}
      </span>
      <span className={ok === false ? 'text-red-700' : 'text-slate-700'}>{label}</span>
    </li>
  );
}

function NoteDialog({ leadId, open, onClose }: { leadId: string; open: boolean; onClose: () => void }): React.JSX.Element | null {
  const save = useQualificationNote(leadId);
  const contacts = useLeadContacts(open ? leadId : undefined);
  const toast = useToast();
  const [outcome, setOutcome] = useState('RESEARCHED');
  const [note, setNote] = useState('');
  const [nextAt, setNextAt] = useState('');
  const [contactId, setContactId] = useState('');

  useEffect(() => {
    if (!open) return;
    setOutcome('RESEARCHED');
    setNote('');
    setNextAt('');
    setContactId('');
    save.reset();
  }, [open]);

  if (!open) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate(
      {
        outcome,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(nextAt ? { nextQualificationAt: zonedInputToIso(nextAt) } : {}),
        ...(contactId ? { contactId } : {}),
      },
      {
        onSuccess: () => {
          toast.success('Qualification note saved.');
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={open} title="Log qualification note" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <Field label="What happened?" htmlFor="qn-outcome" required>
          <select id="qn-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} className={inputClass}>
            {Object.entries(QUALIFICATION_NOTE_OUTCOMES).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <ContactPicker id="qn-contact" label="With" contacts={contacts.data} value={contactId} onChange={setContactId} />
        <Field label="Note" htmlFor="qn-note" hint={`${note.length}/1000`} error={fieldErrorOf(save.error, 'note')}>
          <textarea id="qn-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
        </Field>
        <Field
          label="Qualify again by"
          htmlFor="qn-next"
          hint="Optional. Moves this lead's qualify-by date."
          error={fieldErrorOf(save.error, 'nextQualificationAt')}
        >
          <input id="qn-next" type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} className={inputClass} />
        </Field>
        {save.isError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(save.error, 'Could not save the note.')}
          </p>
        )}
        <DialogActions onCancel={onClose} busy={save.isPending} label="Save note" busyLabel="Saving…" />
      </form>
    </Dialog>
  );
}

function RefineDialog({
  leadId,
  open,
  checklist,
  onClose,
}: {
  leadId: string;
  open: boolean;
  checklist: { company: boolean; contact: boolean } | undefined;
  onClose: () => void;
}): React.JSX.Element | null {
  const refine = useRefineLead(leadId);
  const toast = useToast();
  const [outcome, setOutcome] = useState('GENUINE_REQUIREMENT');
  const [note, setNote] = useState('');
  const [fit, setFit] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOutcome('GENUINE_REQUIREMENT');
    setNote('');
    setFit(false);
    refine.reset();
  }, [open]);

  if (!open) return null;

  const missing = [
    ...(checklist && !checklist.company ? ['Add the company name or link the customer (Edit details).'] : []),
    ...(checklist && !checklist.contact ? ['Add a contact with a phone number or email (Contacts).'] : []),
  ];
  const noteNeeded = outcome === 'OTHER' && !note.trim();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    refine.mutate(
      { outcome, businessFitConfirmed: fit, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          toast.success('Lead marked as Refined. It is now in the sales workflow.');
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={open} title="Mark as Refined" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        {missing.length > 0 && (
          <div role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-medium">Before refining:</p>
            <ul className="mt-1 list-disc pl-5">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        <Field label="Outcome" htmlFor="rf-outcome" required>
          <select id="rf-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} className={inputClass}>
            {Object.entries(REFINEMENT_OUTCOMES).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Note"
          htmlFor="rf-note"
          required={outcome === 'OTHER'}
          hint={`What you verified. ${note.length}/1000`}
          error={fieldErrorOf(refine.error, 'note')}
        >
          <textarea id="rf-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
        </Field>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-0.5" checked={fit} onChange={(e) => setFit(e.target.checked)} />
          I have verified the company, a relevant contact and that this is a fit for our business.
        </label>
        {refine.isError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(refine.error, 'Could not refine the lead.')}
          </p>
        )}
        <DialogActions
          onCancel={onClose}
          busy={refine.isPending}
          disabled={!fit || missing.length > 0 || noteNeeded}
          label="Mark as Refined"
          busyLabel="Saving…"
        />
      </form>
    </Dialog>
  );
}

function RevertDialog({ leadId, open, onClose }: { leadId: string; open: boolean; onClose: () => void }): React.JSX.Element | null {
  const revert = useRevertToRough(leadId);
  const toast = useToast();
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) return;
    setReason('');
    revert.reset();
  }, [open]);

  if (!open) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    revert.mutate(
      { reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Lead reverted to Rough.');
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={open} title="Revert to Rough?" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <p className="text-sm text-slate-700">
          The lead leaves the sales queues and counts until it is refined again. Its follow-ups are kept, not cancelled.
        </p>
        <Field label="Reason" htmlFor="rv-reason" required hint="At least 5 characters. Recorded on the timeline." error={fieldErrorOf(revert.error, 'reason')}>
          <textarea id="rv-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </Field>
        {revert.isError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(revert.error, 'Could not revert the lead.')}
          </p>
        )}
        <DialogActions onCancel={onClose} busy={revert.isPending} disabled={reason.trim().length < 5} label="Revert to Rough" busyLabel="Saving…" />
      </form>
    </Dialog>
  );
}
