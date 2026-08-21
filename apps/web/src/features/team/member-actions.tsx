import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ROLE_KEYS, type RoleKey, type UserListItem } from '@leadflow/api-types';
import { ApiError, apiPatch } from '../../lib/api-client';
import { humanise } from '../../lib/format';
import { useAuth } from '../auth/auth-context';
import { useLeaveOrganization } from './use-offboarding';

/**
 * Per-member actions: change role, suspend, reactivate, remove.
 *
 * Every rule here is also enforced by the API — this only avoids offering
 * actions that would certainly fail. UI restrictions are convenience, never the
 * security boundary.
 */
export function MemberActions({
  member,
  onError,
  onSuccess,
  onOffboard,
}: {
  member: UserListItem;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
  /** Opens the offboarding dialog, which discloses the member's workload. */
  onOffboard: (member: UserListItem) => void;
}): React.JSX.Element | null {
  const { user, can } = useAuth();
  const queryClient = useQueryClient();

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    void queryClient.invalidateQueries({ queryKey: ['my-organizations'] });
  };

  const fail = (caught: unknown): void =>
    onError(caught instanceof ApiError ? caught.message : 'That action could not be completed.');

  const update = useMutation({
    mutationFn: (changes: { role?: RoleKey; status?: 'ACTIVE' | 'SUSPENDED' }) =>
      apiPatch<UserListItem>(`/users/${member.id}`, changes),
    onSuccess: (_result, changes) => {
      refresh();
      onSuccess(
        changes.status === 'SUSPENDED'
          ? `${member.fullName} has been suspended and signed out.`
          : changes.status === 'ACTIVE'
            ? `${member.fullName} has been reactivated.`
            : `${member.fullName} is now ${humanise(changes.role ?? '')}.`,
      );
    },
    onError: fail,
  });

  const isSelf = member.id === user?.id;
  const canManageRoles = can('role.assign');
  const canSuspend = can('user.suspend');
  const canRemove = can('user.remove');

  // Only an owner may act on another owner, and nobody edits themselves here —
  // self-service is "leave organization", which confirms separately.
  const targetIsOwner = member.role === 'OWNER';
  const mayActOnTarget = !targetIsOwner || user?.role === 'OWNER';
  const busy = update.isPending;

  if (isSelf || !mayActOnTarget || (!canManageRoles && !canSuspend && !canRemove)) {
    return null;
  }

  // Owner is offered only to an owner — matching the API rule exactly.
  const assignableRoles = ROLE_KEYS.filter((key) => key !== 'OWNER' || user?.role === 'OWNER');

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canManageRoles && (
        <>
          <label htmlFor={`role-${member.id}`} className="sr-only">
            Role for {member.fullName}
          </label>
          <select
            id={`role-${member.id}`}
            value={member.role}
            disabled={busy}
            onChange={(event) => update.mutate({ role: event.target.value as RoleKey })}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs outline-none focus:border-slate-900 disabled:opacity-50"
          >
            {assignableRoles.map((key) => (
              <option key={key} value={key}>
                {humanise(key)}
              </option>
            ))}
          </select>
        </>
      )}

      {canSuspend && member.status === 'SUSPENDED' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => update.mutate({ status: 'ACTIVE' })}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          Reactivate
        </button>
      )}

      {/*
        One button for both deactivation and removal.
        Suspending someone is an exit in everything but name — they can no
        longer sign in, so their live customers would be orphaned exactly as
        they would be by removal. Both therefore go through the same dialog,
        which shows what they are carrying before anything happens.
      */}
      {(canRemove || canSuspend) && member.status !== 'SUSPENDED' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onOffboard(member)}
          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50"
        >
          Offboard…
        </button>
      )}
    </div>
  );
}

/**
 * Leave organization.
 *
 * Confirmation is required and deliberately explicit: the consequence is
 * immediate loss of access, and the API refuses it outright for the last
 * remaining owner.
 */
export function LeaveOrganizationButton({
  colleagues = [],
}: {
  /** Active colleagues who could take the caller's work over. */
  colleagues?: { id: string; fullName: string }[];
}): React.JSX.Element {
  const { user, logout } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reassignToId, setReassignToId] = useState('');

  const leaveMutation = useLeaveOrganization();

  const leave = {
    isPending: leaveMutation.isPending,
    mutate: () =>
      leaveMutation.mutate(reassignToId ? { reassignToId } : {}, {
        onSuccess: () => {
          // The session is already revoked server-side; clear local state too.
          void logout();
        },
        onError: (caught: unknown) => {
          setConfirming(false);
          setError(
            caught instanceof ApiError
              ? caught.message
              : 'You could not leave this organization.',
          );
        },
      }),
  };

  return (
    <div>
      {error && (
        <p role="alert" aria-live="assertive" className="mb-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {confirming ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">
            Leave {user?.organization.name}? You will lose access immediately.
          </p>

          {colleagues.length > 0 && (
            <div>
              <label
                htmlFor="leave-successor"
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                Hand your open work to
              </label>
              <select
                id="leave-successor"
                value={reassignToId}
                onChange={(event) => setReassignToId(event.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-slate-900"
              >
                <option value="">Nobody — I own nothing</option>
                {colleagues.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.fullName}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-400">
                Required if you still own active leads or open follow-ups.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={leave.isPending}
            onClick={() => leave.mutate()}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
          >
            {leave.isPending ? 'Leaving…' : 'Yes, leave'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-100"
          >
            Cancel
          </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-50"
        >
          Leave organization
        </button>
      )}
    </div>
  );
}
