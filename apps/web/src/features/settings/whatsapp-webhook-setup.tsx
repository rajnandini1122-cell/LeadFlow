import { useState } from 'react';
import { apiBaseUrl } from '../../lib/platform';

/**
 * The values to type into Meta's WhatsApp → Configuration → Webhook screen.
 *
 * Read-only on purpose. The setup guide said "use the callback URL and verify
 * token from your deployment" without saying what either was, so an admin had
 * to find the route in the source (2026-10-30, configuring Meta app
 * 1596224018290106).
 *
 * The callback URL is DERIVED from the API base this build talks to — never
 * typed in — so it is right on every deployment: relative `/api/v1` on the web
 * resolves against the site's own origin; the Android build carries its
 * absolute production address.
 *
 * The verify token is deliberately NOT shown. It is one value for the whole
 * deployment (Railway `WHATSAPP_VERIFY_TOKEN`), so displaying it to one
 * organization would hand every organization's webhook secret to anybody who
 * can open Settings. The same goes for the app secret and access tokens.
 */
export function whatsappCallbackUrl(): string {
  return new URL(`${apiBaseUrl()}/webhooks/whatsapp`, window.location.origin).href;
}

export function WhatsAppWebhookSetup(): React.JSX.Element {
  const url = whatsappCallbackUrl();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('copied');
    } catch {
      // No clipboard (older WebView, insecure context): the URL is selectable.
      setCopied('failed');
    }
  };

  return (
    <section aria-labelledby="wa-webhook-heading" className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <h3 id="wa-webhook-heading" className="text-sm font-semibold text-slate-900">
        Webhook setup
      </h3>
      <p className="text-sm text-pretty text-slate-600">
        In your Meta app, open <strong>WhatsApp › Configuration › Webhook</strong> and enter these. Without them,
        LeadFlow can send messages but never receives replies.
      </p>

      <div>
        <label htmlFor="wa-callback-url" className="mb-1 block text-xs font-medium text-slate-700">
          Callback URL
        </label>
        <div className="flex gap-2">
          <input
            id="wa-callback-url"
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-800"
          />
          <button
            type="button"
            onClick={() => void copy()}
            className="min-h-11 shrink-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            {copied === 'copied' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p role="status" aria-live="polite" className="mt-1 text-xs text-slate-500">
          {copied === 'copied'
            ? 'Callback URL copied.'
            : copied === 'failed'
              ? 'Could not copy automatically — select the URL and copy it.'
              : ''}
        </p>
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        <dt className="text-xs font-medium text-slate-700">Verify token</dt>
        <dd className="text-slate-600">
          Managed by your LeadFlow administrator, and never shown here. Ask them for it; it must match exactly.
        </dd>
        <dt className="text-xs font-medium text-slate-700">Webhook fields</dt>
        <dd className="text-slate-600">
          Subscribe to <code className="rounded bg-white px-1 py-0.5 text-xs">messages</code> — it carries both incoming
          messages and delivery receipts.
        </dd>
      </dl>

      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>Save and verify your Phone number ID and access token below, so LeadFlow knows this number is yours.</li>
        <li>
          In Meta, paste the Callback URL and the verify token, then choose <strong>Verify and save</strong>.
        </li>
        <li>
          Under <strong>Webhook fields</strong>, subscribe to <strong>messages</strong>.
        </li>
        <li>Send a WhatsApp message to your business number — it should appear in LeadFlow’s inbox within seconds.</li>
      </ol>
    </section>
  );
}
