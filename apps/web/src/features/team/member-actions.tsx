import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ROLE_KEYS, type RoleKey, type UserListItem } from '@leadflow/api-types';
import { ApiError, api, apiPatch } from '../../lib/api-client';
import { humanise } from '../../lib/format';
import { useAuth } from '../auth/auth-context';

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
}: {
  member: UserListItem;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}): React.JSX.Element | null {
  const { user, can } = useAuth();
  const queryClient = useQueryClient();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

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

  const remove = useMutation({
    mutationFn: async () => {
      await api.delete(`/users/${member.id}`);
    },
    onSuccess: () => {
      refresh();
      setConfirmingRemove(false);
      onSuccess(`${member.fullName} has been removed from the organization.`);
    },
    onError: (caught) => {
      setConfirmingRemove(false);
      fail(caught);
    },
  });

  const isSelf = member.id === user?.id;
  const canManageRoles = can('role.assign');
  const canSuspend = can('user.suspend');
  const canRemove = can('user.remove');

  // Only an owner may act on another owner, and nobody edits themselves here —
  // self-service is "leave organization", which confirms separately.
  const targetIsOwner = member.role === 'OWNER';
  const mayActOnTarget = !targetIsOwner || user?.role === 'OWNER';
  const busy = update.isPending || remove.isPending;

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

      {canSuspend &&
        (member.status === 'SUSPENDED' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => update.mutate({ status: 'ACTIVE' })}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Reactivate
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => update.mutate({ status: 'SUSPENDED' })}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-amber-700 transition hover:bg-amber-50 disabled:opacity-50"
          >
            Suspend
          </button>
        ))}

      {canRemove &&
        (confirmingRemove ? (
          <span className="flex items-center gap-1.5">
            <span className="text-xs text-slate-600">Remove?</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => remove.mutate()}
              className="rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {remove.isPending ? 'Removing…' : 'Yes, remove'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRemove(false)}
              className="rounded-lg px-2 py-1.5 text-xs text-slate-600 transition hover:bg-slate-100"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingRemove(true)}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50"
          >
            Remove
          </button>
        ))}
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
export function LeaveOrganizationButton(): React.JSX.Element {
  const { user, logout } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leave = useMutation({
    mutationFn: async () => {
      await api.post('/organizations/leave');
    },
    onSuccess: () => {
      // The session is already revoked server-side; clear local state too.
      void logout();
    },
    onError: (caught) => {
      setConfirming(false);
      setError(
        caught instanceof ApiError ? caught.message : 'You could not leave this organization.',
      );
    },
  });

  return (
    <div>
      {error && (
        <p role="alert" aria-live="assertive" className="mb-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-slate-700">
            Leave {user?.organization.name}? You will lose access immediately.
          </p>
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
