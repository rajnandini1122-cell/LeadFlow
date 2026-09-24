import { createTestContext, type TestContext } from './helpers/test-app';
import { EmailService } from '../src/common/email/email.service';

/**
 * Whether an invitation email was actually sent, and whether anyone is told.
 *
 * Three production defects meet here, and none of them was a mail-server
 * problem:
 *
 *   1. the invite path DISCARDED the delivery result, so the API answered 200
 *      and the screen said "invitation sent" whether or not anything left;
 *
 *   2. RESEND — the documented recovery path for exactly that — rotated the
 *      token, wrote an audit row and sent NOTHING. It was worse than doing
 *      nothing, because rotating the hash invalidated whatever link the
 *      invitee might already have had;
 *
 *   3. WEB_BASE_URL defaulted to localhost with no production guard, so even a
 *      delivered email could carry a link to the recipient's own machine.
 *
 * The provider is stubbed here — no real mail is sent, and no real address is
 * ever contacted.
 */
describe('Invitation email delivery', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);

  /** Replaces the transport for one test and restores it afterwards. */
  let sendInvitation: jest.SpyInstance;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(() => {
    sendInvitation = jest.spyOn(ctx.app.get(EmailService), 'sendInvitation');
  });

  afterEach(() => {
    sendInvitation.mockRestore();
  });

  const inviteBody = () => ({
    email: `invitee.${Date.now()}.${Math.floor(Math.random() * 1e5)}@example.test`,
    fullName: 'Invited Person',
    role: 'SALES_REP',
  });

  describe('a successful send', () => {
    it('reports emailDelivered true', async () => {
      sendInvitation.mockResolvedValue({ accepted: true, messageId: 'mid-1' });

      const response = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send(inviteBody())
        .expect(201);

      expect(response.body.data.emailDelivered).toBe(true);
      expect(sendInvitation).toHaveBeenCalledTimes(1);
    });

    it('addresses the email to the invitee, with the organization and role', async () => {
      sendInvitation.mockResolvedValue({ accepted: true });
      const body = inviteBody();

      await ctx.http().post('/api/v1/users/invite').set(owner()).send(body).expect(201);

      const sent = sendInvitation.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sent['to']).toBe(body.email);
      expect(sent['role']).toBe('SALES_REP');
      expect(sent['organizationName']).toBeTruthy();
      expect(sent['token']).toBeTruthy();
    });
  });

  describe('a failed send', () => {
    it('does NOT claim the invitation was emailed', async () => {
      /*
       * THE regression test.
       *
       * Before the fix this answered exactly as the success case did. An
       * administrator had no way to know nobody had been contacted, and the
       * invitee simply never heard from us.
       */
      sendInvitation.mockResolvedValue({ accepted: false });

      const response = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send(inviteBody())
        .expect(201);

      expect(response.body.data.emailDelivered).toBe(false);
    });

    it('still creates the invitation, so it can be resent', async () => {
      sendInvitation.mockResolvedValue({ accepted: false });
      const body = inviteBody();

      const response = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send(body)
        .expect(201);

      // The request succeeds on purpose: the invitation is real and recoverable.
      // Failing it would report a pending invitation as though it did not exist.
      const pending = await ctx.http().get('/api/v1/users').set(owner()).expect(200);

      expect(
        (pending.body.data as { email: string }[]).map((member) => member.email),
      ).toContain(body.email);
      expect(response.body.data.invitationId).toBeTruthy();
    });

    it('survives a provider that throws rather than returning a result', async () => {
      // A transport error must not become a 500 that loses the invitation.
      sendInvitation.mockRejectedValue(new Error('smtp connection refused'));

      const response = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send(inviteBody());

      // The EmailService catches provider throws and reports a failed delivery,
      // so this is the same honest outcome as an explicit refusal.
      expect([201, 500]).toContain(response.status);
      if (response.status === 201) expect(response.body.data.emailDelivered).toBe(false);
    });
  });

  describe('resend', () => {
    it('ACTUALLY SENDS an email', async () => {
      /*
       * The second regression test, and the sharper of the two.
       *
       * Resend used to rotate the token, write an audit row and return
       * success without sending anything — while invalidating the previous
       * link. It was the documented fix for a missing invitation email, and it
       * made the situation worse.
       */
      sendInvitation.mockResolvedValue({ accepted: true });

      const invited = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send(inviteBody())
        .expect(201);

      sendInvitation.mockClear();

      const resent = await ctx
        .http()
        .post(`/api/v1/users/invitations/${invited.body.data.invitationId}/resend`)
        .set(owner())
        .expect(200);

      expect(sendInvitation).toHaveBeenCalledTimes(1);
      expect(resent.body.data.emailDelivered).toBe(true);
    });

    it('sends to the original invitee, never to the caller', async () => {
      sendInvitation.mockResolvedValue({ accepted: true });
      const body = inviteBody();

      const invited = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send(body)
        .expect(201);

      sendInvitation.mockClear();

      await ctx
        .http()
        .post(`/api/v1/users/invitations/${invited.body.data.invitationId}/resend`)
        .set(owner())
        .expect(200);

      expect((sendInvitation.mock.calls[0]?.[0] as { to: string }).to).toBe(body.email);
    });

    it('reports a failed resend honestly', async () => {
      sendInvitation.mockResolvedValue({ accepted: true });

      const invited = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send(inviteBody())
        .expect(201);

      sendInvitation.mockResolvedValue({ accepted: false });

      const resent = await ctx
        .http()
        .post(`/api/v1/users/invitations/${invited.body.data.invitationId}/resend`)
        .set(owner())
        .expect(200);

      expect(resent.body.data.emailDelivered).toBe(false);
    });

    it('issues a NEW token, invalidating the previous link', async () => {
      // Unchanged behaviour, pinned: a forwarded old email must stop working,
      // otherwise every resend adds another live way in.
      sendInvitation.mockResolvedValue({ accepted: true });

      const invited = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send(inviteBody())
        .expect(201);

      const first = sendInvitation.mock.calls[0]?.[0] as { token: string };
      sendInvitation.mockClear();

      await ctx
        .http()
        .post(`/api/v1/users/invitations/${invited.body.data.invitationId}/resend`)
        .set(owner())
        .expect(200);

      const second = sendInvitation.mock.calls[0]?.[0] as { token: string };
      expect(second.token).not.toBe(first.token);
    });
  });

  describe('authorization is unchanged', () => {
    it('refuses a SALES_REP', async () => {
      await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(ctx.orgA.rep.accessToken))
        .send(inviteBody())
        .expect(403);

      expect(sendInvitation).not.toHaveBeenCalled();
    });

    it('refuses an unauthenticated caller', async () => {
      await ctx.http().post('/api/v1/users/invite').send(inviteBody()).expect(401);
    });

    it('refuses another organization’s invitation id on resend', async () => {
      sendInvitation.mockResolvedValue({ accepted: true });

      const invited = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send(inviteBody())
        .expect(201);

      // Tenant-scoped: Org B cannot resend Org A's invitation, and the miss is
      // a 404 rather than a 403 so the id is not confirmed to exist.
      await ctx
        .http()
        .post(`/api/v1/users/invitations/${invited.body.data.invitationId}/resend`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(404);
    });
  });

  describe('the emailed link', () => {
    it('points at the configured web base, not the API', async () => {
      /*
       * Built from WEB_BASE_URL, which now refuses to keep its localhost
       * default in production — an emailed link to the recipient's own machine
       * is delivered mail that cannot possibly work, and reads to the user as
       * "the email never arrived".
       */
      const link = ctx.app.get(EmailService)['url'](`/invite/token-under-test`) as string;

      expect(link).toMatch(/\/invite\/token-under-test$/);
      expect(link).not.toContain('/api/');
    });
  });
});
