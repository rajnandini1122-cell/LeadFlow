import { useParams } from 'react-router-dom';
import { useUnsubscribe, useUnsubscribeInfo } from './use-email';

/**
 * The page behind every marketing email's unsubscribe link. Public: no login,
 * no account. Opening it changes nothing (mail scanners open links); the button
 * does.
 */
export function UnsubscribePage(): React.JSX.Element {
  const { token = '' } = useParams<{ token: string }>();
  const info = useUnsubscribeInfo(token);
  const unsubscribe = useUnsubscribe();
  const done = unsubscribe.isSuccess || info.data?.alreadyUnsubscribed;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        {info.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {info.error && (
          <>
            <h1 className="text-lg font-semibold text-slate-900">Link not valid</h1>
            <p className="mt-2 text-sm text-slate-600">
              This unsubscribe link is not valid or has expired. Reply to the email and ask to be
              removed.
            </p>
          </>
        )}
        {info.data && done && (
          <>
            <h1 className="text-lg font-semibold text-slate-900">You are unsubscribed</h1>
            <p className="mt-2 text-sm text-slate-600">
              You will not receive marketing emails from{' '}
              <strong>{info.data.organizationName}</strong> any more.
            </p>
          </>
        )}
        {info.data && !done && (
          <>
            <h1 className="text-lg font-semibold text-slate-900">Unsubscribe</h1>
            <p className="mt-2 text-sm text-slate-600">
              Stop receiving marketing emails from <strong>{info.data.organizationName}</strong>?
            </p>
            <button
              type="button"
              disabled={unsubscribe.isPending}
              onClick={() => unsubscribe.mutate(token)}
              className="mt-6 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {unsubscribe.isPending ? 'Unsubscribing…' : 'Unsubscribe'}
            </button>
            {unsubscribe.error && (
              <p className="mt-3 text-sm text-red-700">That did not work. Please try again.</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
