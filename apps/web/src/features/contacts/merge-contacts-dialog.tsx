import { useState } from 'react';
import { ApiError } from '../../lib/api-client';
import { Dialog } from '../leads/lead-dialogs';
import { useMergeContacts, type Contact, type FieldChoices } from './use-contacts';

const FIELDS: { key: keyof FieldChoices; label: string }[] = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'email', label: 'Email' },
  { key: 'companyName', label: 'Company' },
  { key: 'city', label: 'City' },
  { key: 'notes', label: 'Notes' },
];

/**
 * Explicit merge review.
 *
 * Nothing merges automatically and nothing is chosen by default beyond "keep
 * the surviving record's value" — every field where the two disagree is shown
 * side by side and the user picks. A silent default would discard whichever
 * value they actually wanted, with no way to tell afterwards.
 */
export function MergeContactsDialog({
  open,
  source,
  target,
  onClose,
  onMerged,
}: {
  open: boolean;
  source: Contact | null;
  target: Contact | null;
  onClose: () => void;
  onMerged?: (targetId: string) => void;
}): React.JSX.Element | null {
  const merge = useMergeContacts();
  const [choices, setChoices] = useState<FieldChoices>({});
  const [confirmed, setConfirmed] = useState(false);

  if (!open || !source || !target) return null;

  // Only fields where the two records actually disagree need a decision.
  const contested = FIELDS.filter(({ key }) => {
    const a = source[key as keyof Contact];
    const b = target[key as keyof Contact];
    return a && b && a !== b;
  });

  const submit = (): void => {
    merge.mutate(
      { sourceId: source.id, targetId: target.id, fieldChoices: choices },
      {
        onSuccess: (result) => {
          setChoices({});
          setConfirmed(false);
          onMerged?.(result.targetId);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={open} title="Merge contacts" onClose={onClose}>
      <div className="space-y-4 p-5">
        <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          <p className="font-medium">This cannot be undone.</p>
          <p className="mt-1">
            {source.leadCount} {source.leadCount === 1 ? 'lead moves' : 'leads move'} onto{' '}
            <strong>{target.name}</strong>. Nothing is deleted — {source.name} is kept as a
            record of the merge, and every activity and follow-up stays on its lead.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="font-semibold text-slate-500 uppercase">Merging away</p>
            <p className="mt-1 text-sm font-medium text-slate-900">{source.name}</p>
            <p className="text-slate-500">{source.mobile ?? '—'}</p>
            <p className="text-slate-500">{source.leadCount} leads</p>
          </div>
          <div className="rounded-lg border-2 border-slate-900 p-3">
            <p className="font-semibold text-slate-900 uppercase">Keeping</p>
            <p className="mt-1 text-sm font-medium text-slate-900">{target.name}</p>
            <p className="text-slate-500">{target.mobile ?? '—'}</p>
            <p className="text-slate-500">{target.leadCount} leads</p>
          </div>
        </div>

        {contested.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-slate-700">
              These fields differ. Choose which value to keep:
            </p>
            <div className="space-y-2">
              {contested.map(({ key, label }) => (
                <fieldset key={key} className="rounded-lg border border-slate-200 p-2.5">
                  <legend className="px-1 text-[11px] font-medium text-slate-500">{label}</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {(['source', 'target'] as const).map((side) => {
                      const record = side === 'source' ? source : target;
                      const selected = (choices[key] ?? 'target') === side;

                      return (
                        <label
                          key={side}
                          className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs transition ${
                            selected
                              ? 'border-slate-900 bg-slate-900 text-white'
                              : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          <input
                            type="radio"
                            name={`merge-${key}`}
                            className="sr-only"
                            checked={selected}
                            onChange={() => setChoices((prev) => ({ ...prev, [key]: side }))}
                          />
                          {String(record[key as keyof Contact] ?? '—')}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
          </div>
        )}

        <label className="flex items-start gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            I have checked these are the same person and want to merge them permanently.
          </span>
        </label>

        {merge.isError && (
          <p role="alert" className="text-xs text-red-600">
            {merge.error instanceof ApiError ? merge.error.message : 'Could not merge.'}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!confirmed || merge.isPending}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          {merge.isPending ? 'Merging…' : 'Merge contacts'}
        </button>
      </div>
    </Dialog>
  );
}
