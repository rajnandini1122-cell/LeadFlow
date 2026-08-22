import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Avatar } from '../components/ui';
import { UserAvatar } from '../components/user-avatar';
import * as apiClient from '../lib/api-client';
import { forgetAuthedImage } from '../lib/use-authed-image';

/**
 * Profile pictures in the UI.
 *
 * The behaviour worth pinning is the FALLBACK. A picture is optional, the
 * request for it can fail, and the endpoint needs a header an `<img>` cannot
 * send — so every one of those paths has to land on initials rather than a
 * broken image or an empty circle. An avatar that sometimes renders as a grey
 * box looks like a broken app, which is worse than never having offered
 * pictures at all.
 */

const AVATAR_URL = '/api/v1/users/u-1/avatar?v=123';

beforeEach(() => {
  vi.restoreAllMocks();
  forgetAuthedImage(AVATAR_URL);
  // jsdom has no object URLs.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  forgetAuthedImage(AVATAR_URL);
});

describe('Avatar', () => {
  it('shows initials when there is no picture', () => {
    render(<Avatar name="Dana Whitfield" />);

    expect(screen.getByTitle('Dana Whitfield')).toHaveTextContent('DW');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows the picture when there is one', () => {
    render(<Avatar name="Dana Whitfield" src="blob:fake" />);

    const image = screen.getByRole('img', { name: 'Dana Whitfield' });
    expect(image).toHaveAttribute('src', 'blob:fake');
    // The name still reaches assistive technology and hover.
    expect(image).toHaveAttribute('alt', 'Dana Whitfield');
  });
});

describe('UserAvatar', () => {
  it('fetches the picture through the authenticated client', async () => {
    /*
     * The whole reason this component exists. The endpoint requires an
     * Authorization header, and an `<img src>` cannot carry one — so the bytes
     * have to be fetched by code that can attach the token.
     */
    const get = vi
      .spyOn(apiClient.api, 'get')
      .mockResolvedValue({ data: new Blob(['x']) } as never);

    render(<UserAvatar name="Dana Whitfield" avatarUrl={AVATAR_URL} />);

    await waitFor(() => expect(get).toHaveBeenCalledWith(AVATAR_URL, { responseType: 'blob' }));
    expect(await screen.findByRole('img', { name: 'Dana Whitfield' })).toBeInTheDocument();
  });

  it('falls back to initials while the picture loads', () => {
    vi.spyOn(apiClient.api, 'get').mockImplementation(
      () => new Promise(() => undefined) as never,
    );

    render(<UserAvatar name="Dana Whitfield" avatarUrl={AVATAR_URL} />);

    // Initials immediately, not an empty circle that pops.
    expect(screen.getByTitle('Dana Whitfield')).toHaveTextContent('DW');
  });

  it('falls back to initials when the request fails', async () => {
    // A deleted picture, a lost session, an offline phone. None of them should
    // produce a broken image.
    vi.spyOn(apiClient.api, 'get').mockRejectedValue(new Error('nope'));

    render(<UserAvatar name="Dana Whitfield" avatarUrl={AVATAR_URL} />);

    await waitFor(() => {
      expect(screen.getByTitle('Dana Whitfield')).toHaveTextContent('DW');
    });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('makes no request when the user has no picture', () => {
    const get = vi.spyOn(apiClient.api, 'get');

    render(<UserAvatar name="Dana Whitfield" avatarUrl={null} />);

    // Most people have not set one; a request per row would be pure waste.
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByTitle('Dana Whitfield')).toHaveTextContent('DW');
  });

  it('fetches a shared picture once, however many rows show it', async () => {
    const get = vi
      .spyOn(apiClient.api, 'get')
      .mockResolvedValue({ data: new Blob(['x']) } as never);

    render(
      <>
        <UserAvatar name="Dana Whitfield" avatarUrl={AVATAR_URL} />
        <UserAvatar name="Dana Whitfield" avatarUrl={AVATAR_URL} />
        <UserAvatar name="Dana Whitfield" avatarUrl={AVATAR_URL} />
      </>,
    );

    await waitFor(() => expect(get).toHaveBeenCalled());
    // A team list of twenty must not issue twenty identical requests.
    expect(get).toHaveBeenCalledTimes(1);
  });
});
