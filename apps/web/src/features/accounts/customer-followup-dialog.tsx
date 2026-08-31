import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api-client';
import { useCreateAccountFollowUp } from './use-retention';

/**
 * Scheduling an action on the CUSTOMER, with no lead involved.
 *
 * "Call ABC Foods on Monday about a repeat order" is real work with no open
 * enquiry behind it. Before customer-level follow-ups the only way to record it
 * was to invent a lead — which put a fake enquiry in the pipeline and corrupted
 * every conversion figure that counted it.
 */
export function CustomerFollowUpDialog({
  accountId,
  accountName,
  onClose,
}: {
  accountId: string;
  accountName: string;
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateAccountFollowUp();

  const [scheduledAt, setScheduledAt] = useState(defaultWhen());
  const [type, setType] = useState('CALL');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setFailure(null);

    create.mutate(
      {
        accountId,
        scheduledAt: new Date(scheduledAt).toISOString(),
        type,
        ...(title ? { title } : {}),
        ...(notes ? { notes } : {}),
      },
      {
        onSuccess: () => onClose(),
        onError: (error) =>
          setFailure(
            error instanceof ApiError ? error.message : 'Could not schedule that follow-up.',
          ),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-900">Follow up with this customer</h2>
        <p className="mt-1 text-sm text-slate-500">
          An action on <strong className="font-medium text-slate-700">{accountName}</strong>, not on
          any one deal. No opportunity is created.
        </p>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">When</span>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
              required
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">How</span>
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="CALL">Call</option>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="EMAIL">Email</option>
              <option value="MEETING">Meeting</option>
              <option value="OTHER">Other</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">What about</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Next garlic powder requirement"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Notes</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>

          {failure && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {failure}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {create.isPending ? 'Scheduling…' : 'Schedule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function defaultWhen(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  date.setHours(10, 0, 0, 0);

  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
