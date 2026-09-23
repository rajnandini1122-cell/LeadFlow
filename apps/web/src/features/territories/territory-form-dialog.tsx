import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TerritoryListItem } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';

export interface TerritoryFormValues {
  name: string;
  description: string;
}

/**
 * Create or rename one territory.
 *
 * Name and description only. Coverage is edited on the territory itself, where
 * an administrator can see what is already claimed — adding places from a
 * create dialog would mean choosing them before knowing which are free.
 */
export function TerritoryFormDialog({
  open,
  territory,
  saving,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  territory?: TerritoryListItem | undefined;
  saving: boolean;
  error: unknown;
  onSubmit: (values: TerritoryFormValues) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const [values, setValues] = useState<TerritoryFormValues>(EMPTY);

  const dialog = useRef<HTMLDivElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;

    setValues(
      territory
        ? { name: territory.name, description: territory.description ?? '' }
        : EMPTY,
    );
  }, [open, territory]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    firstField.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialog.current?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href]',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;

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

  const fieldError = (field: string): string | undefined =>
    error instanceof ApiError ? error.details?.[field]?.[0] : undefined;
  const message = error instanceof ApiError ? error.message : null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit(values);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="territory-form-title"
        className="mt-12 w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-lg"
      >
        <form onSubmit={submit}>
          <div className="border-b border-slate-100 px-5 py-3.5">
            <h2 id="territory-form-title" className="text-sm font-semibold text-slate-900">
              {territory ? 'Edit territory' : 'New territory'}
            </h2>
          </div>

          <div className="space-y-4 px-5 py-4">
            <div>
              <label
                htmlFor="territory-name"
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                Name
              </label>
              <input
                id="territory-name"
                ref={firstField}
                value={values.name}
                onChange={(event) =>
                  setValues((current) => ({ ...current, name: event.target.value }))
                }
                required
                maxLength={80}
                placeholder="Pune / PCMC"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
              />
              {fieldError('name') && (
                <p className="mt-1 text-xs text-red-600">{fieldError('name')}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="territory-description"
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                Description <span className="text-slate-400">(optional)</span>
              </label>
              <textarea
                id="territory-description"
                value={values.description}
                onChange={(event) =>
                  setValues((current) => ({ ...current, description: event.target.value }))
                }
                rows={2}
                maxLength={500}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
              />
            </div>

            {message && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {message}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? 'Saving…' : territory ? 'Save changes' : 'Create territory'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const EMPTY: TerritoryFormValues = { name: '', description: '' };
