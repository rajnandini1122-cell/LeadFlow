import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Profile pictures.
 *
 * Two things carry the weight here, and most of the cases below defend one of
 * them:
 *
 *   1. The image type is DETECTED from the bytes. A file's declared type and
 *      its extension are both supplied by the client, and trusting either is
 *      the usual way an upload filter is bypassed.
 *
 *   2. A picture is readable only by someone who shares an organization with
 *      its owner. A User is GLOBAL — one person can belong to several tenants
 *      — so user ids are not tenant-scoped, and an unguarded endpoint would
 *      let any signed-in account collect photographs of staff at every other
 *      company on the deployment.
 */
describe('Profile pictures', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A real, minimal PNG — correct magic bytes, so detection succeeds. */
  const png = (): Buffer =>
    Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000100' +
        '05fe02fea70000000049454e44ae426082',
      'hex',
    );

  /** JPEG magic bytes, padded past the 12-byte minimum the sniffer needs. */
  const jpeg = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

  const upload = (token: string, bytes: Buffer, filename = 'avatar.png') =>
    ctx
      .http()
      .post('/api/v1/users/me/avatar')
      .set(auth(token))
      .attach('file', bytes, filename);

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('uploading', () => {
    it('stores a PNG and returns a versioned url', async () => {
      const response = await upload(ctx.orgA.owner.accessToken, png());

      expect(response.status).toBe(200);
      expect(response.body.data.avatarUrl).toContain(`/users/${ctx.orgA.owner.id}/avatar`);
      // The path is stable, so without a version a replaced picture would sit
      // behind the browser's cached copy of the old one.
      expect(response.body.data.avatarUrl).toMatch(/\?v=\d+/);
    });

    it('stores a JPEG', async () => {
      const response = await upload(ctx.orgA.rep.accessToken, jpeg(), 'me.jpg');
      expect(response.status).toBe(200);
    });

    it('replaces an existing picture rather than accumulating them', async () => {
      const first = await upload(ctx.orgA.owner.accessToken, png());
      const second = await upload(ctx.orgA.owner.accessToken, jpeg(), 'new.jpg');

      expect(second.status).toBe(200);
      // A new version, so caches let go of the old image.
      expect(second.body.data.avatarUrl).not.toBe(first.body.data.avatarUrl);
    });

    it('surfaces the new picture on /me', async () => {
      await upload(ctx.orgA.owner.accessToken, png());

      const me = await ctx
        .http()
        .get('/api/v1/auth/me')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(me.body.data.avatarUrl).toContain('/avatar');
    });
  });

  describe('what is refused', () => {
    it('refuses a file that is not an image, whatever it is called', async () => {
      /*
       * A PDF renamed to .png. The extension and the browser's Content-Type
       * both say image; the bytes say otherwise, and the bytes decide.
       */
      const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);
      const response = await upload(ctx.orgA.owner.accessToken, pdf, 'avatar.png');

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/JPEG or PNG/i);
    });

    it('refuses an SVG', async () => {
      /*
       * Specifically excluded. An SVG is a document that can carry script, and
       * serving one from our own origin would be stored XSS dressed as a
       * photograph.
       */
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
      const response = await upload(ctx.orgA.owner.accessToken, svg, 'avatar.svg');

      expect(response.status).toBe(400);
    });

    it('refuses an executable renamed to .jpg', async () => {
      // "MZ" — a Windows PE. The canonical upload-filter bypass.
      const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]);
      const response = await upload(ctx.orgA.owner.accessToken, exe, 'avatar.jpg');

      expect(response.status).toBe(400);
    });

    it('refuses an empty request', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/users/me/avatar')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(400);
    });

    it('requires a session', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/users/me/avatar')
        .attach('file', png(), 'avatar.png');

      expect(response.status).toBe(401);
    });
  });

  describe('who may see one', () => {
    it('serves it to a colleague in the same organization', async () => {
      await upload(ctx.orgA.owner.accessToken, png());

      const response = await ctx
        .http()
        .get(`/api/v1/users/${ctx.orgA.owner.id}/avatar`)
        .set(auth(ctx.orgA.rep.accessToken));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('image/png');
      // The browser must not second-guess a type we detected from the bytes.
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('keeps it PRIVATE to caches', async () => {
      await upload(ctx.orgA.owner.accessToken, png());

      const response = await ctx
        .http()
        .get(`/api/v1/users/${ctx.orgA.owner.id}/avatar`)
        .set(auth(ctx.orgA.rep.accessToken));

      // One organization's staff, not public content.
      expect(response.headers['cache-control']).toContain('private');
    });

    it('does NOT serve it across organizations', async () => {
      /*
       * The assertion this file exists for. User ids are not tenant-scoped, so
       * without an explicit membership check any signed-in account could walk
       * them and collect faces from every customer on the deployment.
       */
      await upload(ctx.orgA.owner.accessToken, png());

      const response = await ctx
        .http()
        .get(`/api/v1/users/${ctx.orgA.owner.id}/avatar`)
        .set(auth(ctx.orgB.owner.accessToken));

      // 404, not 403: confirming the id exists would be an enumeration oracle.
      expect(response.status).toBe(404);
    });

    it('requires a session to read one', async () => {
      const response = await ctx.http().get(`/api/v1/users/${ctx.orgA.owner.id}/avatar`);
      expect(response.status).toBe(401);
    });

    it('404s for a member who has not set one', async () => {
      await ctx
        .http()
        .delete('/api/v1/users/me/avatar')
        .set(auth(ctx.orgA.rep.accessToken));

      const response = await ctx
        .http()
        .get(`/api/v1/users/${ctx.orgA.rep.id}/avatar`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(404);
    });
  });

  describe('removing', () => {
    it('falls back to no picture', async () => {
      await upload(ctx.orgA.owner.accessToken, png());

      const removed = await ctx
        .http()
        .delete('/api/v1/users/me/avatar')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(removed.status).toBe(204);

      const me = await ctx
        .http()
        .get('/api/v1/auth/me')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(me.body.data.avatarUrl).toBeNull();
    });

    it('is safe to call when there is nothing to remove', async () => {
      await ctx
        .http()
        .delete('/api/v1/users/me/avatar')
        .set(auth(ctx.orgA.owner.accessToken));

      const again = await ctx
        .http()
        .delete('/api/v1/users/me/avatar')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(again.status).toBe(204);
    });

    it('only ever removes the CALLER’s own', async () => {
      // There is no route for changing somebody else's picture, which is what
      // removes "an admin changed my photo" before it can be asked.
      await upload(ctx.orgA.owner.accessToken, png());

      await ctx
        .http()
        .delete('/api/v1/users/me/avatar')
        .set(auth(ctx.orgA.rep.accessToken));

      const stillThere = await ctx
        .http()
        .get(`/api/v1/users/${ctx.orgA.owner.id}/avatar`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(stillThere.status).toBe(200);
    });
  });
});
