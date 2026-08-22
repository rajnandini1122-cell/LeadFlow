import { nextDeliveryStatus, parseProviderStatus } from './message-status';

/**
 * Delivery status progression.
 *
 * Meta gives no ordering guarantee and redelivers freely, so these cases are
 * about events arriving in the wrong order or twice. Downgrading a read message
 * to delivered would have a salesperson chase something already answered.
 */

describe('nextDeliveryStatus', () => {
  describe('normal progression', () => {
    it.each([
      ['PENDING', 'SENT'],
      ['SENT', 'DELIVERED'],
      ['DELIVERED', 'READ'],
      ['PENDING', 'READ'],
      ['SENT', 'READ'],
    ] as const)('moves %s forward to %s', (current, incoming) => {
      expect(nextDeliveryStatus(current, incoming)).toBe(incoming);
    });
  });

  describe('duplicates', () => {
    it.each(['PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED'] as const)(
      'ignores a repeated %s',
      (status) => {
        expect(nextDeliveryStatus(status, status)).toBeNull();
      },
    );
  });

  describe('out-of-order events', () => {
    it('does NOT downgrade a read message when a late delivered arrives', () => {
      // THE case. Meta routinely delivers these in the wrong order.
      expect(nextDeliveryStatus('READ', 'DELIVERED')).toBeNull();
    });

    it.each([
      ['READ', 'SENT'],
      ['DELIVERED', 'SENT'],
    ] as const)('does not move %s back to %s', (current, incoming) => {
      expect(nextDeliveryStatus(current, incoming)).toBeNull();
    });
  });

  describe('failure', () => {
    it('can overwrite SENT, because a message can fail after acceptance', () => {
      expect(nextDeliveryStatus('SENT', 'FAILED')).toBe('FAILED');
    });

    it('can overwrite PENDING', () => {
      expect(nextDeliveryStatus('PENDING', 'FAILED')).toBe('FAILED');
    });

    it.each(['DELIVERED', 'READ'] as const)('must NOT overwrite %s', (current) => {
      // The customer demonstrably received it. Marking it failed would tell a
      // salesperson to resend something already read.
      expect(nextDeliveryStatus(current, 'FAILED')).toBeNull();
    });

    it.each(['SENT', 'DELIVERED', 'READ'] as const)(
      'does not let a late %s clear an existing failure',
      (incoming) => {
        // A late callback describes an earlier moment, not a new one. Treating
        // it as progress would quietly hide a failure someone needs to see.
        expect(nextDeliveryStatus('FAILED', incoming)).toBeNull();
      },
    );
  });

  describe('unconfirmed', () => {
    it.each(['SENT', 'DELIVERED', 'READ'] as const)(
      'lets a real %s answer replace it',
      (incoming) => {
        // "We do not know" carries no information. Anything definite is better,
        // including news the salesperson will be glad to have.
        expect(nextDeliveryStatus('UNCONFIRMED', incoming)).toBe(incoming);
      },
    );

    it('lets a definite failure replace it', () => {
      expect(nextDeliveryStatus('UNCONFIRMED', 'FAILED')).toBe('FAILED');
    });

    it.each(['SENT', 'DELIVERED', 'READ', 'FAILED', 'PENDING'] as const)(
      'is never reached FROM %s through a provider event',
      (current) => {
        // Only the recovery sweep may write UNCONFIRMED, and only to rows still
        // PENDING. A provider event always knows more than "we do not know".
        expect(nextDeliveryStatus(current, 'UNCONFIRMED')).toBeNull();
      },
    );

    it('ignores a repeat of itself', () => {
      expect(nextDeliveryStatus('UNCONFIRMED', 'UNCONFIRMED')).toBeNull();
    });
  });

  describe('a message with no status yet', () => {
    it('accepts whatever arrives first', () => {
      expect(nextDeliveryStatus(null, 'DELIVERED')).toBe('DELIVERED');
    });
  });
});

describe('parseProviderStatus', () => {
  it.each([
    ['sent', 'SENT'],
    ['delivered', 'DELIVERED'],
    ['read', 'READ'],
    ['failed', 'FAILED'],
  ] as const)('maps %s', (provider, expected) => {
    expect(parseProviderStatus(provider)).toBe(expected);
  });

  it.each(['accepted', 'deleted', 'warning', '', 'SENT', 'unknown-future-status'])(
    'ignores %p rather than guessing',
    (value) => {
      // A status we do not understand must not become one we do.
      expect(parseProviderStatus(value)).toBeNull();
    },
  );
});
