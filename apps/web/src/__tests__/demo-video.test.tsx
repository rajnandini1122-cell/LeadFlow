import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoVideo } from '../features/marketing/demo-video';

/**
 * The home page demo video.
 *
 * Same rule as the Android download card: show what is actually published, or
 * show nothing. A prospective customer is the worst possible person to show a
 * broken player or a "coming soon" placeholder to.
 */

const DEMO = {
  url: '/demo/demo.mp4',
  poster: '/demo/poster.jpg',
  captions: '/demo/captions.vtt',
  title: 'See LeadFlow in ninety seconds',
  description: 'A lead arrives, gets an owner, and is answered on WhatsApp.',
  durationLabel: '1 min 32 sec',
};

function mockDemo(body: unknown, ok = true): void {
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

describe('DemoVideo', () => {
  it('renders the published video', async () => {
    mockDemo(DEMO);
    const { container } = render(<DemoVideo />);

    await waitFor(() => expect(container.querySelector('video')).toBeInTheDocument());
    expect(container.querySelector('source')).toHaveAttribute('src', '/demo/demo.mp4');
  });

  it('uses the supplied title and description', async () => {
    mockDemo(DEMO);
    render(<DemoVideo />);

    expect(await screen.findByRole('heading', { name: DEMO.title })).toBeInTheDocument();
    expect(screen.getByText(DEMO.description)).toBeInTheDocument();
  });

  it('falls back to sensible copy when only a url is given', async () => {
    mockDemo({ url: '/demo/demo.mp4' });
    render(<DemoVideo />);

    expect(await screen.findByRole('heading', { name: /see leadflow/i })).toBeInTheDocument();
  });

  it('does not autoplay', async () => {
    // A video that starts on its own, especially with sound, is the fastest
    // way to make somebody close the tab.
    mockDemo(DEMO);
    const { container } = render(<DemoVideo />);

    await waitFor(() => expect(container.querySelector('video')).toBeInTheDocument());
    const video = container.querySelector('video') as HTMLVideoElement;

    expect(video).not.toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('controls');
    // Only enough to show the duration, so the page stays quick for the
    // majority who never press play.
    expect(video).toHaveAttribute('preload', 'metadata');
  });

  it('includes the captions track when one is published', async () => {
    mockDemo(DEMO);
    const { container } = render(<DemoVideo />);

    await waitFor(() => expect(container.querySelector('track')).toBeInTheDocument());
    expect(container.querySelector('track')).toHaveAttribute('src', '/demo/captions.vtt');
  });

  describe('when nothing has been published', () => {
    it('renders nothing rather than a placeholder', async () => {
      mockDemo(null, false);
      const { container } = render(<DemoVideo />);

      await waitFor(() => expect(container).toBeEmptyDOMElement());
    });

    it('renders nothing when the manifest has no url', async () => {
      mockDemo({ title: 'Coming soon' });
      const { container } = render(<DemoVideo />);

      await waitFor(() => expect(container).toBeEmptyDOMElement());
      expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    });

    it('renders nothing when the request fails', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
      const { container } = render(<DemoVideo />);

      await waitFor(() => expect(container).toBeEmptyDOMElement());
    });
  });
});
