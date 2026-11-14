import { CONTACT_DEPARTMENTS, MAX_CONTACTS_ON_CREATE } from '@leadflow/api-types';

export interface ExtraContactDraft {
  firstName: string;
  lastName: string;
  designation: string;
  department: string;
  mobile: string;
  whatsapp: string;
  email: string;
}

export const EMPTY_EXTRA: ExtraContactDraft = {
  firstName: '',
  lastName: '',
  designation: '',
  department: '',
  mobile: '',
  whatsapp: '',
  email: '',
};

const input =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900';

/** A row nobody typed into is ignored rather than sent as an error. */
export function isBlank(draft: ExtraContactDraft): boolean {
  return Object.values(draft).every((v) => !v.trim());
}

/** The API body: trimmed, blanks left out, at most one primary. */
export function toAdditionalContacts(drafts: ExtraContactDraft[], primaryIndex: number) {
  return drafts
    .map((draft, index) => ({ draft, index }))
    .filter(({ draft }) => !isBlank(draft))
    .map(({ draft, index }) => {
      const body: Record<string, string | boolean> = {};
      for (const [k, v] of Object.entries(draft)) if (v.trim()) body[k] = v.trim();
      if (index === primaryIndex) body['isPrimary'] = true;
      return body;
    });
}

/**
 * More people at the customer, added with the new lead -- purchase, accounts,
 * the owner. The enquirer above is always the first contact; the radio picks
 * who is primary (-1 = the enquirer).
 */
export function ExtraContactsField({
  drafts,
  onChange,
  primaryIndex,
  onPrimaryChange,
  errorAt,
}: {
  drafts: ExtraContactDraft[];
  onChange: (drafts: ExtraContactDraft[]) => void;
  primaryIndex: number;
  onPrimaryChange: (index: number) => void;
  errorAt: (field: string) => string | undefined;
}): React.JSX.Element {
  const update = (index: number, field: keyof ExtraContactDraft, value: string) =>
    onChange(drafts.map((d, i) => (i === index ? { ...d, [field]: value } : d)));
  const remove = (index: number) => {
    onChange(drafts.filter((_, i) => i !== index));
    if (primaryIndex === index) onPrimaryChange(-1);
    else if (primaryIndex > index) onPrimaryChange(primaryIndex - 1);
  };

  return (
    <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
      <legend className="px-1 text-sm font-medium text-slate-700">Other contacts at this company</legend>
      {drafts.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="radio" name="primary-contact" checked={primaryIndex === -1} onChange={() => onPrimaryChange(-1)} />
          The person above is the primary contact
        </label>
      )}
      {drafts.map((draft, index) => {
        const err = (field: string) => errorAt(`additionalContacts.${index}.${field}`);
        const errors = ['firstName', 'mobile', 'whatsapp', 'email'].map(err).filter(Boolean);
        return (
          <div key={index} className="space-y-2 rounded-lg bg-slate-50 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Contact {index + 2}</span>
              <button type="button" onClick={() => remove(index)} className="text-xs text-red-600 hover:underline">
                Remove
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input aria-label="First name" placeholder="First name *" value={draft.firstName} maxLength={80} onChange={(e) => update(index, 'firstName', e.target.value)} className={input} />
              <input aria-label="Last name" placeholder="Last name" value={draft.lastName} maxLength={80} onChange={(e) => update(index, 'lastName', e.target.value)} className={input} />
              <input aria-label="Designation" placeholder="Designation" value={draft.designation} maxLength={100} onChange={(e) => update(index, 'designation', e.target.value)} className={input} />
              <input aria-label="Department" placeholder="Department" list="extra-departments" value={draft.department} maxLength={60} onChange={(e) => update(index, 'department', e.target.value)} className={input} />
              <input aria-label="Mobile" placeholder="Mobile" type="tel" inputMode="tel" value={draft.mobile} maxLength={30} onChange={(e) => update(index, 'mobile', e.target.value)} className={input} />
              <input aria-label="WhatsApp" placeholder="WhatsApp, if different" type="tel" inputMode="tel" value={draft.whatsapp} maxLength={30} onChange={(e) => update(index, 'whatsapp', e.target.value)} className={input} />
              <input aria-label="Email" placeholder="Email" type="email" inputMode="email" value={draft.email} maxLength={320} onChange={(e) => update(index, 'email', e.target.value)} className={`${input} sm:col-span-2`} />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="radio" name="primary-contact" checked={primaryIndex === index} onChange={() => onPrimaryChange(index)} />
              Primary contact
            </label>
            {errors.length > 0 && (
              <p role="alert" className="text-xs text-red-600">
                {errors.join(' ')}
              </p>
            )}
          </div>
        );
      })}
      <datalist id="extra-departments">
        {CONTACT_DEPARTMENTS.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      {drafts.length < MAX_CONTACTS_ON_CREATE && (
        <button
          type="button"
          onClick={() => onChange([...drafts, { ...EMPTY_EXTRA }])}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-white"
        >
          + Add another contact
        </button>
      )}
    </fieldset>
  );
}
