import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, apiPost } from '../../lib/api-client';
import { AuthLayout, SubmitButton } from './auth-shell';

/**
 * Where a verification link lands.
 *
 * Four outcomes, and they are genuinely different things to say. "Already
 * verified" is not a failure — the commonest cause is somebody clicking twice,
 * or a mail client prefetching the URL before they tap it — and telling them
 * something went wrong would be a lie about an account that is perfectly fine.
 *
 * Branches on the server's CODE, never on its prose. A screen that matched
 * message text would break the first time the wording improved.
 */
type Outcome =
  | { state: 'verifying' }
  | { state: 'verified'; email: string }
  | { state: 'already' }
  | { state: 'expired' }
  | { state: 'invalid' };

export function VerifyEmailPage(): React.JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [outcome, setOutcome] = useState<Outcome>({ state: 'verifying' });

  /*
   * Guards against the double-invoke of React's development StrictMode.
   *
   * The token is SINGLE-USE. Without this, mounting twice spends it on the
   * first call and reports "already verified" from the second — so a perfectly
   * good link would look broken to every developer running the app locally.
   */
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    void (async () => {
      try {
        const result = await apiPost<{ email: string }>('/auth/verify-email', { token });
        setOutcome({ state: 'verified', email: result.email });
      } catch (error) {
        const code = error instanceof ApiError ? error.code : undefined;

        if (code === 'EMAIL_VERIFICATION_ALREADY_COMPLETED') setOutcome({ state: 'already' });
        else if (code === 'EMAIL_VERIFICATION_EXPIRED') setOutcome({ state: 'expired' });
        else setOutcome({ state: 'invalid' });
      }
    })();
  }, [token]);

  if (!token) return <ResendPanel reason="missing" />;

  switch (outcome.state) {
    case 'verifying':
      return (
        <AuthLayout title="Confirming your email" subtitle="One moment.">
          {/* Never a blank screen: something is on the page from the first render. */}
          <p role="status" aria-live="polite" className="text-sm text-slate-600">
            Checking your verification link…
          </p>
        </AuthLayout>
      );

    case 'verified':
      return (
        <AuthLayout title="Email confirmed" subtitle="Your account is ready.">
          <p role="status" className="mb-4 text-sm text-slate-600">
            <strong className="font-medium text-slate-900">{outcome.email}</strong> is
            confirmed. You can sign in now.
          </p>
          <Link
            to="/login"
            className="block w-full rounded-lg bg-slate-900 px-4 py-2 text-center text-sm font-medium text-white transition hover:bg-slate-800"
          >
            Sign in
          </Link>
        </AuthLayout>
      );

    case 'already':
      return (
        <AuthLayout title="Already confirmed" subtitle="Nothing more to do.">
          {/*
            Deliberately not phrased as an error. Clicking a link twice is the
            normal cause, and the account is fine.
          */}
          <p role="status" className="mb-4 text-sm text-slate-600">
            This email address has already been confirmed. You can sign in.
          </p>
          <Link
            to="/login"
            className="block w-full rounded-lg bg-slate-900 px-4 py-2 text-center text-sm font-medium text-white transition hover:bg-slate-800"
          >
            Sign in
          </Link>
        </AuthLayout>
      );

    case 'expired':
      return <ResendPanel reason="expired" />;

    case 'invalid':
    default:
      return <ResendPanel reason="invalid" />;
  }
}

/**
 * The recovery path, shown whenever a link cannot be used.
 *
 * Every dead end offers a way forward rather than an apology: a link that
 * expired, one that was never valid, and a page reached with no token at all
 * are all fixed by sending a new one.
 */
function ResendPanel({ reason }: { reason: 'expired' | 'invalid' | 'missing' }): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const message = {
    expired: 'That link has expired. Links are valid for 24 hours.',
    invalid: 'That verification link is not valid.',
    missing: 'Enter your email address and we will send a new confirmation link.',
  }[reason];

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return; // No duplicate submissions on a double click.

    setSubmitting(true);
    setError(null);

    try {
      await apiPost('/auth/verify-email/resend', { email });
      setSent(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'We could not send that right now. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout title="Check your email" subtitle="A new link is on its way.">
        {/*
          Says what WILL happen, not what did — and identical whatever the
          address. The server answers the same way for an account that exists,
          one already verified and one that never existed, so this screen must
          not narrow that down either.
        */}
        <p role="status" className="mb-4 text-sm text-slate-600">
          If that address needs confirming, a new link is on its way. It expires in 24
          hours.
        </p>
        <Link
          to="/login"
          className="block w-full rounded-lg border border-slate-300 px-4 py-2 text-center text-sm font-medium text-slate-700 transition hover:border-slate-400"
        >
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Confirm your email" subtitle="Let us send you a new link.">
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <p role="status" className="text-sm text-slate-600">
          {message}
        </p>

        <div>
          <label
            htmlFor="verify-email"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Email
          </label>
          <input
            id="verify-email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <SubmitButton submitting={submitting} label="Send a new link" busyLabel="Sending…" />

        <p className="text-center text-sm text-slate-500">
          <Link to="/login" className="font-medium text-slate-900 hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
