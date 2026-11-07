import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  BillingInterval,
  BillingPaymentView,
  BillingSummaryView,
  CheckoutOrderView,
} from '@leadflow/api-types';
import { apiGet, apiPost } from '../../lib/api-client';

export function useBillingSummary(enabled = true): UseQueryResult<BillingSummaryView> {
  return useQuery({
    queryKey: ['billing-summary'],
    queryFn: () => apiGet<BillingSummaryView>('/billing/summary'),
    enabled,
    staleTime: 60_000,
  });
}

interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', handler: (response: { error?: { description?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

/** Loads Razorpay Checkout once, on demand (never on pages that do not take payment). */
export function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SCRIPT}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('Razorpay Checkout could not be loaded.')));
    if (!existing) {
      script.src = CHECKOUT_SCRIPT;
      script.async = true;
      document.body.appendChild(script);
    }
  });
}

/**
 * Pay for a plan: the server creates the order (and sets the amount), Razorpay
 * Checkout collects the payment, and the server verifies it before anything
 * changes. The browser's "success" is only a prompt for that verification.
 */
export function useCheckout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (interval: BillingInterval): Promise<BillingPaymentView | null> => {
      const order = await apiPost<CheckoutOrderView>('/billing/checkout', { interval });
      await loadRazorpay();
      const Razorpay = window.Razorpay;
      if (!Razorpay) throw new Error('Razorpay Checkout is unavailable.');
      const response = await new Promise<RazorpayResponse | null>((resolve, reject) => {
        const checkout = new Razorpay({
          key: order.keyId,
          order_id: order.providerOrderId,
          amount: order.amountPaise,
          currency: order.currency,
          name: 'LeadFlow',
          description: order.description,
          prefill: order.prefill,
          notes: { receipt: order.receipt },
          theme: { color: '#0f172a' },
          handler: (r: RazorpayResponse) => resolve(r),
          modal: { ondismiss: () => resolve(null) },
        });
        checkout.on('payment.failed', (r) => reject(new Error(r.error?.description ?? 'The payment failed.')));
        checkout.open();
      });
      if (!response) return null;
      return apiPost<BillingPaymentView>('/billing/verify', response);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['billing-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['entitlement'] });
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
    },
  });
}
