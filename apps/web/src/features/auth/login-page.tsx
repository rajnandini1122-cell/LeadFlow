import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import type { OrganizationSummary } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { useAuth } from './auth-context';

export function LoginPage(): React.JSX.Element {
  const { login, status, pendingOrganizations } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') return <Navigate to="/" replace />;

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

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">LeadFlow</h1>
          <p className="mt-1 text-sm text-slate-500">No lead left behind.</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {pendingOrganizations ? (
            <OrganizationChooser
              organizations={pendingOrganizations}
              disabled={submitting}
              onChoose={(id, event) => void submit(event, id)}
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
            </form>
          )}
        </div>
      </div>
    </div>
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
