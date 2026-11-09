import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../common/config/config.module';

/** The parts of a Razorpay payment LeadFlow acts on. */
export interface RazorpayPayment {
  id: string;
  order_id: string | null;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed' | string;
  amount: number;
  currency: string;
  amount_refunded: number;
  error_description?: string | null;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

/** Constant-time comparison of two hex HMACs (false on any length mismatch). */
export function hexEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Razorpay Checkout's signature: HMAC-SHA256(order_id + "|" + payment_id, key_secret). */
export function checkoutSignatureValid(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return hexEquals(expected, signature);
}

/** Razorpay webhook signature: HMAC-SHA256(raw body, webhook secret). */
export function webhookSignatureValid(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return hexEquals(expected, signature);
}

/**
 * Minimal Razorpay REST client: create an order, read a payment, read an
 * order's payments. Server-side only, Basic auth from the environment. The
 * secret is never logged and never leaves this process; error messages carry
 * Razorpay's error code and description only.
 */
@Injectable()
export class RazorpayClient {
  private static readonly BASE = 'https://api.razorpay.com/v1';
  private static readonly TIMEOUT_MS = 10_000;

  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.get('RAZORPAY_KEY_ID') && this.config.get('RAZORPAY_KEY_SECRET'));
  }

  /** The public key id, which Razorpay Checkout needs in the browser. Never the secret. */
  get keyId(): string {
    return this.config.get('RAZORPAY_KEY_ID') ?? '';
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    const secret = this.config.get('RAZORPAY_KEY_SECRET');
    return Boolean(secret) && checkoutSignatureValid(orderId, paymentId, signature, secret as string);
  }

  createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<RazorpayOrder> {
    return this.request<RazorpayOrder>('POST', '/orders', {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
    });
  }

  /** Captures an authorized payment for exactly its order amount. */
  capture(paymentId: string, amountPaise: number, currency: string): Promise<RazorpayPayment> {
    return this.request<RazorpayPayment>('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, {
      amount: amountPaise,
      currency,
    });
  }

  fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    return this.request<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
  }

  async fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]> {
    const page = await this.request<{ items: RazorpayPayment[] }>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/payments`,
    );
    return page.items ?? [];
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const id = this.config.get('RAZORPAY_KEY_ID');
    const secret = this.config.get('RAZORPAY_KEY_SECRET');
    if (!id || !secret) throw new RazorpayError('NOT_CONFIGURED', 'Razorpay is not configured.', 0);
    const response = await fetch(`${RazorpayClient.BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(RazorpayClient.TIMEOUT_MS),
    });
    const json = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; description?: string };
    };
    if (!response.ok) {
      throw new RazorpayError(
        json.error?.code ?? 'HTTP_ERROR',
        (json.error?.description ?? `Razorpay answered ${response.status}`).slice(0, 200),
        response.status,
      );
    }
    return json as T;
  }
}

export class RazorpayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}
