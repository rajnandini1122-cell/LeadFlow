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

  describe('other channels', () => {
    it.each(['INSTAGRAM', 'FACEBOOK'] as const)('refuses %s in this phase', (channel) => {
      const result = capability({ channel });

      expect(result.canSend).toBe(false);
      expect(result.sendDisabledReason).toMatch(/not available for this channel/i);
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
