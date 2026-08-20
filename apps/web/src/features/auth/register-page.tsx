import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ApiError } from '../../lib/api-client';
import { useAuth } from './auth-context';
import { AuthField, AuthLayout, SubmitButton } from './auth-shell';

/**
 * Self-service organization registration.
 *
 * The slug is deliberately not asked for. Most people do not know what one is,
 * and the server derives a unique one from the organization name — including
 * resolving collisions — so exposing it here would add a field that can only
 * produce errors.
 */
export function RegisterPage(): React.JSX.Element {
  const { register, status } = useAuth();

  const [organizationName, setOrganizationName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      await register({ organizationName, firstName, lastName, email, password });
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

  const fieldError = (name: string): string | undefined => fieldErrors[name]?.[0];

  return (
    <AuthLayout
      title="Create your organization"
      subtitle="You will be the owner and can invite your team next."
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <AuthField
          id="organizationName"
          label="Organization name"
          value={organizationName}
          onChange={setOrganizationName}
          autoComplete="organization"
          required
          error={fieldError('organizationName')}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <AuthField
            id="firstName"
            label="First name"
            value={firstName}
            onChange={setFirstName}
            autoComplete="given-name"
            required
            error={fieldError('firstName')}
          />
          <AuthField
            id="lastName"
            label="Last name"
            value={lastName}
            onChange={setLastName}
            autoComplete="family-name"
            required
            error={fieldError('lastName')}
          />
        </div>

        <AuthField
          id="email"
          label="Work email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
          error={fieldError('email')}
        />

        <AuthField
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          required
          hint="At least 12 characters."
          error={fieldError('password')}
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

        <SubmitButton submitting={submitting} label="Create organization" busyLabel="Creating…" />

        <p className="text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-slate-900 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
