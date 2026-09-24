import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { OrganizationSummary } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { useAuth } from './auth-context';
import { AuthLayout } from './auth-shell';

export function LoginPage(): React.JSX.Element {
  const { login, status, pendingOrganizations } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  /**
   * Signs in, optionally naming which organization to enter.
   *
   * Shared by the credentials form and the chooser. There is no separate
   * "select organization" endpoint by design: the choice is a second login
   * carrying the selection, which the server re-verifies against live
   * membership. So one network call, `POST /auth/login`, is the expected
   * traffic for both — not evidence of a resubmitted form.
   */
  const signIn = async (organizationId?: string): Promise<void> => {
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

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    await signIn();
  };

  return (
    <AuthLayout title="LeadFlow" subtitle="No lead left behind.">
      <>
        {/*
          * The error sits ABOVE the branch, not inside the credentials form.
          *
          * It used to live in the form, which is not rendered while the chooser
          * is showing — so a refused organization choice displayed nothing at
          * all. The click appeared to do nothing, which is indistinguishable
          * from the bug this screen was just fixed for, and would have hidden
          * a 403 completely.
          */}
        {error && (
          <p
            role="alert"
            className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        {pendingOrganizations ? (
          <OrganizationChooser
            organizations={pendingOrganizations}
            disabled={submitting}
            onChoose={(id) => void signIn(id)}
          />
        ) : (
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
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
  onChoose: (id: string) => void;
}): React.JSX.Element {
  return (
    <div>
      <h2 className="mb-1 text-sm font-medium text-slate-900">Choose an organization</h2>
      <p className="mb-4 text-sm text-slate-500">Your account has access to more than one.</p>

      <ul className="space-y-2">
        {organizations.map((organization) => (
          <li key={organization.id}>
            {/*
              * A plain button with an explicit type, and NO form around it.
              *
              * Each card used to be its own single-button <form>, which worked
              * but meant a click travelled through a submit event to get to a
              * function it could have called directly. `type="button"` is
              * stated rather than relied upon: a button inside a form defaults
              * to `type="submit"`, so if this list is ever moved inside the
              * credentials form, the default would silently re-submit the login
              * rather than choose an organization.
              */}
            <button
              type="button"
              onClick={() => onChoose(organization.id)}
              disabled={disabled}
              className="w-full rounded-md border border-slate-200 px-4 py-3 text-left transition hover:border-slate-400 disabled:opacity-50"
            >
              <span className="block text-sm font-medium text-slate-900">{organization.name}</span>
              <span className="block text-xs text-slate-500">{organization.role}</span>
            </button>
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
