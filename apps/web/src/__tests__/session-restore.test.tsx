import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Restoring a session on a cold start.
 *
 * Android kills background apps all the time; reopening LeadFlow must not mean
 * signing in again. In the app the refresh token is in encrypted storage (no
 * cookie), so the restore call has to SEND it — it used to post an empty body,
 * get a 401, and sign the rep out on every relaunch. Found on the emulator.
 */

const stored = vi.fn<() => Promise<string | null>>();
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    get: () => stored(),
    set: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  },
}));

const USER = {
  id: 'u-1',
  email: 'tomas@northwind.example',
  fullName: 'Tomas Novak',
  status: 'ACTIVE',
  role: 'SALES_REP',
  permissions: [],
  organization: { id: 'o', name: 'Northwind', slug: 'nw', timezone: 'Asia/Kolkata', currency: 'INR', locale: 'en-IN', country: 'IN' },
  organizations: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function renderAuth() {
  const apiClient = await import('../lib/api-client');
  const apiPost = vi.spyOn(apiClient, 'apiPost').mockImplementation((url: string) =>
    url === '/auth/refresh'
      ? Promise.resolve({ tokens: { accessToken: 'a', refreshToken: 'rotated' }, user: USER } as never)
      : Promise.resolve({} as never),
  );
  const { AuthProvider, useAuth } = await import('../features/auth/auth-context');
  function Status(): React.JSX.Element {
    return <p>status:{useAuth().status}</p>;
  }
  render(
    <MemoryRouter>
      <AuthProvider>
        <Status />
      </AuthProvider>
    </MemoryRouter>,
  );
  return apiPost;
}

describe('cold-start session restore', () => {
  it('in the app, sends the stored refresh token and stays signed in', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.test');
    stored.mockResolvedValue('stored-refresh-token');

    const apiPost = await renderAuth();

    expect(await screen.findByText('status:authenticated')).toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledWith('/auth/refresh', { refreshToken: 'stored-refresh-token' });
  });

  it('in the app with nothing stored, goes to sign in without calling the API', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.test');
    stored.mockResolvedValue(null);

    const apiPost = await renderAuth();

    expect(await screen.findByText('status:anonymous')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalledWith('/auth/refresh', expect.anything());
  });

  it('in a browser, sends no token — the httpOnly cookie carries it', async () => {
    const apiPost = await renderAuth();

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/auth/refresh', {}));
  });
});
