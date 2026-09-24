import { Logger } from '@nestjs/common';
import { ResendEmailProvider } from './resend-email.provider';
import type { EmailMessage } from '../email.types';

/**
 * The HTTPS transport.
 *
 * `fetch` is stubbed, so no request leaves the machine and no address is ever
 * contacted. What is asserted is the shape of what WOULD be sent, how each
 * provider answer is interpreted, and — the part that matters most — that the
 * API key cannot reach a log line.
 */
describe('ResendEmailProvider', () => {
  const API_KEY = 're_test_5up3rs3cr3t_k3y_value';

  const provider = () =>
    new ResendEmailProvider({ apiKey: API_KEY, from: 'LeadFlow <info@cravionventures.com>' });

  const message: EmailMessage = {
    to: { email: 'person@example.test', name: 'A Person' },
    subject: 'Reset your password',
    text: 'plain text body',
    html: '<p>html body</p>',
    tag: 'password-reset',
  };

  /** Everything the logger was asked to write, flattened for inspection. */
  let logged: string[];

  const captureLogs = (): void => {
    logged = [];
    const capture = (...args: unknown[]): undefined => {
      logged.push(args.map((arg) => JSON.stringify(arg)).join(' '));
      return undefined;
    };

    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
  };

  const stubFetch = (implementation: jest.Mock): jest.Mock => {
    (globalThis as { fetch: unknown }).fetch = implementation;
    return implementation;
  };

  const okResponse = (id = 'resend-message-id') =>
    ({ ok: true, status: 200, json: async () => ({ id }) }) as unknown as Response;

  const errorResponse = (status: number, body: Record<string, unknown>) =>
    ({ ok: false, status, json: async () => body }) as unknown as Response;

  const originalFetch = globalThis.fetch;

  beforeEach(() => captureLogs());

  afterEach(() => {
    jest.restoreAllMocks();
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  describe('a successful send', () => {
    it('reports the message as accepted, with the provider id', async () => {
      stubFetch(jest.fn().mockResolvedValue(okResponse('msg-123')));

      const result = await provider().send(message);

      expect(result).toEqual({ accepted: true, messageId: 'msg-123' });
    });

    it('posts to Resend with the configured sender and both bodies', async () => {
      const fetchMock = stubFetch(jest.fn().mockResolvedValue(okResponse()));

      await provider().send(message);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;

      expect(url).toBe('https://api.resend.com/emails');
      expect(init.method).toBe('POST');
      expect(body['from']).toBe('LeadFlow <info@cravionventures.com>');
      expect(body['to']).toEqual(['A Person <person@example.test>']);
      expect(body['subject']).toBe('Reset your password');
      // Both parts: some clients refuse HTML, and text is the accessible form.
      expect(body['text']).toBe('plain text body');
      expect(body['html']).toBe('<p>html body</p>');
    });

    it('sends the key as a bearer header and nowhere else', async () => {
      const fetchMock = stubFetch(jest.fn().mockResolvedValue(okResponse()));

      await provider().send(message);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;

      expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
      // Never in the body, where it would end up in any request log.
      expect(init.body as string).not.toContain(API_KEY);
    });

    it('describes the outcome as accepted, never as delivered', async () => {
      stubFetch(jest.fn().mockResolvedValue(okResponse()));

      await provider().send(message);

      /*
       * Wording is a correctness property here. A 200 means Resend took
       * responsibility for the message; it does not mean a human received it.
       * Logging "delivered" would make a queued-and-bounced message
       * indistinguishable from a read one.
       */
      const line = logged.join(' ');
      expect(line).toMatch(/accepted/i);
      expect(line).not.toMatch(/delivered to inbox|was delivered/i);
    });

    it('sends a bare address when the recipient has no name', async () => {
      const fetchMock = stubFetch(jest.fn().mockResolvedValue(okResponse()));

      await provider().send({ ...message, to: { email: 'plain@example.test' } });

      const body = JSON.parse(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
      ) as { to: string[] };

      expect(body.to).toEqual(['plain@example.test']);
    });
  });

  describe('a rejected message', () => {
    it('reports not accepted on an API error', async () => {
      stubFetch(
        jest.fn().mockResolvedValue(
          errorResponse(422, { name: 'validation_error', message: 'Invalid `to` field' }),
        ),
      );

      const result = await provider().send(message);

      expect(result).toEqual({ accepted: false });
      expect(result.messageId).toBeUndefined();
    });

    it('records the status and the provider’s reason', async () => {
      stubFetch(
        jest.fn().mockResolvedValue(
          errorResponse(403, { name: 'domain_not_verified', message: 'Domain is not verified' }),
        ),
      );

      await provider().send(message);

      const line = logged.join(' ');
      expect(line).toContain('403');
      expect(line).toContain('domain_not_verified');
      // An operator must be able to tell a sender problem from an outage.
      expect(line).toContain('resend');
    });

    it('does not throw, so forgot-password stays enumeration-safe', async () => {
      stubFetch(jest.fn().mockResolvedValue(errorResponse(500, {})));

      // A send failure that became a 500 would rebuild the enumeration oracle
      // the neutral forgot-password response exists to prevent.
      await expect(provider().send(message)).resolves.toEqual({ accepted: false });
    });
  });

  describe('a failed request', () => {
    it('reports not accepted when the network call throws', async () => {
      stubFetch(jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.resend.com')));

      await expect(provider().send(message)).resolves.toEqual({ accepted: false });
    });

    it('names a timeout so it is recognisable in the logs', async () => {
      const timeout = Object.assign(new Error('The operation was aborted'), {
        name: 'TimeoutError',
      });
      stubFetch(jest.fn().mockRejectedValue(timeout));

      await provider().send(message);

      expect(logged.join(' ')).toContain('TimeoutError');
    });
  });

  describe('the API key never reaches a log', () => {
    it('is absent from a successful send', async () => {
      stubFetch(jest.fn().mockResolvedValue(okResponse()));

      await provider().send(message);

      expect(logged.join(' ')).not.toContain(API_KEY);
    });

    it('is redacted when a provider error quotes it back', async () => {
      /*
       * The case worth guarding. An error body is somebody else's free text,
       * and free text is exactly where a credential ends up if it ends up
       * anywhere at all.
       */
      stubFetch(
        jest.fn().mockResolvedValue(
          errorResponse(401, { name: 'unauthorized', message: `Invalid key ${API_KEY}` }),
        ),
      );

      await provider().send(message);

      const line = logged.join(' ');
      expect(line).not.toContain(API_KEY);
      expect(line).toContain('[REDACTED]');
    });

    it('is redacted when a thrown error quotes it back', async () => {
      stubFetch(jest.fn().mockRejectedValue(new Error(`connect failed using ${API_KEY}`)));

      await provider().send(message);

      expect(logged.join(' ')).not.toContain(API_KEY);
    });

    it('redacts a Resend-shaped key that is not ours', async () => {
      const foreign = 're_someone_elses_key_abcdefgh';
      stubFetch(
        jest.fn().mockResolvedValue(errorResponse(401, { name: 'x', message: `key ${foreign}` })),
      );

      await provider().send(message);

      expect(logged.join(' ')).not.toContain(foreign);
    });
  });

  describe('what is safe to log', () => {
    it('records the recipient domain but not the full address', async () => {
      stubFetch(jest.fn().mockResolvedValue(okResponse()));

      await provider().send(message);

      const line = logged.join(' ');
      expect(line).toContain('example.test');
      // The local part is the person; the domain is enough to diagnose.
      expect(line).not.toContain('person@example.test');
    });

    it('never records the message body', async () => {
      stubFetch(jest.fn().mockResolvedValue(okResponse()));

      await provider().send({
        ...message,
        text: 'reset link https://leadflow.cravionventures.com/reset-password/SECRET-TOKEN',
        html: '<a href="https://leadflow.cravionventures.com/reset-password/SECRET-TOKEN">x</a>',
      });

      // A reset link in a log is a live credential in a log aggregator.
      const line = logged.join(' ');
      expect(line).not.toContain('SECRET-TOKEN');
      expect(line).not.toContain('reset-password');
    });
  });
});
