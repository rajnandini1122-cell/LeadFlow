import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PendingInvitation } from '@leadflow/api-types';
import { ApiError, apiGet, apiPost, api } from '../../lib/api-client';
import { formatDate } from '../../lib/format';
import { Card, CardHeader, EmptyState, RoleBadge, SkeletonRows } from '../../components/ui';

export function PendingInvitations({ canManage }: { canManage: boolean }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: () => apiGet<PendingInvitation[]>('/users/invitations'),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['invitations'] });
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const resend = useMutation({
    mutationFn: (id: string) =>
      apiPost<{ inviteToken?: string }>(`/users/invitations/${id}/resend`, {}),
    onSuccess: (result) => {
      refresh();
      setError(null);
      // Resending rotates the token, so the previous link stops working. Say so
      // — otherwise an admin may keep chasing someone who has a dead link.
      setNotice(
        result.inviteToken
          ? `New link created. The previous link no longer works: ${window.location.origin}/invite/${result.inviteToken}`
          : 'A new invitation has been sent. The previous link no longer works.',
      );
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not resend the invitation.'),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/users/invitations/${id}`);
    },
    onSuccess: () => {
      refresh();
      setError(null);
      setNotice('Invitation revoked.');
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not revoke the invitation.'),
  });

  return (
    <Card>
      <CardHeader
        title="Pending invitations"
        subtitle="People who have been invited but have not joined yet"
      />

      {(notice || error) && (
        <div className="border-b border-slate-100 px-5 py-2.5">
          {notice && (
            <p role="status" aria-live="polite" className="text-xs break-all text-slate-600">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" aria-live="assertive" className="text-xs text-red-600">
              {error}
            </p>
          )}
        </div>
      )}

      {invitations.isPending ? (
        <SkeletonRows rows={2} />
      ) : invitations.isError ? (
        <EmptyState title="Could not load invitations" description="Please try again." />
      ) : invitations.data.length === 0 ? (
        <EmptyState
          icon="✉"
          title="No pending invitations"
          description="Invited people appear here until they accept."
        />
      ) : (
        <ul className="divide-y divide-slate-100">
          {invitations.data.map((invitation) => {
            const busy = resend.isPending || revoke.isPending;
            const expired =
              invitation.expiresAt !== null && new Date(invitation.expiresAt) < new Date();

            return (
              <li key={invitation.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {invitation.email}
                    </p>
                    <RoleBadge role={invitation.role} />
                    {expired && (
                      <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700">
                        Expired
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Invited {formatDate(invitation.createdAt)}
                    {invitation.invitedBy ? ` by ${invitation.invitedBy}` : ''}
                    {invitation.expiresAt && !expired
                      ? ` · expires ${formatDate(invitation.expiresAt)}`
                      : ''}
                  </p>
                </div>

                {canManage && (
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => resend.mutate(invitation.id)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      {expired ? 'Send new link' : 'Resend'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => revoke.mutate(invitation.id)}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
