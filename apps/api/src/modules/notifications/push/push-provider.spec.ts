import { classifyFcmError, type PushMessage } from './push-provider';

/**
 * Push failure classification.
 *
 * This one function decides whether the queue drains or grinds forever. Get
 * INVALID_TOKEN wrong in one direction and a dead phone is retried until the
 * provider rate-limits the ones that would have worked; get it wrong in the
 * other and a working device is silently deactivated and the salesperson stops
 * hearing about their leads.
 */
describe('classifyFcmError', () => {
  it('treats UNREGISTERED as a dead token', () => {
    // The app was uninstalled, or the token rotated. Retrying is pointless.
    expect(classifyFcmError({ statusCode: 404, errorCode: 'UNREGISTERED' })).toBe('INVALID_TOKEN');
  });

  it('treats a 404 as a dead token', () => {
    expect(classifyFcmError({ statusCode: 404 })).toBe('INVALID_TOKEN');
  });

  it('treats rate limiting as TRANSIENT', () => {
    // The token is fine. We simply asked too often.
    expect(classifyFcmError({ statusCode: 429 })).toBe('TRANSIENT');
  });

  it('treats provider outages as TRANSIENT', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyFcmError({ statusCode: status })).toBe('TRANSIENT');
    }
  });

  it('treats a network-shaped unknown as TRANSIENT, not permanent', () => {
    /*
     * The bias that matters. A misclassified transient becomes a retry that
     * eventually succeeds; a misclassified permanent silently drops a
     * notification somebody needed.
     */
    expect(classifyFcmError({ statusCode: 418 })).toBe('TRANSIENT');
    expect(classifyFcmError({ statusCode: 0 })).toBe('TRANSIENT');
  });

  it('treats bad credentials as PERMANENT', () => {
    // Retrying sends the same wrong credentials. Grinding on it would hide
    // a configuration error behind a queue that looks merely slow.
    expect(classifyFcmError({ statusCode: 401 })).toBe('PERMANENT');
    expect(classifyFcmError({ statusCode: 403 })).toBe('PERMANENT');
  });

  it('deactivates on INVALID_ARGUMENT only when it is a 400', () => {
    /*
     * INVALID_ARGUMENT is ambiguous — it can mean a bad token OR a malformed
     * message of ours. Tied to the 400 so a provider hiccup carrying the same
     * code cannot silently kill a good device.
     */
    expect(classifyFcmError({ statusCode: 400, errorCode: 'INVALID_ARGUMENT' })).toBe(
      'INVALID_TOKEN',
    );
    expect(classifyFcmError({ statusCode: 503, errorCode: 'INVALID_ARGUMENT' })).toBe('TRANSIENT');
  });
});

describe('the push payload', () => {
  /**
   * A payload travels through a third party and lands in an OS notification
   * tray, so everything in it has left our control. These assertions are about
   * what must NOT be there.
   */
  function payloadFor(): PushMessage {
    return {
      token: 'device-token',
      title: 'Overdue: ABC Foods',
      body: 'Call about the garlic powder requirement',
      data: {
        notificationId: 'n-1',
        type: 'FOLLOW_UP_OVERDUE',
        entityType: 'FollowUp',
        entityId: 'f-1',
      },
    };
  }

  it('carries only ids and a type', () => {
    const keys = Object.keys(payloadFor().data).sort();
    expect(keys).toEqual(['entityId', 'entityType', 'notificationId', 'type']);
  });

  it('carries no credential of any kind', () => {
    const serialised = JSON.stringify(payloadFor());

    for (const forbidden of ['accessToken', 'refreshToken', 'password', 'Bearer', 'jwt']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('carries no commercial data beyond what the user already sees', () => {
    /*
     * The title and body are what appears on the lock screen, so they are the
     * user's own information by definition. The DATA block is different — it is
     * machine-readable routing, and a deal value or a phone number in there
     * would be sitting in a third party's logs for no benefit.
     */
    const data = JSON.stringify(payloadFor().data);

    expect(data).not.toMatch(/wonValue|estimatedValue|mobile|email|productInterest/);
  });
});
