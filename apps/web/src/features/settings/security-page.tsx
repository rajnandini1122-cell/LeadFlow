import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, apiGet, apiPost } from '../../lib/api-client';
import { formatDateTime, formatRelative } from '../../lib/format';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
} from '../../components/ui';

const MIN_PASSWORD_LENGTH = 12;

interface ActiveSession {
  id: string;
  platform: string;
  deviceName: string | null;
  ipAddress: string | null;
  organization: { id: string; name: string } | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export function SecurityPage(): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Security"
        subtitle="Your password and the devices where you are signed in"
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <ChangePasswordCard />
        <ActiveSessionsCard />
      </div>
    </>
  );
}

function ChangePasswordCard(): React.JSX.Element {
  const queryClient = useQueryClient();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () => apiPost('/auth/change-password', { currentPassword, newPassword }),
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setFieldErrors({});
      setDone(true);
      // Other sessions were just revoked, so the list is stale.
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setTimeout(() => setDone(false), 4000);
    },
    onError: (caught) => {
      if (caught instanceof ApiError && caught.status === 401) {
        setFieldErrors({ currentPassword: 'That is not your current password.' });
      }
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    const next: Record<string, string> = {};
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      next['newPassword'] = `Must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (confirm !== newPassword) next['confirm'] = 'Passwords do not match.';
    if (newPassword && newPassword === currentPassword) {
      next['newPassword'] = 'Choose a password different from your current one.';
    }

    setFieldErrors(next);
    if (Object.keys(next).length === 0) change.mutate();
  };

  const generalError =
    change.error instanceof ApiError && change.error.status !== 401
      ? change.error.message
      : null;

  return (
    <Card>
      <CardHeader title="Change password" subtitle="You will stay signed in on this device" />

      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <Field
          id="currentPassword"
          label="Current password"
          value={currentPassword}
          onChange={setCurrentPassword}
          autoComplete="current-password"
          error={fieldErrors['currentPassword']}
        />
        <Field
          id="newPassword"
          label="New password"
          value={newPassword}
          onChange={setNewPassword}
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={fieldErrors['newPassword']}
        />
        <Field
          id="confirmPassword"
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          error={fieldErrors['confirm']}
        />

        {generalError && (
          <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {generalError}
          </p>
        )}

        {done && (
          <p role="status" aria-live="polite" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Password updated. Other devices have been signed out.
          </p>
        )}

        <button
          type="submit"
          disabled={change.isPending}
          aria-busy={change.isPending}
          className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-50"
        >
          {change.isPending ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </Card>
  );
}

function ActiveSessionsCard(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => apiGet<ActiveSession[]>('/auth/sessions'),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/auth/sessions/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setNotice('That device has been signed out.');
      setTimeout(() => setNotice(null), 4000);
    },
  });

  return (
    <Card>
      <CardHeader
        title="Active sessions"
        subtitle="Everywhere you are currently signed in"
      />

      {notice && (
        <p
          role="status"
          aria-live="polite"
          className="border-b border-slate-100 px-5 py-2.5 text-sm text-emerald-700"
        >
          {notice}
        </p>
      )}

      {sessions.isPending ? (
        <SkeletonRows rows={3} />
      ) : sessions.isError ? (
        <ErrorNotice message="Could not load your sessions." />
      ) : sessions.data.length === 0 ? (
        <EmptyState title="No active sessions" description="Nothing to show." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {sessions.data.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-slate-900">
                    {session.deviceName ?? platformLabel(session.platform)}
                  </p>
                  {session.current && (
                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
                      This device
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {session.organization ? `${session.organization.name} · ` : ''}
                  Signed in {formatRelative(session.createdAt)}
                  {session.ipAddress ? ` · ${session.ipAddress}` : ''}
                </p>
                <p className="text-[11px] text-slate-400">
                  Expires {formatDateTime(session.expiresAt)}
                </p>
              </div>

              {/* No control for the current session: signing yourself out from
                  here is what the Sign out button already does, and offering it
                  twice invites an accidental self-logout. */}
              {!session.current && (
                <button
                  type="button"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(session.id)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                >
                  {revoke.isPending ? 'Signing out…' : 'Sign out'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function platformLabel(platform: string): string {
  if (platform === 'WEB') return 'Web browser';
  if (platform === 'ANDROID') return 'Android app';
  if (platform === 'IOS') return 'iOS app';
  return platform;
}

function Field({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  hint?: string;
  error?: string | undefined;
}): React.JSX.Element {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type="password"
        value={value}
        required
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900 aria-[invalid]:border-red-400"
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
