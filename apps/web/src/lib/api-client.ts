import axios, {
  type AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ApiResponse, AuthenticatedUser, ErrorCode, TokenPair } from '@idea001/api-types';

/**
 * HTTP client.
 *
 * Two deliberate security choices:
 *
 *   1. The access token lives in a module variable, never in localStorage or
 *      sessionStorage. Anything readable by JavaScript is readable by injected
 *      JavaScript, so persisting it would hand an XSS a 15-minute bearer token.
 *      Losing it on reload is fine — the refresh cookie restores the session.
 *
 *   2. The refresh token is an httpOnly cookie set by the server. This code can
 *      neither read nor send it explicitly; the browser attaches it to
 *      /api/v1/auth requests on its own.
 */

let accessToken: string | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};
export const getAccessToken = (): string | null => accessToken;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api: AxiosInstance = axios.create({
  baseURL: '/api/v1',
  withCredentials: true, // lets the browser send the httpOnly refresh cookie
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

/**
 * Single-flight refresh.
 *
 * When a page fires several requests at once and the token has expired, every
 * one of them gets a 401. Without this, each would independently POST /refresh,
 * and because refresh tokens ROTATE, the second call would present a token the
 * first had already consumed — which the server correctly treats as reuse and
 * punishes by killing the whole session family. The user would be logged out
 * for doing nothing wrong.
 *
 * So the first 401 starts a refresh and every other request waits on that same
 * promise.
 */
let refreshInFlight: Promise<string> | null = null;

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

async function refreshAccessToken(): Promise<string> {
  const response = await axios.post<ApiResponse<{ tokens: TokenPair; user: AuthenticatedUser }>>(
    '/api/v1/auth/refresh',
    {},
    { withCredentials: true },
  );

  if (!response.data.success) throw new Error('Refresh failed');

  const token = response.data.data.tokens.accessToken;
  setAccessToken(token);
  return token;
}

/** Notifies the app that the session is gone and the user must sign in again. */
type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler = () => {};
export const setSessionExpiredHandler = (handler: SessionExpiredHandler): void => {
  onSessionExpired = handler;
};

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiResponse<unknown>>) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status;

    const isAuthEndpoint = config?.url?.includes('/auth/');
    const shouldRefresh = status === 401 && config && !config._retried && !isAuthEndpoint;

    if (shouldRefresh) {
      config._retried = true;

      try {
        refreshInFlight ??= refreshAccessToken().finally(() => {
          refreshInFlight = null;
        });

        const token = await refreshInFlight;
        config.headers.Authorization = `Bearer ${token}`;
        return api.request(config);
      } catch {
        setAccessToken(null);
        onSessionExpired();
      }
    }

    const payload = error.response?.data;
    if (payload && typeof payload === 'object' && 'error' in payload && !payload.success) {
      throw new ApiError(
        payload.error.code,
        payload.error.message,
        status ?? 0,
        payload.error.details,
      );
    }

    throw new ApiError('INTERNAL_ERROR', error.message || 'Network error', status ?? 0);
  },
);

/**
 * Envelope-aware helpers.
 *
 * The response interceptor already converts every non-2xx into an ApiError, so
 * by the time these run the envelope is a success. Callers therefore work with
 * plain typed data and never touch `.data.data` or check `success` by hand.
 */
function unwrap<T>(envelope: ApiResponse<T>): T {
  if (!envelope.success) {
    throw new ApiError(envelope.error.code, envelope.error.message, 200, envelope.error.details);
  }
  return envelope.data;
}

export async function apiGet<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const response = await api.get<ApiResponse<T>>(url, params ? { params } : undefined);
  return unwrap(response.data);
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const response = await api.post<ApiResponse<T>>(url, body ?? {});
  return unwrap(response.data);
}

export async function apiPatch<T>(url: string, body?: unknown): Promise<T> {
  const response = await api.patch<ApiResponse<T>>(url, body ?? {});
  return unwrap(response.data);
}
