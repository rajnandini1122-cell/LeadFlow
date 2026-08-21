import { vi } from 'vitest';
import { ApiError } from '../../lib/api-client';
import type * as ApiClient from '../../lib/api-client';

/**
 * Stubs the api-client module.
 *
 * Deliberately mocks OUR client rather than `fetch` or axios: these are
 * component tests about screen behaviour — loading, error and success states —
 * and the HTTP layer has its own coverage in the API e2e suite. Stubbing at the
 * transport level would test axios, not the screen.
 */
export const mockApi = {
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../lib/api-client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../../lib/api-client');

  return {
    ...actual,
    apiGet: (...args: unknown[]) => mockApi.apiGet(...args),
    apiPost: (...args: unknown[]) => mockApi.apiPost(...args),
    apiPatch: (...args: unknown[]) => mockApi.apiPatch(...args),
    api: { delete: (...args: unknown[]) => mockApi.del(...args) },
  };
});

/** Builds the ApiError the real client would throw for a given status. */
export function apiError(
  status: number,
  message: string,
  details?: Record<string, string[]>,
): ApiError {
  return new ApiError(
    status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHORIZED' : 'VALIDATION_ERROR',
    message,
    status,
    details,
  );
}

export function resetApiMocks(): void {
  mockApi.apiGet.mockReset();
  mockApi.apiPost.mockReset();
  mockApi.apiPatch.mockReset();
  mockApi.del.mockReset();
}
