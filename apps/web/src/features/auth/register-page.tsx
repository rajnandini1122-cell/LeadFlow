import { useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ApiError } from '../../lib/api-client';
import { DEFAULT_COUNTRY, countryOptions } from '../../lib/countries';
import { useAuth } from './auth-context';
import { AuthField, AuthLayout, AuthSelect, SubmitButton } from './auth-shell';
import { GoogleSignInButton } from './google-sign-in';

/**
 * Self-service organization registration.
 *
 * The slug is deliberately not asked for. Most people do not know what one is,
 * and the server derives a unique one from the organization name — including
 * resolving collisions — so exposing it here would add a field that can only
 * produce errors.
 */
export function RegisterPage(): React.JSX.Element {
  const { register, loginWithGoogle, registerWithGoogle, status } = useAuth();

  const [organizationName, setOrganizationName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);

  /*
   * Set when the account exists but the mailbox is not yet proven.
   *
   * This is the whole of the registration change as the user experiences it:
   * the form used to hand straight over to the dashboard, and now it stops
   * here. `emailDelivered` is whether the PROVIDER accepted the message, never
   * whether it arrived — so the copy below never claims an inbox we cannot see.
   */
  const [awaitingVerification, setAwaitingVerification] = useState<
    { email: string; emailDelivered: boolean } | null
  >(null);

  /*
   * Built once.
   *
   * The list comes from the browser's own region data, and there are about 250
   * of them — deriving and re-rendering that on every keystroke in the fields
   * above is work nobody asked for, and it is measurable: typing slowed enough
   * to time a test out.
   */
  const countries = useMemo(
    () => countryOptions().map(({ code, name }) => ({ value: code, label: name })),
    [],
  );

  /*
   * Every hook above this line, without exception.
   *
   * The redirect below is an early return, so a hook declared after it runs on
   * the first render and not on the one where registration has just succeeded
   * — which React counts, and rejects. It cost a test to find and would have
   * cost a user the page.
   */
  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  if (awaitingVerification) {
    return (
      <AuthLayout title="Check your email" subtitle="One step left.">
        <p role="status" aria-live="polite" className="mb-4 text-sm text-slate-600">
          We sent a confirmation link to{' '}
          <strong className="font-medium text-slate-900">{awaitingVerification.email}</strong>.
          Open it to finish setting up your account, then sign in. The link expires in 24
          hours.
        </p>

        {/*
          Shown only when the provider refused the message outright. Saying
          nothing here would leave somebody waiting for an email that was
          never accepted for delivery, with no idea that resending is the fix.
        */}
        {!awaitingVerification.emailDelivered && (
          <p role="alert" className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Your account was created, but we could not send the confirmation email just now.
            Request a new link to try again.
          </p>
        )}

        <div className="space-y-3">
          <Link
            to="/verify-email"
            className="block w-full rounded-lg border border-slate-300 px-4 py-2 text-center text-sm font-medium text-slate-700 transition hover:border-slate-400"
          >
            Send a new link
          </Link>
          <p className="text-center text-sm text-slate-500">
            <Link to="/login" className="font-medium text-slate-900 hover:underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </AuthLayout>
    );
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      const result = await register({
        organizationName,
        firstName,
        lastName,
        email,
        password,
        country,
      });

      // A local registration never signs in. Google registration does, and
      // the redirect above catches it once `status` flips.
      if (!result.verified) {
        setAwaitingVerification({
          email: result.user.email,
          emailDelivered: result.verificationEmailSent,
        });
      }
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


  /**
   * A Google signup from the register form.
   *
   * Tries the sign-in path first: somebody who already has an account should
   * be signed in rather than told their email is taken. Only when there is no
   * account does it create one, using the organization name already typed
   * into the form above.
   */
  const onGoogleToken = async (idToken: string): Promise<void> => {
    setError(null);

    try {
      const result = await loginWithGoogle(idToken);
      if (!result.needsOrganization) return;

      if (organizationName.trim().length < 2) {
        setError('Enter your organization name first, then continue with Google.');
        return;
      }

      await registerWithGoogle(idToken, organizationName, country);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Google sign-in failed. Please try again.',
      );
    }
  };

  return (
    <AuthLayout
      title="Create your organization"
      subtitle="You will be the owner and can invite your team next."
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        {/*
          Signing up with Google skips the password entirely. The
          organization name is still collected — below for a password
          signup, and in a follow-up step for a Google one, because it is
          the one thing Google cannot tell us.
        */}
        <GoogleSignInButton onToken={(token) => void onGoogleToken(token)} />

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

        {/*
          Country is asked here because it is not cosmetic: it decides how
          every phone number this organization later types is read into its
          canonical form, and therefore whether the same customer entered
          twice is recognised as one person. It is changeable afterwards in
          settings, and defaults to where this deployment sells.
        */}
        <AuthSelect
          id="country"
          label="Country"
          value={country}
          onChange={setCountry}
          options={countries}
          hint="Sets how phone numbers are read. You can change it later."
          error={fieldError('country')}
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
