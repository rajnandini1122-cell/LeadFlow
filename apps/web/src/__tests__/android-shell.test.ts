import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Android app's shell behaviour: hardware Back, and handing files to the
 * user (download in a browser, share sheet in the app).
 */

const writeFile = vi.fn();
const share = vi.fn();
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: (...args: unknown[]) => writeFile(...args) },
  Directory: { Cache: 'CACHE' },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: (...args: unknown[]) => share(...args) } }));

const pushRegister = vi.fn();
const pushUnregister = vi.fn();
vi.mock('@capacitor/push-notifications', () => {
  const methods: Record<string, unknown> = {
    checkPermissions: () => Promise.resolve({ receive: 'granted' }),
    requestPermissions: () => Promise.resolve({ receive: 'granted' }),
    removeAllListeners: () => Promise.resolve(),
    addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
    register: () => pushRegister(),
    unregister: () => pushUnregister(),
  };
  /*
   * Like Capacitor's real plugin object: a proxy that forwards ANY property —
   * including `then` — to "native", which rejects what it does not implement.
   * Returning such an object bare from an async function never settles; on a
   * device this is exactly what stopped push registration from ever running.
   */
  const proxy = new Proxy(methods, {
    get: (target, prop) =>
      prop in target
        ? target[prop as string]
        : () => Promise.reject(new Error(`"PushNotifications.${String(prop)}()" is not implemented on android`)),
  });
  return { PushNotifications: proxy };
});

const asNativeApp = (native: boolean): void => {
  (globalThis as { Capacitor?: unknown }).Capacitor = native ? { isNativePlatform: () => true } : undefined;
};

afterEach(() => {
  asNativeApp(false);
  vi.unstubAllEnvs();
  pushRegister.mockReset();
  pushUnregister.mockReset();
  vi.restoreAllMocks();
  writeFile.mockReset();
  share.mockReset();
  document.body.innerHTML = '';
});

describe('hardware Back', () => {
  it('closes an open dialog first, and does not navigate', async () => {
    const { handleBack } = await import('../lib/native-shell');
    document.body.innerHTML = '<div role="dialog">Log outcome</div>';
    const escape = vi.fn();
    document.addEventListener('keydown', (e) => e.key === 'Escape' && escape(), { once: true });
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const exit = vi.fn();

    handleBack(true, exit);

    expect(escape).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('goes back a page when there is one', async () => {
    const { handleBack } = await import('../lib/native-shell');
    window.history.pushState({}, '', '/leads/x');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const exit = vi.fn();

    handleBack(true, exit);

    expect(back).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('leaves the app only from the first screen', async () => {
    const { handleBack } = await import('../lib/native-shell');
    const exit = vi.fn();
    handleBack(false, exit);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('installs nothing in a browser', async () => {
    const { installNativeShell } = await import('../lib/native-shell');
    await expect(installNativeShell()).resolves.toBeUndefined();
  });
});

describe('push notifications', () => {
  /*
   * Without google-services.json the plugin's register()/unregister() throw on
   * the native side, which Capacitor turns into an app crash. The APK must not
   * call them at all unless it was built with Firebase.
   */
  it('never touches the push plugin when the build has no Firebase config', async () => {
    asNativeApp(true);
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.test');
    vi.stubEnv('VITE_ANDROID_PUSH', 'false');
    const { registerForPush, unregisterFromPush } = await import('../lib/push');

    await expect(registerForPush(() => undefined)).resolves.toEqual({
      registered: false,
      reason: 'push is not configured in this build',
    });
    await unregisterFromPush();

    expect(pushRegister).not.toHaveBeenCalled();
    expect(pushUnregister).not.toHaveBeenCalled();
  });

  it('registers when the build was made with Firebase', async () => {
    asNativeApp(true);
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.test');
    vi.stubEnv('VITE_ANDROID_PUSH', 'true');
    pushRegister.mockResolvedValue(undefined);
    const { registerForPush } = await import('../lib/push');

    await expect(registerForPush(() => undefined)).resolves.toEqual({ registered: true });
    expect(pushRegister).toHaveBeenCalledTimes(1);
  });
});

describe('requests on a bad connection', () => {
  it('every request has a timeout, longer for uploads', async () => {
    const { api, REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } = await import('../lib/api-client');
    expect(api.defaults.timeout).toBe(REQUEST_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
  });

  it('says plainly what happened when no response arrived', async () => {
    const { networkFailureMessage } = await import('../lib/api-client');
    expect(networkFailureMessage({ code: 'ECONNABORTED' })).toMatch(/timed out/);
    expect(networkFailureMessage({ code: 'ERR_NETWORK' })).toMatch(/No connection/);
  });

  it('a request that gets no response rejects with that message instead of hanging', async () => {
    const { api } = await import('../lib/api-client');
    const failing = api.get('/anything', {
      adapter: () => Promise.reject(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED', isAxiosError: true, config: {} })),
    });
    await expect(failing).rejects.toMatchObject({ message: expect.stringMatching(/timed out/) });
  });
});

describe('saving a file', () => {
  it('downloads through a link in a browser', async () => {
    const { saveFile } = await import('../lib/save-file');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await saveFile(new Blob(['a,b']), 'leads.csv');

    expect(click).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('in the app, writes to the cache and opens the share sheet — no dead download', async () => {
    asNativeApp(true);
    const { saveFile } = await import('../lib/save-file');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    writeFile.mockResolvedValue({ uri: 'file:///cache/shared/1-Quotation Q-104.pdf' });
    share.mockResolvedValue({});

    await saveFile(new Blob(['%PDF-1.4']), 'Quotation Q-104.pdf');

    expect(click).not.toHaveBeenCalled();
    const [written] = writeFile.mock.calls[0] as [{ path: string; data: string; directory: string }];
    expect(written.directory).toBe('CACHE');
    expect(written.path).toMatch(/^shared\/\d+-Quotation Q-104\.pdf$/);
    expect(atob(written.data)).toBe('%PDF-1.4');
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ files: ['file:///cache/shared/1-Quotation Q-104.pdf'], title: 'Quotation Q-104.pdf' }),
    );
  });

  it('treats closing the share sheet as a choice, not an error', async () => {
    asNativeApp(true);
    const { saveFile } = await import('../lib/save-file');
    writeFile.mockResolvedValue({ uri: 'file:///cache/x.csv' });
    share.mockRejectedValue(new Error('Share canceled'));

    await expect(saveFile(new Blob(['x']), 'x.csv')).resolves.toBeUndefined();
  });

  it('reports a real failure', async () => {
    asNativeApp(true);
    const { saveFile } = await import('../lib/save-file');
    writeFile.mockRejectedValue(new Error('disk full'));

    await expect(saveFile(new Blob(['x']), 'x.csv')).rejects.toThrow('disk full');
  });

  it('makes any name safe for the device', async () => {
    const { safeName } = await import('../lib/save-file');
    expect(safeName('a/b\\c:d*e?"f<g>h|i.pdf')).toBe('a_b_c_d_e__f_g_h_i.pdf');
    expect(safeName('')).toBe('file');
  });
});
