import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api-client';

/**
 * "Continue with Google".
 *
 * Renders NOTHING unless the server says Google sign-in is configured. A
 * button that fails on click reads as a broken product rather than an
 * unconfigured one, and this deployment may legitimately not have a Google
 * client id at all.
 *
 * The heavy lifting is Google's: their script renders the button and runs the
 * account chooser, then hands back an ID token. That token is the only thing
 * this component produces — it is passed straight to the API, which verifies
 * it against Google's keys. Nothing here inspects or trusts it.
 *
 * The client id is public by design; it is embedded in every browser that
 * loads the button. There is no client secret anywhere in this flow.
 */

interface AuthProviders {
  google: { enabled: boolean; clientId: string | null };
}

/** Google's global, present once their script has loaded. */
interface GoogleAccounts {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string;
        callback: (response: { credential?: string }) => void;
      }) => void;
      renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
    };
  };
}

const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/**
 * Loads Google's script once, however many components ask.
 *
 * Both the sign-in and the register page can mount this, and appending the
 * script twice makes Google's library initialise twice.
 */
let scriptPromise: Promise<void> | null = null;

function loadGoogleScript(): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google sign-in could not be loaded.'));
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export function useAuthProviders() {
  return useQuery({
    queryKey: ['auth', 'providers'],
    queryFn: () => apiGet<AuthProviders>('/auth/providers'),
    // Deployment configuration, not user data. It does not change while
    // somebody is looking at a login form.
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}

export function GoogleSignInButton({
  onToken,
  disabled = false,
}: {
  /** Called with Google's ID token. The caller decides what to do with it. */
  onToken: (idToken: string) => void;
  disabled?: boolean;
}): React.JSX.Element | null {
  const providers = useAuthProviders();
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  /*
   * Google's callback is registered once, but `onToken` changes on every
   * render. A ref keeps the callback current without re-initialising their
   * library, which would tear down and redraw the button on each keystroke in
   * the form beside it.
   */
  const latest = useRef(onToken);
  latest.current = onToken;

  const clientId = providers.data?.google.enabled ? providers.data.google.clientId : null;

  useEffect(() => {
    if (!clientId || !container.current) return;

    let cancelled = false;

    void loadGoogleScript()
      .then(() => {
        if (cancelled || !container.current) return;

        const google = (globalThis as { google?: GoogleAccounts }).google;
        if (!google) {
          setFailed(true);
          return;
        }

        google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response.credential) latest.current(response.credential);
          },
        });

        google.accounts.id.renderButton(container.current, {
          theme: 'outline',
          size: 'large',
          width: 320,
          text: 'continue_with',
          shape: 'rectangular',
        });
      })
      .catch(() => {
        // Offline, blocked by an extension, or Google is down. The password
        // form beside this still works, so say so quietly rather than
        // breaking the page.
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  // Not configured on this deployment, or still finding out.
  if (!clientId) return null;

  if (failed) {
    return (
      <p className="text-center text-xs text-slate-500">
        Google sign-in is unavailable right now. Use your email and password below.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/*
        Google draws its own button inside this element. Its appearance is
        fixed by their brand terms, so it is deliberately not styled here.
      */}
      <div
        ref={container}
        className={`flex justify-center ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      />

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-xs text-slate-400">or</span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>
    </div>
  );
}
