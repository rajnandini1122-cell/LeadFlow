import { useEffect, useState } from 'react';
import type { MailboxView } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { formatDateTime } from '../../lib/format';
import { Card, CardHeader } from '../../components/ui';
import { useSaveProvider, useTestMailbox } from './use-email';

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:ring-1 focus:ring-slate-900 focus:outline-none';

/**
 * How campaign mail is sent: through the mailbox's SMTP server, or through a
 * dedicated Resend marketing account (Broadcasts for promotions, single emails
 * for service messages). Replies are read over IMAP either way. The API key
 * and webhook secret are write-only.
 */
export function SendingProviderCard({ view }: { view: MailboxView }): React.JSX.Element | null {
  const save = useSaveProvider();
  const test = useTestMailbox();
  const [provider, setProvider] = useState(view.sendingProvider);
  const [fromAddress, setFromAddress] = useState(view.fromAddress ?? '');
  const [apiKey, setApiKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    setProvider(view.sendingProvider);
    setFromAddress(view.fromAddress ?? '');
  }, [view.sendingProvider, view.fromAddress]);

  if (!view.configured) return null;
  const resend = provider === 'RESEND';

  const submit = () =>
    save.mutate(
      {
        provider,
        ...(resend && fromAddress ? { fromAddress } : {}),
        ...(resend && apiKey ? { apiKey } : {}),
        ...(resend && webhookSecret ? { webhookSecret } : {}),
      },
      {
        onSuccess: () => {
          setApiKey('');
          setWebhookSecret('');
        },
      },
    );

  return (
    <Card>
      <CardHeader
        title="How campaigns are sent"
        subtitle="Replies are always read from your inbox (IMAP)"
      />
      <div className="space-y-3 p-5 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={!resend} onChange={() => setProvider('SMTP')} /> This mailbox
          (SMTP)
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={resend} onChange={() => setProvider('RESEND')} /> Resend
          (dedicated marketing account)
        </label>
        {resend && (
          <div className="space-y-3 rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-600">
              Use a separate Resend account for marketing — never the one that sends sign-in and
              password emails. Promotions go out as Resend Broadcasts; service messages one by one.
            </p>
            <div>
              <label
                htmlFor="fromAddress"
                className="mb-1 block text-xs font-medium text-slate-700"
              >
                From address (verified sending domain)
              </label>
              <input
                id="fromAddress"
                className={inputClass}
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value.trim())}
                placeholder="news@news.yourcompany.com"
              />
            </div>
            <div>
              <label htmlFor="apiKey" className="mb-1 block text-xs font-medium text-slate-700">
                Resend API key (full access, marketing account)
              </label>
              <input
                id="apiKey"
                type="password"
                autoComplete="off"
                className={inputClass}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value.trim())}
                placeholder={
                  view.resend.apiKeySet
                    ? `Saved (…${view.resend.apiKeyHint ?? ''}). Leave empty to keep.`
                    : 're_…'
                }
              />
            </div>
            <div>
              <label
                htmlFor="webhookSecret"
                className="mb-1 block text-xs font-medium text-slate-700"
              >
                Webhook signing secret
              </label>
              <input
                id="webhookSecret"
                type="password"
                autoComplete="off"
                className={inputClass}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value.trim())}
                placeholder={
                  view.resend.webhookSecretSet ? 'Saved. Leave empty to keep.' : 'whsec_…'
                }
              />
            </div>
            {view.resend.webhookUrl && (
              <p className="text-xs text-slate-600">
                Webhook URL for Resend (events: email.*, contact.updated):
                <code className="mt-1 block break-all rounded bg-white px-2 py-1 text-slate-800">
                  {view.resend.webhookUrl}
                </code>
              </p>
            )}
            <ul className="space-y-0.5 text-xs text-slate-600">
              <li>
                Sending domain verified:{' '}
                {view.resend.domainVerifiedAt
                  ? formatDateTime(view.resend.domainVerifiedAt)
                  : 'not yet'}
              </li>
              <li>
                Last webhook received:{' '}
                {view.resend.lastWebhookAt ? formatDateTime(view.resend.lastWebhookAt) : 'none yet'}
              </li>
              {view.provider.error && <li className="text-red-700">{view.provider.error}</li>}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={save.isPending}
            onClick={submit}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
          {view.sendingProvider === 'RESEND' && (
            <button
              type="button"
              disabled={test.isPending}
              onClick={() =>
                test.mutate('provider', {
                  onSuccess: (r) => setResult({ ok: r.ok, message: r.message }),
                  onError: (e) =>
                    setResult({
                      ok: false,
                      message: e instanceof ApiError ? e.message : 'The test could not run.',
                    }),
                })
              }
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
            >
              Test Resend
            </button>
          )}
        </div>
        {save.error && (
          <p role="alert" className="text-xs text-red-700">
            {save.error instanceof ApiError ? save.error.message : 'Could not save.'}
          </p>
        )}
        {result && (
          <p
            role="status"
            className={`rounded-lg px-3 py-2 text-xs ${result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}
          >
            {result.message}
          </p>
        )}
      </div>
    </Card>
  );
}
