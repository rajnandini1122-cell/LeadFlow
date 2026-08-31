import { HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from './app.exception';

/**
 * What an unexpected error tells the caller.
 *
 * This exists because the masking is a SECURITY PROPERTY resting on a single
 * boolean, and nothing was asserting it. A refactor that inverted or dropped
 * that ternary would have shipped absolute filesystem paths, source excerpts,
 * internal method names and the ORM in use — to an unauthenticated caller, from
 * a public endpoint — and every other suite would still have passed.
 *
 * The development behaviour is deliberate and useful. The production behaviour
 * is the one that needs a guard.
 */
describe('AllExceptionsFilter', () => {
  /** Captures what would have been sent, without an HTTP server. */
  function harness() {
    const sent: { status?: number; body?: unknown } = {};

    const response = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
        return this;
      },
    };

    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ id: 'req-1', method: 'GET', url: '/api/v1/plans' }),
      }),
    } as unknown as ArgumentsHost;

    return { host, sent };
  }

  /**
   * A realistic leak. This is the shape a Prisma failure actually produced:
   * the absolute path, the source lines around the call, and the ORM.
   */
  const leakyError = new Error(
    'Invalid `this.prisma.client.plan.findMany()` invocation in\n' +
      'C:\\Shivaji_Personal\\App Dev\\idea001\\apps\\api\\src\\modules\\subscriptions\\' +
      'subscriptions.repository.ts:46:36\n\n  45 async activePlans() {\n' +
      'Server has closed the connection.',
  );

  describe('in production', () => {
    it('reveals NOTHING about an unexpected error', () => {
      const { host, sent } = harness();

      new AllExceptionsFilter(true).catch(leakyError, host);

      const body = sent.body as { error: { code: string; message: string } };

      expect(sent.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('An unexpected error occurred.');
    });

    it('leaks no path, no source, no ORM, no host', () => {
      // Asserted against the WHOLE serialised response, not one field — a
      // future change that moved detail into `details` would slip past a
      // narrower check.
      const { host, sent } = harness();

      new AllExceptionsFilter(true).catch(leakyError, host);

      const serialised = JSON.stringify(sent.body);

      for (const forbidden of [
        'Shivaji_Personal',
        'subscriptions.repository',
        'prisma',
        'activePlans',
        'findMany',
        '5433',
      ]) {
        expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });

    it('still returns the request id, so the real error is findable in logs', () => {
      /*
       * The point of masking is to move detail to the logs, not to destroy it.
       * Without a correlation id the caller cannot report anything actionable
       * and support cannot find it.
       */
      const { host, sent } = harness();

      new AllExceptionsFilter(true).catch(leakyError, host);

      const body = sent.body as { meta: { requestId: string } };
      expect(body.meta.requestId).toBe('req-1');
    });

    it('does NOT mask a deliberate application error', () => {
      /*
       * Masking applies to the UNEXPECTED. An AppException is a message we
       * wrote for the caller — hiding it would turn every validation failure
       * into an unactionable 500.
       */
      const { host, sent } = harness();

      new AllExceptionsFilter(true).catch(
        AppException.validation('Schedule the next follow-up, or mark the lead won or lost.'),
        host,
      );

      const body = sent.body as { error: { code: string; message: string } };

      expect(sent.status).toBe(HttpStatus.BAD_REQUEST);
      expect(body.error.message).toContain('Schedule the next follow-up');
    });

    it('keeps a 404 indistinguishable from another tenant', () => {
      // The enumeration-oracle property, asserted where the response is built.
      const { host, sent } = harness();

      new AllExceptionsFilter(true).catch(AppException.leadNotFound(), host);

      const body = sent.body as { error: { code: string; message: string } };

      expect(sent.status).toBe(HttpStatus.NOT_FOUND);
      expect(body.error.message).toBe('Lead not found.');
    });
  });

  describe('in development', () => {
    it('DOES surface the detail, which is the point of development', () => {
      const { host, sent } = harness();

      new AllExceptionsFilter(false).catch(leakyError, host);

      const body = sent.body as { error: { message: string } };
      expect(body.error.message).toContain('findMany');
    });
  });
});
