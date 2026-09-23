import { CUSTOMER_SERVICE_WINDOW_MS, evaluateSendCapability } from './send-capability';

/**
 * Whether a reply can be sent.
 *
 * The UI renders a composer only when this says yes, so a false positive lets a
 * salesperson type a reply and watch it fail — and a customer waits while that
 * happens. The negative cases below are the valuable ones.
 */

const NOW = new Date('2026-08-25T12:00:00Z');
const CONNECTED = { status: 'CONNECTED', enabled: true };

function capability(overrides: Partial<Parameters<typeof evaluateSendCapability>[0]> = {}) {
  return evaluateSendCapability({
    channel: 'WHATSAPP',
    integration: CONNECTED,
    lastInboundAt: new Date(NOW.getTime() - 60_000),
    mayReply: true,
    now: NOW,
    ...overrides,
  });
}

describe('evaluateSendCapability', () => {
  it('allows a reply inside the customer service window', () => {
    const result = capability();

    expect(result.canSend).toBe(true);
    expect(result.sendDisabledReason).toBeUndefined();
  });

  it('reports when the window closes, so the UI can warn', () => {
    const lastInboundAt = new Date(NOW.getTime() - 60_000);
    const result = capability({ lastInboundAt });

    expect(result.windowExpiresAt).toBe(
      new Date(lastInboundAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS).toISOString(),
    );
  });

  describe('the 24-hour window', () => {
    it('allows a reply one minute before it closes', () => {
      const lastInboundAt = new Date(NOW.getTime() - CUSTOMER_SERVICE_WINDOW_MS + 60_000);
      expect(capability({ lastInboundAt }).canSend).toBe(true);
    });

    it('refuses one minute after it closes', () => {
      const lastInboundAt = new Date(NOW.getTime() - CUSTOMER_SERVICE_WINDOW_MS - 60_000);
      const result = capability({ lastInboundAt });

      expect(result.canSend).toBe(false);
      // The reason has to explain WHY, or it reads as a bug in LeadFlow rather
      // than a rule of WhatsApp.
      expect(result.sendDisabledReason).toMatch(/24 hours/i);
      expect(result.sendDisabledReason).toMatch(/template/i);
    });

    it('refuses exactly on the boundary', () => {
      const lastInboundAt = new Date(NOW.getTime() - CUSTOMER_SERVICE_WINDOW_MS);
      expect(capability({ lastInboundAt }).canSend).toBe(false);
    });

    it('refuses when the customer has never written', () => {
      // Meta does not permit opening a conversation with a free-form message.
      const result = capability({ lastInboundAt: null });

      expect(result.canSend).toBe(false);
      expect(result.sendDisabledReason).toMatch(/after the customer has messaged/i);
    });
  });

  describe('the integration', () => {
    it('refuses when WhatsApp was never connected', () => {
      const result = capability({ integration: null });

      expect(result.canSend).toBe(false);
      expect(result.sendDisabledReason).toMatch(/not connected/i);
    });

    it('refuses when the channel is switched off', () => {
      const result = capability({ integration: { status: 'CONNECTED', enabled: false } });

      expect(result.canSend).toBe(false);
      expect(result.sendDisabledReason).toMatch(/switched off/i);
    });

    it.each(['CONNECTING', 'DISCONNECTED'])('refuses while the integration is %s', (status) => {
      expect(capability({ integration: { status, enabled: true } }).canSend).toBe(false);
    });

    it('points at settings when the integration is in error', () => {
      const result = capability({ integration: { status: 'ERROR', enabled: true } });

      expect(result.canSend).toBe(false);
      expect(result.sendDisabledReason).toMatch(/needs attention/i);
    });
  });

  describe('permission', () => {
    it('refuses someone who may read but not reply', () => {
      const result = capability({ mayReply: false });

      expect(result.canSend).toBe(false);
      expect(result.sendDisabledReason).toMatch(/permission/i);
    });

    it('checks permission before the integration, so the reason is the useful one', () => {
      // Telling a read-only user that WhatsApp is disconnected sends them to
      // a settings page they cannot act on either.
      const result = capability({ mayReply: false, integration: null });
      expect(result.sendDisabledReason).toMatch(/permission/i);
    });
  });

  describe('the other Meta channels', () => {
    /*
     * UPDATED IN PHASE I.
     *
     * These used to assert that Instagram and Messenger could never send. Both
     * now can, inside the same 24-hour window Meta applies to all three — that
     * window is Meta's rule for each channel independently, not an assumption
     * carried over from WhatsApp.
     */
    it.each(['INSTAGRAM', 'FACEBOOK'] as const)('allows a reply on %s inside the window', (channel) => {
      expect(capability({ channel }).canSend).toBe(true);
    });

    it.each(['INSTAGRAM', 'FACEBOOK'] as const)(
      'refuses %s once the window has closed',
      (channel) => {
        const lastInboundAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
        const result = capability({ channel, lastInboundAt });

        expect(result.canSend).toBe(false);
        expect(result.sendDisabledReason).toMatch(/24 hours/i);
      },
    );

    it('explains the Instagram escape hatch, not the WhatsApp one', () => {
      const lastInboundAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
      const result = capability({ channel: 'INSTAGRAM', lastInboundAt });

      // The window is shared; the reason it cannot be reopened is not. Saying
      // "template" here would send someone looking for a feature Instagram
      // does not have.
      expect(result.sendDisabledReason).toMatch(/human-agent/i);
      expect(result.sendDisabledReason).not.toMatch(/template/i);
    });

    it('explains the WhatsApp escape hatch on WhatsApp', () => {
      const lastInboundAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
      const result = capability({ channel: 'WHATSAPP', lastInboundAt });

      expect(result.sendDisabledReason).toMatch(/template/i);
      expect(result.sendDisabledReason).not.toMatch(/human-agent/i);
    });

    it('refuses a channel with no policy at all', () => {
      const result = capability({ channel: 'TELEGRAM' as never });

      expect(result.canSend).toBe(false);
      expect(result.sendDisabledReason).toMatch(/not available for this channel/i);
    });
  });

  describe('provider text limits', () => {
    it.each([
      ['WHATSAPP', 4096],
      ['INSTAGRAM', 1000],
      ['FACEBOOK', 2000],
    ] as const)('reports the real %s limit of %d', (channel, expected) => {
      // Meta's limits genuinely differ. Reporting one number for all three
      // would have the composer accept a body Instagram then rejects.
      expect(capability({ channel }).maxTextLength).toBe(expected);
    });
  });

  describe('things that must be true before a reply is possible', () => {
    it('refuses when the integration has no stored credential', () => {
      // Reachable after a disconnect, which clears the token but keeps the row.
      const result = capability({
        integration: { status: 'CONNECTED', enabled: true, hasCredential: false },
      });

      expect(result.canSend).toBe(false);
      expect(result.sendDisabledReason).toMatch(/reconnecting/i);
    });

    it('refuses when the conversation has no provider address', () => {
      const result = capability({ hasRecipient: false });

      expect(result.canSend).toBe(false);
      expect(result.sendDisabledReason).toMatch(/no address to reply to/i);
    });

    it('does not require a recipient check to have been made', () => {
      // Callers that only want the policy answer need not resolve one.
      expect(capability({ hasRecipient: undefined }).canSend).toBe(true);
    });
  });

  /*
   * Templates.
   *
   * The whole point of these is that `canSendTemplate` is a SEPARATE answer
   * from `canSend`. If the two ever collapse into one, either the 24-hour rule
   * has been weakened or the way out of a closed window has been lost, and both
   * are things a passing test suite should refuse to let happen quietly.
   */
  describe('templates', () => {
    const CLOSED = new Date(NOW.getTime() - CUSTOMER_SERVICE_WINDOW_MS - 1000);

    it('allows a template once the window has CLOSED', () => {
      const result = capability({ lastInboundAt: CLOSED, hasSendableTemplate: true });

      // Both halves matter: free-form is still refused, and a template is not.
      expect(result.canSend).toBe(false);
      expect(result.canSendTemplate).toBe(true);
    });

    it('does not weaken the free-form rule to make templates work', () => {
      // A regression guard with a specific failure in mind: making
      // canSendTemplate true by relaxing the window check would let a
      // salesperson send a free-form message Meta will refuse.
      const result = capability({ lastInboundAt: CLOSED, hasSendableTemplate: true });

      expect(result.canSend).toBe(false);
      expect(result.sendDisabledReason).toMatch(/24 hours/i);
    });

    it('allows both inside the window, with free-form still the default', () => {
      const result = capability({ hasSendableTemplate: true });

      expect(result.canSend).toBe(true);
      expect(result.canSendTemplate).toBe(true);
    });

    it('allows a template when the customer has never written', () => {
      // The one refusal that does not also refuse templates \u2014 a template is
      // exactly how WhatsApp permits opening a conversation.
      const result = capability({ lastInboundAt: null, hasSendableTemplate: true });

      expect(result.canSend).toBe(false);
      expect(result.canSendTemplate).toBe(true);
    });

    it('refuses when the organization has no approved template', () => {
      const result = capability({ lastInboundAt: CLOSED, hasSendableTemplate: false });

      expect(result.canSendTemplate).toBe(false);
      expect(result.templateDisabledReason).toMatch(/approved in Meta/i);
    });

    it.each(['INSTAGRAM', 'FACEBOOK'] as const)('refuses on %s, which has no templates', (channel) => {
      const result = capability({ channel, lastInboundAt: CLOSED, hasSendableTemplate: true });

      expect(result.canSendTemplate).toBe(false);
      expect(result.templateDisabledReason).toMatch(/only available on WhatsApp/i);
    });

    describe('everything that refuses a reply also refuses a template', () => {
      /*
       * Except the window, which is the entire feature. A template is a way
       * past a closed window \u2014 it is not a way past a missing permission, a
       * disconnected channel, an absent credential or an unknown recipient,
       * and treating it as one would turn the escape hatch into a hole.
       */
      it.each([
        ['no permission', { mayReply: false }],
        ['no integration', { integration: null }],
        ['channel switched off', { integration: { status: 'CONNECTED', enabled: false } }],
        ['not connected', { integration: { status: 'CONNECTING', enabled: true } }],
        ['connection in error', { integration: { status: 'ERROR', enabled: true } }],
        [
          'no stored credential',
          { integration: { status: 'CONNECTED', enabled: true, hasCredential: false } },
        ],
        ['no recipient', { hasRecipient: false }],
      ])('%s', (_label, overrides) => {
        const result = capability({ ...overrides, hasSendableTemplate: true });

        expect(result.canSend).toBe(false);
        expect(result.canSendTemplate).toBe(false);
        expect(result.templateDisabledReason).toBeTruthy();
      });
    });

    it('says nothing about tokens or secrets when it refuses', () => {
      const reason =
        capability({ integration: null, hasSendableTemplate: true }).templateDisabledReason ?? '';

      expect(reason.toLowerCase()).not.toMatch(/token|secret|bearer|credential/);
    });
  });

  describe('what the reasons must never contain', () => {
    it.each([
      [{ integration: null }],
      [{ integration: { status: 'ERROR', enabled: true } }],
      [{ mayReply: false }],
      [{ lastInboundAt: null }],
    ])('says nothing about tokens or secrets for %p', (overrides) => {
      const reason = capability(overrides).sendDisabledReason ?? '';

      expect(reason.toLowerCase()).not.toMatch(/token|secret|bearer|credential/);
    });
  });
});
