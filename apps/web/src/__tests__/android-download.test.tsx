import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AndroidDownload } from '../features/marketing/android-download';

/**
 * The Android download offer.
 *
 * One rule, and every test below defends it: the card shows what the published
 * APK actually is, or it shows nothing. A download button that 404s, or a
 * version number that does not match the file, is worse than no download
 * section — somebody installs it and reports a bug against a build that was
 * never shipped.
 */

const MANIFEST = {
  fileName: 'leadflow.apk',
  url: '/downloads/leadflow.apk',
  variant: 'debug',
  applicationId: 'app.leadflow.crm',
  versionName: '1.0',
  versionCode: 1,
  bytes: 4_948_963,
  sha256: '7a08aa2a5cfd5135e2e0423ac06ec35a82e0ab90fc3f4aad14dcc2f081e6e6d7',
  builtAt: '2026-08-22T18:18:00.000Z',
};

function mockManifest(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) })),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AndroidDownload', () => {
  it('offers the published APK', async () => {
    mockManifest(MANIFEST);
    render(<AndroidDownload />);

    const link = await screen.findByRole('link', { name: /download apk/i });
    expect(link).toHaveAttribute('href', '/downloads/leadflow.apk');
    expect(link).toHaveAttribute('download', 'leadflow.apk');
  });

  it('shows the real version and size from the manifest', async () => {
    mockManifest(MANIFEST);
    render(<AndroidDownload />);

    // Read from the build output, never hardcoded in the component.
    expect(await screen.findByText(/1\.0/)).toBeInTheDocument();
    expect(screen.getByText('4.7 MB')).toBeInTheDocument();
  });

  it('states the build type, so a debug APK is not mistaken for a release', async () => {
    mockManifest(MANIFEST);
    render(<AndroidDownload />);

    expect(await screen.findByText('debug')).toBeInTheDocument();
  });

  it('shows the checksum, the only integrity signal a sideloaded APK has', async () => {
    mockManifest(MANIFEST);
    render(<AndroidDownload />);

    expect(await screen.findByText(new RegExp(MANIFEST.sha256))).toBeInTheDocument();
  });

  describe('when there is no APK', () => {
    it('renders nothing rather than a link that 404s', async () => {
      mockManifest(null, false);
      const { container } = render(<AndroidDownload />);

      await waitFor(() => expect(container).toBeEmptyDOMElement());
    });

    it('renders nothing when the manifest has no url', async () => {
      // A partial or corrupt manifest is not something to render around.
      mockManifest({ versionName: '9.9' });
      const { container } = render(<AndroidDownload />);

      await waitFor(() => expect(container).toBeEmptyDOMElement());
      expect(screen.queryByText(/9\.9/)).not.toBeInTheDocument();
    });

    it('renders nothing when the request fails outright', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
      const { container } = render(<AndroidDownload />);

      await waitFor(() => expect(container).toBeEmptyDOMElement());
    });
  });
});
