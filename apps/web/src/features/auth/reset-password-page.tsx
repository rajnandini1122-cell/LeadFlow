import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, apiPost } from '../../lib/api-client';
import { AuthField, AuthLayout, SubmitButton } from './auth-shell';

const MIN_PASSWORD_LENGTH = 12;

/**
 * Set a new password from an emailed link.
 *
 * The three failure modes the API distinguishes are surfaced distinctly,
 * because they need different actions from the user:
 *
 *   404 — the link is unknown or already used: request a new one
 *   410 — the link expired: request a new one
 *   400 — the password itself was rejected: fix it and retry here
 *
 * Collapsing all of these into "something went wrong" would leave someone
 * retyping a password that was never the problem.
 */
export function ResetPasswordPage(): React.JSX.Element {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [linkDead, setLinkDead] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const next: Record<string, string> = {};

    if (password.length < MIN_PASSWORD_LENGTH) {
      next['password'] = `Must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    // Checked client-side only. The API has no idea what the user meant to
    // type, so confirmation is inherently a UI concern.
    if (confirm !== password) {
      next['confirm'] = 'Passwords do not match.';
    }

    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      await apiPost(`/auth/reset-password/${token as string}`, { password });
      setDone(true);
      // The reset revoked every session, so signing in is the next step.
      setTimeout(() => void navigate('/login'), 2500);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 404 || caught.status === 410) {
          setLinkDead(caught.message);
        } else if (caught.details?.['password']?.[0]) {
          setFieldErrors({ password: caught.details['password'][0] as string });
        } else {
          setError(caught.message);
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (linkDead) {
    return (
      <AuthLayout title="This link is no longer valid">
        <p role="alert" className="text-sm text-slate-600">
          {linkDead}
        </p>
        <Link
          to="/forgot-password"
          className="mt-4 block rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white transition hover:bg-slate-800"
        >
          Request a new link
        </Link>
        <Link
          to="/login"
          className="mt-2 block px-4 py-2 text-center text-sm text-slate-500 transition hover:text-slate-900"
        >
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title="Password updated">
        <p role="status" aria-live="polite" className="text-sm text-slate-600">
          You have been signed out everywhere else for security. Sign in with your new
          password.
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

  return (
    <AuthLayout title="Choose a new password" subtitle="This link can be used once.">
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <AuthField
          id="password"
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={fieldErrors['password']}
        />

        <AuthField
          id="confirm"
          label="Confirm new password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          required
          error={fieldErrors['confirm']}
        />

        {error && (
          <p
            role="alert"
            aria-live="assertive"
            className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        <SubmitButton submitting={submitting} label="Update password" busyLabel="Updating…" />
      </form>
    </AuthLayout>
  );
}
