import { useEffect, useState, type FormEvent } from 'react';
import { CONTACT_DEPARTMENTS, ERROR_CODES } from '@leadflow/api-types';
import { Card, CardHeader, EmptyState, SkeletonRows } from '../../components/ui';
import { useToast } from '../../components/toast';
import { ApiError } from '../../lib/api-client';
import { telHref, whatsappHref } from '../../lib/format';
import { Dialog, DialogActions, Field, errorMessage, fieldErrorOf, inputClass } from './lead-dialogs';
import {
  useAddLeadContact,
  useLeadContactAction,
  useLeadContacts,
  useUpdateLeadContact,
  type LeadContact,
  type LeadContactInput,
} from './use-lead-contacts';

/**
 * The people to speak to about this lead -- purchase, accounts, the owner.
 *
 * Call and WhatsApp are plain `tel:` / wa.me links: the dialler or WhatsApp
 * opens on the phone (an Android intent in the app) and nothing is sent or
 * logged until the rep records what happened.
 */
export function LeadContactsCard({ leadId, canEdit }: { leadId: string; canEdit: boolean }): React.JSX.Element {
  const contacts = useLeadContacts(leadId);
  const action = useLeadContactAction(leadId);
  const toast = useToast();
  const [editing, setEditing] = useState<LeadContact | 'new' | null>(null);
  const [confirming, setConfirming] = useState<LeadContact | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const all = contacts.data ?? [];
  const active = all.filter((c) => c.active);
  const inactive = all.filter((c) => !c.active);
  const shown = showInactive ? all : active;

  const run = (contact: LeadContact, kind: 'primary' | 'deactivate' | 'reactivate', done: string): void => {
    action.mutate(
      { linkId: contact.id, action: kind },
      {
        onSuccess: () => toast.success(done),
        onError: (error) => toast.error(errorMessage(error, 'Could not update the contact.')),
      },
    );
  };

  return (
    <Card>
      <CardHeader
        title="Contacts"
        subtitle={`${active.length} active${inactive.length ? ` · ${inactive.length} inactive` : ''}`}
        action={
          canEdit ? (
            <button
              type="button"
              onClick={() => setEditing('new')}
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              + Add contact
            </button>
          ) : undefined
        }
      />
      {contacts.isPending ? (
        <SkeletonRows rows={2} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="☺"
          title="No contacts yet"
          description="Add the people you deal with at this customer — purchase, accounts, the owner."
        />
      ) : (
        <ul className="divide-y divide-slate-100">
          {shown.map((contact) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              canEdit={canEdit}
              busy={action.isPending}
              onEdit={() => setEditing(contact)}
              onPrimary={() => run(contact, 'primary', `${contact.name} is now the primary contact.`)}
              onDeactivate={() => setConfirming(contact)}
              onReactivate={() => run(contact, 'reactivate', `${contact.name} is active again.`)}
            />
          ))}
        </ul>
      )}
      {inactive.length > 0 && (
        <div className="border-t border-slate-100 px-5 py-2">
          <button
            type="button"
            onClick={() => setShowInactive((v) => !v)}
            className="text-xs font-medium text-slate-500 hover:text-slate-800"
          >
            {showInactive ? 'Hide inactive contacts' : `Show ${inactive.length} inactive`}
          </button>
        </div>
      )}

      <ContactDialog
        leadId={leadId}
        contact={editing === 'new' ? null : editing}
        open={editing !== null}
        isFirst={active.length === 0}
        onClose={() => setEditing(null)}
      />

      <Dialog open={confirming !== null} title="Mark contact inactive?" onClose={() => setConfirming(null)}>
        <div className="space-y-3 p-5 text-sm text-slate-700">
          <p>
            <strong>{confirming?.name}</strong> will no longer be offered when you call, follow up or log an outcome
            on this lead. Calls already logged with them are kept.
          </p>
          {confirming?.isPrimary && active.length > 1 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
              They are the primary contact. The longest-standing active contact becomes primary.
            </p>
          )}
          <p className="text-xs text-slate-500">You can mark them active again at any time.</p>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="rounded-lg px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={action.isPending}
              onClick={() => {
                if (confirming) run(confirming, 'deactivate', `${confirming.name} marked inactive.`);
                setConfirming(null);
              }}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              Mark inactive
            </button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

function ContactRow({
  contact,
  canEdit,
  busy,
  onEdit,
  onPrimary,
  onDeactivate,
  onReactivate,
}: {
  contact: LeadContact;
  canEdit: boolean;
  busy: boolean;
  onEdit: () => void;
  onPrimary: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}): React.JSX.Element {
  const call = telHref(contact.mobile);
  const chat = whatsappHref(contact.whatsapp ?? contact.mobile);
  const role = [contact.designation, contact.department].filter(Boolean).join(' · ');

  return (
    <li className={`px-5 py-3 ${contact.active ? '' : 'opacity-60'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-900">{contact.name}</span>
        {contact.isPrimary ? (
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">Primary</span>
        ) : contact.active ? (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">Secondary</span>
        ) : (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">Inactive</span>
        )}
      </div>
      {role && <p className="mt-0.5 text-xs text-slate-500">{role}</p>}
      <div className="mt-1 space-y-0.5 text-xs text-slate-600">
        {contact.mobile && <p className="font-mono">{contact.mobile}</p>}
        {contact.whatsapp && <p className="font-mono">WhatsApp {contact.whatsapp}</p>}
        {contact.email && <p className="break-all">{contact.email}</p>}
        {contact.notes && <p className="text-slate-500">{contact.notes}</p>}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {contact.active && call && (
          <a href={call} className="rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800">
            Call
          </a>
        )}
        {contact.active && chat && (
          <a
            href={chat}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-emerald-300 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
          >
            WhatsApp
          </a>
        )}
        {contact.active && contact.email && (
          <a
            href={`mailto:${contact.email}`}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Email
          </a>
        )}
        {canEdit && (
          <>
            <button type="button" onClick={onEdit} className={secondaryButton}>
              Edit
            </button>
            {contact.active && !contact.isPrimary && (
              <button type="button" disabled={busy} onClick={onPrimary} className={secondaryButton}>
                Set as primary
              </button>
            )}
            {contact.active ? (
              <button type="button" disabled={busy} onClick={onDeactivate} className={`${secondaryButton} text-red-600`}>
                Mark inactive
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={onReactivate} className={secondaryButton}>
                Mark active
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

const secondaryButton =
  'rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50';

const EMPTY: LeadContactInput = {
  firstName: '',
  lastName: '',
  designation: '',
  department: '',
  mobile: '',
  whatsapp: '',
  email: '',
  notes: '',
};

/** Add (contact null) or edit. A DUPLICATE_CONTACT warning asks once, then adds on confirmation. */
function ContactDialog({
  leadId,
  contact,
  open,
  isFirst,
  onClose,
}: {
  leadId: string;
  contact: LeadContact | null;
  open: boolean;
  isFirst: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const add = useAddLeadContact(leadId);
  const update = useUpdateLeadContact(leadId);
  const toast = useToast();
  const [form, setForm] = useState<LeadContactInput>(EMPTY);
  const [makePrimary, setMakePrimary] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(
      contact
        ? {
            firstName: contact.firstName ?? '',
            lastName: contact.lastName ?? '',
            designation: contact.designation ?? '',
            department: contact.department ?? '',
            mobile: contact.mobile ?? '',
            whatsapp: contact.whatsapp ?? '',
            email: contact.email ?? '',
            notes: contact.notes ?? '',
          }
        : EMPTY,
    );
    setMakePrimary(false);
    setDuplicate(null);
    add.reset();
    update.reset();
  }, [open, contact?.id]);

  if (!open) return null;

  const mutation = contact ? update : add;
  const set = (field: keyof LeadContactInput) => (event: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [field]: event.target.value }));
    setDuplicate(null);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const allowDuplicate = duplicate !== null;
    const onError = (error: unknown) => {
      if (error instanceof ApiError && error.code === ERROR_CODES.DUPLICATE_CONTACT && !error.details?.['linkId']) {
        setDuplicate(error.message);
      }
    };
    if (contact) {
      // An edit sends every field, so a cleared box clears the value.
      update.mutate(
        { linkId: contact.id, ...form, allowDuplicate },
        {
          onSuccess: () => {
            toast.success('Contact saved.');
            onClose();
          },
          onError,
        },
      );
      return;
    }
    const body: LeadContactInput = { firstName: form.firstName };
    for (const [k, v] of Object.entries(form) as [keyof LeadContactInput, string][]) {
      if (k !== 'firstName' && typeof v === 'string' && v.trim()) (body as unknown as Record<string, string>)[k] = v.trim();
    }
    add.mutate(
      { ...body, ...(makePrimary ? { isPrimary: true } : {}), ...(allowDuplicate ? { allowDuplicate } : {}) },
      {
        onSuccess: (created) => {
          toast.success(`${created.name} added${created.isPrimary ? ' as the primary contact' : ''}.`);
          onClose();
        },
        onError,
      },
    );
  };

  const err = (field: string) => fieldErrorOf(mutation.error, field);

  return (
    <Dialog open={open} title={contact ? `Edit ${contact.name}` : 'Add contact'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" htmlFor="poc-first" required error={err('firstName')}>
            <input id="poc-first" value={form.firstName} maxLength={80} onChange={set('firstName')} className={inputClass} />
          </Field>
          <Field label="Last name" htmlFor="poc-last" error={err('lastName')}>
            <input id="poc-last" value={form.lastName} maxLength={80} onChange={set('lastName')} className={inputClass} />
          </Field>
          <Field label="Designation" htmlFor="poc-designation" hint="e.g. Purchase Manager" error={err('designation')}>
            <input id="poc-designation" value={form.designation} maxLength={100} onChange={set('designation')} className={inputClass} />
          </Field>
          <Field label="Department" htmlFor="poc-department" error={err('department')}>
            <input
              id="poc-department"
              list="poc-departments"
              value={form.department}
              maxLength={60}
              onChange={set('department')}
              className={inputClass}
            />
            <datalist id="poc-departments">
              {CONTACT_DEPARTMENTS.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </Field>
          <Field label="Mobile" htmlFor="poc-mobile" error={err('mobile')}>
            <input id="poc-mobile" type="tel" inputMode="tel" value={form.mobile} maxLength={30} onChange={set('mobile')} className={inputClass} />
          </Field>
          <Field label="WhatsApp" htmlFor="poc-whatsapp" hint="Only if different from mobile" error={err('whatsapp')}>
            <input id="poc-whatsapp" type="tel" inputMode="tel" value={form.whatsapp} maxLength={30} onChange={set('whatsapp')} className={inputClass} />
          </Field>
        </div>
        <Field label="Email" htmlFor="poc-email" error={err('email')}>
          <input id="poc-email" type="email" inputMode="email" value={form.email} maxLength={320} onChange={set('email')} className={inputClass} />
        </Field>
        <Field label="Notes" htmlFor="poc-notes" hint={`About their role on this lead. ${form.notes?.length ?? 0}/500`} error={err('notes')}>
          <textarea id="poc-notes" rows={2} value={form.notes} maxLength={500} onChange={set('notes')} className={inputClass} />
        </Field>

        {!contact && !isFirst && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={makePrimary} onChange={(e) => setMakePrimary(e.target.checked)} />
            Make this the primary contact
          </label>
        )}
        {contact && <p className="text-xs text-slate-500">Name, numbers and designation update this person on every lead they are on.</p>}

        {duplicate ? (
          <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {duplicate} Press {contact ? 'Save' : 'Add'} again to continue.
          </p>
        ) : (
          mutation.isError && (
            <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {errorMessage(mutation.error, 'Could not save the contact.')}
            </p>
          )
        )}

        <DialogActions
          onCancel={onClose}
          busy={mutation.isPending}
          disabled={!form.firstName.trim()}
          label={duplicate ? (contact ? 'Save anyway' : 'Add anyway') : contact ? 'Save' : 'Add'}
          busyLabel="Saving…"
        />
      </form>
    </Dialog>
  );
}
