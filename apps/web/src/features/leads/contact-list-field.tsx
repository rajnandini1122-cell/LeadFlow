import { MAX_ADDITIONAL_CONTACTS } from '@leadflow/api-types';

// Same as lead-dialogs' `inputClass`, repeated so the two files do not import
// each other.
const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-400';

/**
 * A short, editable list of extra phone numbers or email addresses.
 *
 * Exists because a lead held one mobile and one email: a customer's office
 * landline and second address were being typed into "Product interest"
 * (production, 2026-10-30). Each entry is its own input — never one box with a
 * comma-separated list, which is how two addresses end up failing validation
 * as one.
 */
export function ContactListField({
  id,
  label,
  kind,
  values,
  onChange,
  error,
}: {
  id: string;
  label: string;
  kind: 'phone' | 'email';
  values: string[];
  onChange: (values: string[]) => void;
  error?: string | undefined;
}): React.JSX.Element {
  const noun = kind === 'phone' ? 'phone' : 'email';
  const full = values.length >= MAX_ADDITIONAL_CONTACTS;

  return (
    <fieldset>
      <legend className="mb-1 block text-sm font-medium text-slate-700">{label}</legend>
      <div className="space-y-2">
        {values.map((value, index) => (
          <div key={index} className="flex gap-2">
            <input
              id={index === 0 ? id : `${id}-${index}`}
              aria-label={`${label} ${index + 1}`}
              type={kind === 'phone' ? 'tel' : 'email'}
              inputMode={kind === 'phone' ? 'tel' : 'email'}
              autoComplete="off"
              value={value}
              placeholder={kind === 'phone' ? 'e.g. 020-29512009' : 'e.g. accounts@example.com'}
              onChange={(e) => onChange(values.map((v, i) => (i === index ? e.target.value : v)))}
              className={inputClass}
            />
            <button
              type="button"
              aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
              className="min-h-11 shrink-0 rounded-lg border border-slate-300 px-3 text-sm text-slate-600 transition hover:bg-slate-50"
            >
              Remove
            </button>
          </div>
        ))}
        {!full && (
          <button
            type="button"
            onClick={() => onChange([...values, ''])}
            className="min-h-11 rounded-lg border border-dashed border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            + Add {noun}
          </button>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : (
        <p className="mt-1 text-xs text-slate-400">
          {full
            ? `Up to ${MAX_ADDITIONAL_CONTACTS} — remove one to add another.`
            : kind === 'phone'
              ? 'Office landline, second mobile… stored as E.164.'
              : 'Accounts, purchase, personal…'}
        </p>
      )}
    </fieldset>
  );
}
