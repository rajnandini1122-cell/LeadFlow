import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, apiPost } from '../lib/api-client';

/**
 * Posting a file.
 *
 * The client defaults to `Content-Type: application/json`, which is right for
 * every request carrying JSON and silently wrong for the ones carrying a file.
 * A multipart body must be announced with a BOUNDARY only the runtime can
 * generate, so the default has to be cleared for the browser to fill it in.
 *
 * Left in place, the server receives a multipart payload labelled as JSON,
 * parses no fields at all, and reports that no file was attached — which reads
 * like a bug in the upload rather than in the header, and cost a real debugging
 * session to find. Both the profile picture and message attachments go through
 * this path, so one wrong default breaks every upload in the product.
 */

let post: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: {} } } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiPost', () => {
  it('clears the JSON content type for a file upload', async () => {
    const form = new FormData();
    form.append('file', new Blob(['bytes']), 'avatar.png');

    await apiPost('/users/me/avatar', form);

    const config = post.mock.calls[0]?.[2] as { headers?: Record<string, unknown> } | undefined;

    // Null removes it, so axios and the browser agree on multipart with a
    // generated boundary. Anything else means the boundary is lost.
    expect(config?.headers?.['Content-Type']).toBeNull();
  });

  it('leaves an ordinary JSON post alone', async () => {
    await apiPost('/leads', { firstName: 'Rahul' });

    // No override: the client default is correct here, and overriding it would
    // break every normal request to fix uploads.
    expect(post.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('leaves a bodyless post alone', async () => {
    await apiPost('/auth/logout');

    expect(post.mock.calls[0]?.[2]).toBeUndefined();
  });
});
