import { useEffect, useState } from 'react';
import type { UserListItem } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { formatCurrency, humanise } from '../../lib/format';
import { Dialog, Field, inputClass } from '../leads/lead-dialogs';
import { useOffboard, useWorkload, type OffboardResult } from './use-offboarding';

/**
 * Employee exit.
 *
 * The whole point of this dialog is that the consequences are visible BEFORE
 * the button is pressed. Removing someone who owns forty-two live customers is
 * a decision about those customers, not about a row in a table — so the counts
 * are loaded fresh when it opens, and the confirm button stays disabled until a
 * successor has been chosen for work that would otherwise be orphaned.
 */
export function OffboardMemberDialog({
  member,
  open,
  onClose,
  onDone,
}: {
  member: UserListItem | null;
  open: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}): React.JSX.Element | null {
  const workload = useWorkload(open && member ? member.id : undefined);
  const offboard = useOffboard(member?.id ?? '');

  const [action, setAction] = useState<'DEACTIVATE' | 'REMOVE'>('DEACTIVATE');
  const [reassignToId, setReassignToId] = useState('');
  const [includeHistorical, setIncludeHistorical] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // Reset between members, or the previous person's successor stays selected.
  useEffect(() => {
    setAction('DEACTIVATE');
    setReassignToId('');
    setIncludeHistorical(false);
    setConfirmed(false);
  }, [member?.id]);

  if (!open || !member) return null;

  const data = workload.data;
  const needsSuccessor = data?.requiresReassignment ?? false;
  const successorMissing = needsSuccessor && reassignToId === '';
  const noEligibleSuccessor = needsSuccessor && (data?.eligibleSuccessors.length ?? 0) === 0;

  const submit = (): void => {
    offboard.mutate(
      {
        action,
        ...(reassignToId ? { reassignToId } : {}),
        ...(includeHistorical ? { includeHistorical: true } : {}),
      },
      {
        onSuccess: (result: OffboardResult) => {
          onDone(summarise(member.fullName, result));
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={open} title={`Offboard ${member.fullName}`} onClose={onClose}>
      <div className="space-y-4 p-5">
        {workload.isPending ? (
          <p className="text-sm text-slate-500">Checking what they are working on…</p>
        ) : workload.isError ? (
          <p role="alert" className="text-sm text-red-600">
            Could not load their current workload. Nothing has been changed.
          </p>
        ) : (
          <>
            <div
              className={`rounded-lg p-3 text-sm ${
                needsSuccessor ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-700'
              }`}
            >
              {needsSuccessor ? (
                <p>
                  This member currently owns{' '}
                  <strong>
                    {data?.activeLeads} active {data?.activeLeads === 1 ? 'lead' : 'leads'}
                  </strong>{' '}
                  and has{' '}
                  <strong>
                    {data?.openFollowUps} open{' '}
                    {data?.openFollowUps === 1 ? 'follow-up' : 'follow-ups'}
                  </strong>
                  . Select a team member to take over before continuing.
                </p>
              ) : (
                <p>This member has no active leads and no open follow-ups.</p>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <Count label="Active leads" value={data?.activeLeads ?? 0} highlight />
              <Count label="Open follow-ups" value={data?.openFollowUps ?? 0} highlight />
              <Count label="Won" value={data?.wonLeads ?? 0} />
              <Count label="Lost" value={data?.lostLeads ?? 0} />
            </dl>

            {(data?.activeLeads ?? 0) > 0 && (
              <p className="text-xs text-slate-500">
                Pipeline at risk: {formatCurrency(data?.pipelineValue ?? '0')}
              </p>
            )}

            <Field label="What should happen to this member?" htmlFor="offboard-action">
              <select
                id="offboard-action"
                value={action}
                onChange={(event) =>
                  setAction(event.target.value as 'DEACTIVATE' | 'REMOVE')
                }
                className={inputClass}
              >
                <option value="DEACTIVATE">
                  Deactivate — keep them on the roster, revoke access
                </option>
                <option value="REMOVE">Remove — take them off the roster</option>
              </select>
            </Field>

            <Field
              label={needsSuccessor ? 'Who takes over their work?' : 'Hand work over to (optional)'}
              htmlFor="offboard-successor"
              required={needsSuccessor}
              hint={
                noEligibleSuccessor
                  ? 'There is no other active member to hand the work to. Invite or reactivate someone first.'
                  : 'Only active members of this organization can be chosen.'
              }
            >
              <select
                id="offboard-successor"
                value={reassignToId}
                onChange={(event) => setReassignToId(event.target.value)}
                className={inputClass}
                disabled={noEligibleSuccessor}
              >
                <option value="">
                  {needsSuccessor ? 'Select a team member…' : 'Nobody — they own nothing'}
                </option>
                {(data?.eligibleSuccessors ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.fullName} · {humanise(person.role)}
                  </option>
                ))}
              </select>
            </Field>

            {reassignToId !== '' && (data?.wonLeads ?? 0) + (data?.lostLeads ?? 0) > 0 && (
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={includeHistorical}
                  onChange={(event) => setIncludeHistorical(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  Also move their {(data?.wonLeads ?? 0) + (data?.lostLeads ?? 0)} closed deals
                  <span className="block text-xs text-slate-500">
                    Off by default. Who closed a deal is a fact about the past — moving it
                    changes commission and performance reports that have already been run.
                  </span>
                </span>
              </label>
            )}

            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-1"
              />
              <span>
                I understand {member.fullName} will be signed out immediately
                {reassignToId !== '' && ' and their open work will move to the person selected'}.
              </span>
            </label>

            {offboard.isError && (
              <p role="alert" className="text-xs text-red-600">
                {offboard.error instanceof ApiError
                  ? offboard.error.message
                  : 'That could not be completed.'}
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
          disabled={
            !confirmed ||
            successorMissing ||
            noEligibleSuccessor ||
            workload.isPending ||
            offboard.isPending
          }
          className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
        >
          {offboard.isPending
            ? 'Working…'
            : action === 'REMOVE'
              ? 'Reassign and remove'
              : 'Reassign and deactivate'}
        </button>
      </div>
    </Dialog>
  );
}

function Count({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-lg bg-slate-50 px-2.5 py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          highlight && value > 0 ? 'text-amber-700' : 'text-slate-900'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function summarise(name: string, result: OffboardResult): string {
  const verb = result.action === 'REMOVE' ? 'removed' : 'deactivated';
  const moved: string[] = [];

  if (result.leadsReassigned > 0) {
    moved.push(`${result.leadsReassigned} active ${result.leadsReassigned === 1 ? 'lead' : 'leads'}`);
  }
  if (result.historicalLeadsReassigned > 0) {
    moved.push(`${result.historicalLeadsReassigned} closed deals`);
  }
  if (result.followUpsReassigned > 0) {
    moved.push(
      `${result.followUpsReassigned} ${result.followUpsReassigned === 1 ? 'follow-up' : 'follow-ups'}`,
    );
  }

  return moved.length === 0
    ? `${name} has been ${verb}.`
    : `${name} has been ${verb}. Moved ${moved.join(', ')}.`;
}
