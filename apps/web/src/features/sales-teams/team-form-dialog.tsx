import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TeamAgentCandidate, TeamDetail } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';

/**
 * Create or rename a team.
 *
 * One dialog for both, because the fields are the same and two would drift.
 * Focus handling matches the invite dialog next door: remember the opener,
 * move focus in, trap Tab, restore on close — without it a keyboard user tabs
 * into the page behind the overlay.
 */
export function TeamFormDialog({
  open,
  team,
  agents,
  saving,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** Present when editing; absent when creating. */
  team?: TeamDetail | undefined;
  agents: TeamAgentCandidate[];
  saving: boolean;
  error: unknown;
  onSubmit: (values: { name: string; description: string; managerUserId: string }) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [managerUserId, setManagerUserId] = useState('');

  const dialog = useRef<HTMLDivElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);

  // Re-seeded whenever the dialog opens, so editing one team then another does
  // not show the first one's name.
  useEffect(() => {
    if (!open) return;
    setName(team?.name ?? '');
    setDescription(team?.description ?? '');
    setManagerUserId(team?.manager?.userId ?? '');
  }, [open, team]);

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
    onSubmit({ name, description, managerUserId });
  };

  // Only people who can actually hold the role: somebody suspended or removed
  // would be refused by the API, and offering them produces an error the
  // administrator cannot act on.
  const eligibleManagers = agents.filter((agent) => agent.status === 'ACTIVE');

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-form-title"
        className="mt-16 w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-lg"
      >
        <form onSubmit={submit}>
          <div className="border-b border-slate-100 px-5 py-3.5">
            <h2 id="team-form-title" className="text-sm font-semibold text-slate-900">
              {team ? 'Edit team' : 'New sales team'}
            </h2>
          </div>

          <div className="space-y-4 px-5 py-4">
            <div>
              <label htmlFor="team-name" className="mb-1 block text-xs font-medium text-slate-600">
                Name
              </label>
              <input
                id="team-name"
                ref={firstField}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={80}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
              />
              {fieldError('name') && (
                <p className="mt-1 text-xs text-red-600">{fieldError('name')}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="team-description"
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                Description <span className="text-slate-400">(optional)</span>
              </label>
              <textarea
                id="team-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                maxLength={500}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
              />
            </div>

            <div>
              <label
                htmlFor="team-manager"
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                Manager <span className="text-slate-400">(optional)</span>
              </label>
              <select
                id="team-manager"
                value={managerUserId}
                onChange={(event) => setManagerUserId(event.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
              >
                <option value="">No manager</option>
                {eligibleManagers.map((agent) => (
                  <option key={agent.userId} value={agent.userId}>
                    {agent.fullName} — {agent.role.replace('_', ' ').toLowerCase()}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-400">
                Responsibility for the team. It grants no extra permissions.
              </p>
              {fieldError('managerUserId') && (
                <p className="mt-1 text-xs text-red-600">{fieldError('managerUserId')}</p>
              )}
            </div>

            {message && !fieldError('name') && (
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
              {saving ? 'Saving…' : team ? 'Save changes' : 'Create team'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
