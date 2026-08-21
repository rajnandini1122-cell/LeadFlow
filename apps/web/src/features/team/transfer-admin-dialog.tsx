import { useEffect, useState } from 'react';
import type { UserListItem } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { humanise } from '../../lib/format';
import { Dialog, Field, inputClass } from '../leads/lead-dialogs';
import { useTransferAdmin } from './use-offboarding';

/**
 * Hands admin responsibility to a colleague.
 *
 * This exists as its own action because an owner cannot change their own role —
 * a rule that stops an accidental self-demotion, but which also leaves a
 * departing owner with no way to name a successor. Without this, the only exit
 * from being the last owner is a support ticket.
 */
export function TransferAdminDialog({
  open,
  members,
  currentUserId,
  onClose,
  onDone,
}: {
  open: boolean;
  members: UserListItem[];
  currentUserId: string | undefined;
  onClose: () => void;
  onDone: (message: string) => void;
}): React.JSX.Element | null {
  const transfer = useTransferAdmin();
  const [toUserId, setToUserId] = useState('');
  const [stepDown, setStepDown] = useState(true);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (open) {
      setToUserId('');
      setStepDown(true);
      setConfirmed(false);
    }
  }, [open]);

  if (!open) return null;

  // Only active colleagues. Handing the organization to someone who cannot
  // sign in is the same as handing it to nobody.
  const candidates = members.filter(
    (member) => member.status === 'ACTIVE' && member.id !== currentUserId,
  );

  const submit = (): void => {
    transfer.mutate(
      { toUserId, stepDown },
      {
        onSuccess: () => {
          const name = candidates.find((m) => m.id === toUserId)?.fullName ?? 'That member';
          onDone(
            stepDown
              ? `${name} is now the owner. You are now an administrator.`
              : `${name} is now an owner alongside you.`,
          );
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={open} title="Transfer admin responsibility" onClose={onClose}>
      <div className="space-y-4 p-5">
        {candidates.length === 0 ? (
          <p className="text-sm text-slate-600">
            There is no other active member to transfer to. Invite someone, or reactivate a
            suspended member first.
          </p>
        ) : (
          <>
            <Field
              label="Who takes over as owner?"
              htmlFor="transfer-target"
              required
              hint="Only active members of this organization can be chosen."
            >
              <select
                id="transfer-target"
                value={toUserId}
                onChange={(event) => setToUserId(event.target.value)}
                className={inputClass}
              >
                <option value="">Select a team member…</option>
                {candidates.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.fullName} · {humanise(member.role)}
                  </option>
                ))}
              </select>
            </Field>

            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium text-slate-700">
                And what about you?
              </legend>

              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="step-down"
                  checked={stepDown}
                  onChange={() => setStepDown(true)}
                  className="mt-1"
                />
                <span>
                  Step down to administrator
                  <span className="block text-xs text-slate-500">
                    You keep day-to-day access — inviting, removing, configuring — and give up
                    ownership. You will no longer be able to appoint owners.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="step-down"
                  checked={!stepDown}
                  onChange={() => setStepDown(false)}
                  className="mt-1"
                />
                <span>
                  Stay an owner
                  <span className="block text-xs text-slate-500">
                    Adds a second owner rather than handing over. Safer if you are sharing
                    responsibility rather than leaving.
                  </span>
                </span>
              </label>
            </fieldset>

            {stepDown && (
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  I understand I will no longer be an owner of this organization, and cannot
                  undo this myself.
                </span>
              </label>
            )}

            {transfer.isError && (
              <p role="alert" className="text-xs text-red-600">
                {transfer.error instanceof ApiError
                  ? transfer.error.message
                  : 'The transfer could not be completed.'}
              </p>
            )}
          </>
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
          disabled={toUserId === '' || (stepDown && !confirmed) || transfer.isPending}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          {transfer.isPending ? 'Transferring…' : 'Transfer'}
        </button>
      </div>
    </Dialog>
  );
}
