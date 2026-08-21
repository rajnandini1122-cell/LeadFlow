import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, apiPost } from '../../lib/api-client';
import { AuthField, AuthLayout, SubmitButton } from './auth-shell';

interface ForgotPasswordResult {
  message: string;
  /** Development only — the API withholds this in production. */
  resetToken?: string;
}

/**
 * Forgot password.
 *
 * The success state is shown for ANY accepted submission, including addresses
 * with no account. The API is careful not to reveal which is which, and the UI
 * must not undo that by saying "no account found" — that would hand back the
 * enumeration oracle the API deliberately avoids.
 */
export function ForgotPasswordPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setFieldError(undefined);
    setSubmitting(true);

    try {
      const result = await apiPost<ForgotPasswordResult>('/auth/forgot-password', { email });
      setSent(true);

      // Outside production the API returns the token so the flow is testable
      // without a mail provider. Showing it here is what makes local
      // development work end to end.
      if (result.resetToken) {
        setDevLink(`${window.location.origin}/reset-password/${result.resetToken}`);
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFieldError(caught.details?.['email']?.[0]);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout title="Check your email">
        <p role="status" aria-live="polite" className="text-sm text-slate-600">
          If an account exists for <strong className="font-medium text-slate-900">{email}</strong>,
          we have sent a link to reset the password. It expires in 60 minutes.
        </p>

        {devLink && (
          <div className="mt-4 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-3">
            <p className="text-xs font-medium text-amber-900">
              Development only — no email was actually sent
            </p>
            <a
              href={devLink}
              className="mt-1 block font-mono text-xs break-all text-amber-800 underline"
            >
              {devLink}
            </a>
          </div>
        )}

        <div className="mt-6 space-y-2">
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setDevLink(null);
            }}
            className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Use a different email
          </button>
          <Link
            to="/login"
            className="block rounded-lg px-4 py-2 text-center text-sm text-slate-500 transition hover:text-slate-900"
          >
            Back to sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We will email you a link to choose a new one."
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <AuthField
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
          error={fieldError}
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

        <SubmitButton submitting={submitting} label="Send reset link" busyLabel="Sending…" />

        <p className="text-center text-sm text-slate-500">
          <Link to="/login" className="font-medium text-slate-900 hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
