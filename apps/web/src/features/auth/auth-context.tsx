import { useNavigate } from 'react-router-dom';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AuthenticatedUser,
  LoginResponse,
  OrganizationSummary,
  Permission,
} from '@leadflow/api-types';
import type { TokenPair } from '@leadflow/api-types';
import {
  apiPost,
  mayHaveSession,
  setAccessToken,
  setSessionExpiredHandler,
} from '../../lib/api-client';
import { setFormattingContext } from '../../lib/format';
import { clientPlatform, storeRefreshToken } from '../../lib/platform';

interface RefreshResult {
  tokens: TokenPair;
  user: AuthenticatedUser;
}

/**
 * Keeps the refresh token when this client is the one holding it.
 *
 * Android only. On the web `tokens.refreshToken` is absent — the server put it
 * in an httpOnly cookie instead — and `storeRefreshToken` ignores non-native
 * platforms anyway, so this is a no-op in a browser.
 */
function keepRefreshToken(tokens: TokenPair): void {
  if (tokens.refreshToken) storeRefreshToken(tokens.refreshToken);
}

interface AuthState {
  user: AuthenticatedUser | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  /** Set when the account belongs to several organizations and one must be picked. */
  pendingOrganizations: OrganizationSummary[] | null;
  login: (email: string, password: string, organizationId?: string) => Promise<LoginResponse>;
  register: (input: {
    organizationName: string;
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  }) => Promise<void>;
  /** Switches tenant without re-entering credentials. Server validates membership. */
  switchOrganization: (organizationId: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Whether this anonymous state came from the user deliberately signing out.
   *
   * Distinguishes "I left" from "my session ended". They want different
   * destinations — the front door for the first, the login form for the second
   * — and without this the route guard cannot tell them apart, so everybody
   * lands at a password box.
   */
  signedOut: boolean;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [signedOut, setSignedOut] = useState(false);
  const [pendingOrganizations, setPendingOrganizations] = useState<OrganizationSummary[] | null>(
    null,
  );
  const navigate = useNavigate();

  /**
   * Restores the session on load.
   *
   * The access token is deliberately not persisted, so after a reload there is
   * none. The httpOnly refresh cookie survives, so a single refresh call
   * re-establishes the session — which is why a page refresh does not log the
   * user out despite nothing being stored client-side.
   */
  useEffect(() => {
    let cancelled = false;

    const restore = async (): Promise<void> => {
      if (!mayHaveSession()) {
        // App, first launch, nothing stored. Saves a request guaranteed to
        // 401 and the brief "loading" flash that comes with it.
        setStatus('anonymous');
        return;
      }

      try {
        const result = await apiPost<RefreshResult>('/auth/refresh');

        if (cancelled) return;
        keepRefreshToken(result.tokens);
        setSignedOut(false);
        setAccessToken(result.tokens.accessToken);
        applyOrganizationFormatting(result.user);
        setUser(result.user);
        setStatus('authenticated');
      } catch {
        if (cancelled) return;
        setAccessToken(null);
        setStatus('anonymous');
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      storeRefreshToken(null);
      setUser(null);
      setStatus('anonymous');
    });
  }, []);

  const login = useCallback(
    async (email: string, password: string, organizationId?: string): Promise<LoginResponse> => {
      const result = await apiPost<LoginResponse>('/auth/login', {
        email,
        password,
        platform: clientPlatform(),
        ...(organizationId ? { organizationId } : {}),
      });

      if (result.requiresOrganizationSelection) {
        setPendingOrganizations(result.organizations);
        return result;
      }

      setPendingOrganizations(null);
      setSignedOut(false);
      keepRefreshToken(result.tokens);
      setAccessToken(result.tokens.accessToken);
      applyOrganizationFormatting(result.user);
        setUser(result.user);
      setStatus('authenticated');
      return result;
    },
    [],
  );

  const register = useCallback(
    async (input: {
      organizationName: string;
      firstName: string;
      lastName: string;
      email: string;
      password: string;
    }): Promise<void> => {
      const result = await apiPost<RefreshResult>('/auth/register', {
        ...input,
        platform: clientPlatform(),
      });

      setSignedOut(false);
      keepRefreshToken(result.tokens);
      setAccessToken(result.tokens.accessToken);
      applyOrganizationFormatting(result.user);
      setUser(result.user);
      setStatus('authenticated');
    },
    [],
  );

  const switchOrganization = useCallback(async (organizationId: string): Promise<void> => {
    // The server re-reads membership; a foreign id is refused with 403 and no
    // session is issued, so this is a selector rather than a claim.
    const result = await apiPost<RefreshResult>('/auth/switch-organization', {
      targetOrganizationId: organizationId,
      platform: clientPlatform(),
    });

    keepRefreshToken(result.tokens);
    setAccessToken(result.tokens.accessToken);
    applyOrganizationFormatting(result.user);
    setUser(result.user);
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiPost('/auth/logout');
    } catch {
      // Swallowed deliberately. Every caller invokes this as `void logout()`,
      // so a rejection here becomes an unhandled promise rejection — and there
      // is nothing useful to tell the user anyway: the local session is
      // cleared below either way, and the server-side refresh cookie is
      // rejected on its next use.
    } finally {
      /*
       * Record the INTENT before clearing the session.
       *
       * `setStatus('anonymous')` commits urgently, while the router treats
       * navigation as a transition — so the route guard re-renders at the
       * protected path first and its own redirect wins the race. Rather than
       * trying to win that race, both redirects are made to agree: the guard
       * reads this flag and sends a deliberate sign-out to the front door.
       */
      setSignedOut(true);
      // Clear local state even if the call failed — the user asked to leave,
      // and the refresh cookie is cleared server-side on the next attempt.
      storeRefreshToken(null);
      setAccessToken(null);
      setUser(null);
      setStatus('anonymous');

      // Send them to the public site rather than leaving them on a protected
      // route. Without this the route guard fires on the next render and they
      // land on the login screen, which reads as "signing out failed" —
      // signing out should end at the front door, not at another password box.
      navigate('/', { replace: true });
    }
  }, [navigate]);

  const can = useCallback(
    (permission: Permission): boolean => user?.permissions.includes(permission) ?? false,
    [user],
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      status,
      pendingOrganizations,
      login,
      register,
      switchOrganization,
      logout,
      signedOut,
      can,
    }),
    [user, status, pendingOrganizations, login, register, switchOrganization, logout, signedOut, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Adopts the organization's locale, currency and timezone for all formatting.
 *
 * Called on every path that establishes a session, so switching between two
 * organizations reformats every figure on screen rather than showing one
 * tenant's numbers in another tenant's conventions.
 */
function applyOrganizationFormatting(user: AuthenticatedUser): void {
  setFormattingContext({
    locale: user.organization.locale,
    currency: user.organization.currency,
    timezone: user.organization.timezone,
  });
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
