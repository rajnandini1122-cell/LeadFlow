import { useState, type KeyboardEvent } from 'react';

/**
 * Editor for the per-tenant lead source list.
 *
 * "Where did this enquiry come from" is a question every business answers
 * differently, so a fixed list makes the field useless for anyone it does not
 * fit. This is the list the New lead dialog offers.
 */
export function LeadSourceEditor({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = (): void => {
    const entry = draft.trim();
    if (entry === '') return;

    // Case-insensitive, so "Referral" and "referral" cannot both sit in the
    // dropdown looking like two different answers.
    if (value.some((existing) => existing.toLowerCase() === entry.toLowerCase())) {
      setError(`“${entry}” is already in the list.`);
      return;
    }
    if (value.length >= 50) {
      setError('That is the maximum of 50 sources.');
      return;
    }

    onChange([...value, entry]);
    setDraft('');
    setError(null);
  };

  const remove = (entry: string): void => {
    onChange(value.filter((existing) => existing !== entry));
    setError(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Enter adds rather than submitting the surrounding form, which would save
    // the whole page mid-edit.
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  };

  return (
    <div>
      {value.length === 0 ? (
        <p className="mb-3 text-sm text-slate-500">
          No sources yet. Until you add some, the lead form offers a neutral default list.
        </p>
      ) : (
        <ul className="mb-3 flex flex-wrap gap-1.5">
          {value.map((entry) => (
            <li
              key={entry}
              className="flex items-center gap-1.5 rounded-full bg-slate-100 py-1 pr-1 pl-3 text-sm text-slate-700"
            >
              {entry}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(entry)}
                  aria-label={`Remove ${entry}`}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!disabled && (
        <>
          <div className="flex gap-2">
            <label htmlFor="new-source" className="sr-only">
              Add a lead source
            </label>
            <input
              id="new-source"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              onKeyDown={onKeyDown}
              maxLength={60}
              placeholder="e.g. Referral, Trade show, Website"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
            />
            <button
              type="button"
              onClick={add}
              disabled={draft.trim() === ''}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Add
            </button>
          </div>

          {error && (
            <p role="alert" className="mt-1.5 text-xs text-red-600">
              {error}
            </p>
          )}
          <p className="mt-1.5 text-xs text-slate-400">
            Changes take effect after you save. Existing leads keep the source they were
            created with.
          </p>
        </>
      )}
    </div>
  );
}
