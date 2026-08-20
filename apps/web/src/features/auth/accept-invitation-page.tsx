import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { InvitationPreview } from '@leadflow/api-types';
import { ApiError, apiGet, apiPost } from '../../lib/api-client';
import { humanise } from '../../lib/format';
import { AuthField, AuthLayout, SubmitButton } from './auth-shell';

/**
 * Public invitation acceptance.
 *
 * Two shapes behind one URL: a brand new person sets a name and password, while
 * someone who already has an account just confirms. Asking an existing user to
 * "choose a password" would either be ignored or, worse, imply their existing
 * one is being reset by whoever forwarded the link.
 */
export function AcceptInvitationPage(): React.JSX.Element {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => apiGet<InvitationPreview>(`/invitations/${token as string}`),
    enabled: Boolean(token),
    retry: false,
  });

  if (invitation.isPending) {
    return (
      <AuthLayout title="Checking your invitation…">
        <p className="text-center text-sm text-slate-500" aria-live="polite">
          One moment.
        </p>
      </AuthLayout>
    );
  }

  if (invitation.isError) {
    const message =
      invitation.error instanceof ApiError
        ? invitation.error.message
        : 'This invitation link could not be checked.';

    return (
      <AuthLayout title="Invitation unavailable">
        <p role="alert" className="text-sm text-slate-600">
          {message}
        </p>
        <Link
          to="/login"
          className="mt-4 block rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white transition hover:bg-slate-800"
        >
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }

  if (accepted) {
    return (
      <AuthLayout title="You're in" subtitle={`Welcome to ${invitation.data.organizationName}.`}>
        <p role="status" aria-live="polite" className="text-sm text-slate-600">
          Your account is ready. Sign in to get started.
        </p>
        <Link
          to="/login"
          className="mt-4 block rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white transition hover:bg-slate-800"
        >
          Sign in
        </Link>
      </AuthLayout>
    );
  }

  const preview = invitation.data;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      await apiPost(`/invitations/${token as string}/accept`, {
        ...(preview.hasAccount ? {} : { firstName, lastName, password }),
      });
      setAccepted(true);
      // Straight to sign-in: acceptance deliberately does not mint a session,
      // so the new password gets exercised once immediately.
      setTimeout(() => void navigate('/login'), 2500);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFieldErrors(caught.details ?? {});
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title={`Join ${preview.organizationName}`}
      subtitle={`You have been invited as ${humanise(preview.role)}.`}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <div className="rounded-lg bg-slate-50 px-3 py-2.5">
          <p className="text-xs text-slate-500">Invitation for</p>
          <p className="text-sm font-medium text-slate-900">{preview.email}</p>
        </div>

        {preview.hasAccount ? (
          <p className="text-sm text-slate-600">
            You already have an account. Accepting adds{' '}
            <strong className="font-medium text-slate-900">{preview.organizationName}</strong> to
            it — your existing password and other organizations are unchanged.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <AuthField
                id="firstName"
                label="First name"
                value={firstName}
                onChange={setFirstName}
                autoComplete="given-name"
                required
                error={fieldErrors['firstName']?.[0]}
              />
              <AuthField
                id="lastName"
                label="Last name"
                value={lastName}
                onChange={setLastName}
                autoComplete="family-name"
                required
                error={fieldErrors['lastName']?.[0]}
              />
            </div>

            <AuthField
              id="password"
              label="Choose a password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              required
              hint="At least 12 characters."
              error={fieldErrors['password']?.[0]}
            />
          </>
        )}

        {error && (
          <p
            role="alert"
            aria-live="assertive"
            className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        <SubmitButton
          submitting={submitting}
          label={preview.hasAccount ? 'Accept invitation' : 'Create account'}
          busyLabel="Joining…"
        />
      </form>
    </AuthLayout>
  );
}
