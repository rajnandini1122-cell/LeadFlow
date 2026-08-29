import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { OrganizationSummary } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { useAuth } from './auth-context';
import { AuthLayout } from './auth-shell';
import { GoogleSignInButton } from './google-sign-in';

export function LoginPage(): React.JSX.Element {
  const { login, loginWithGoogle, registerWithGoogle, status, pendingOrganizations } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /*
   * Held only while a brand-new Google user names their organization.
   *
   * Google verified who they are, but not which company they are starting.
   * The token is kept in memory for that one extra call and never stored.
   */
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState('');

  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  const submit = async (event: FormEvent, organizationId?: string): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login(email, password, organizationId);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const onGoogleToken = async (idToken: string): Promise<void> => {
    setError(null);
    setSubmitting(true);

    try {
      const result = await loginWithGoogle(idToken);
      // No account yet: keep the token and ask for an organization name.
      if (result.needsOrganization) setGoogleToken(idToken);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Google sign-in failed. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const createFromGoogle = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!googleToken) return;

    setError(null);
    setSubmitting(true);

    try {
      await registerWithGoogle(googleToken, organizationName);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not create the organization.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title="LeadFlow" subtitle="No lead left behind.">
      <>
        {googleToken ? (
          <form onSubmit={(event) => void createFromGoogle(event)} className="space-y-4">
            <p className="text-sm text-pretty text-slate-600">
              You are signed in with Google. Name your organization to finish — you will be its
              owner and can invite your team next.
            </p>

            <Field
              id="organizationName"
              label="Organization name"
              type="text"
              value={organizationName}
              onChange={setOrganizationName}
              autoComplete="organization"
              required
            />

            {error && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || organizationName.trim().length < 2}
              className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create organization'}
            </button>

            <button
              type="button"
              onClick={() => {
                setGoogleToken(null);
                setError(null);
              }}
              className="w-full text-center text-xs text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </form>
        ) : pendingOrganizations ? (
            <OrganizationChooser
              organizations={pendingOrganizations}
              disabled={submitting}
              onChoose={(id, event) => void submit(event, id)}
            />
          ) : (
            <form onSubmit={(event) => void submit(event)} className="space-y-4">
              {/* Renders nothing unless the server says Google is configured. */}
              <GoogleSignInButton
                onToken={(token) => void onGoogleToken(token)}
                disabled={submitting}
              />

              <Field
                id="email"
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="username"
                required
              />
              <Field
                id="password"
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                required
              />

              <p className="-mt-2 text-right">
                <Link
                  to="/forgot-password"
                  className="text-xs text-slate-500 transition hover:text-slate-900 hover:underline"
                >
                  Forgot password?
                </Link>
              </p>

              {error && (
                <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
              <p className="text-center text-sm text-slate-500">

                New here?{' '}

                <Link to="/register" className="font-medium text-slate-900 hover:underline">

                  Create an organization

                </Link>

              </p>

          </form>
        )}
      </>
    </AuthLayout>
  );
}

/**
 * Shown when the account belongs to more than one organization.
 *
 * The server refuses to guess which tenant to enter, so the user picks and the
 * credentials are re-submitted with that choice. The server still verifies the
 * membership, so this list is a convenience, not an authorisation decision.
 */
function OrganizationChooser({
  organizations,
  disabled,
  onChoose,
}: {
  organizations: OrganizationSummary[];
  disabled: boolean;
  onChoose: (id: string, event: FormEvent) => void;
}): React.JSX.Element {
  return (
    <div>
      <h2 className="mb-1 text-sm font-medium text-slate-900">Choose an organization</h2>
      <p className="mb-4 text-sm text-slate-500">Your account has access to more than one.</p>

      <ul className="space-y-2">
        {organizations.map((organization) => (
          <li key={organization.id}>
            <form onSubmit={(event) => onChoose(organization.id, event)}>
              <button
                type="submit"
                disabled={disabled}
                className="w-full rounded-md border border-slate-200 px-4 py-3 text-left transition hover:border-slate-400 disabled:opacity-50"
              >
                <span className="block text-sm font-medium text-slate-900">
                  {organization.name}
                </span>
                <span className="block text-xs text-slate-500">{organization.role}</span>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  required,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  required?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
      />
    </div>
  );
}
