import { useEffect, useState, type FormEvent } from 'react';
import type { MailboxView, MailSecurity } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { formatDateTime } from '../../lib/format';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import {
  useMailbox,
  useMailboxSending,
  useSaveMailbox,
  useTestMailbox,
  type MailboxInput,
} from './use-email';
import { SendingProviderCard } from './sending-provider-card';

const SECURITY_LABELS: Record<MailSecurity, string> = {
  SSL_TLS: 'SSL / TLS (recommended)',
  STARTTLS: 'STARTTLS',
};
interface MailProviderPreset {
  id: string;
  label: string;
  host: (domain: string) => string;
  imapPort: number;
  imapSecurity: MailSecurity;
  smtpPort: number;
  smtpSecurity: MailSecurity;
}

/**
 * Published settings for common providers. A preset only fills the form; the
 * server still validates the hostname (public address only) and verifies TLS.
 */
export const MAIL_PROVIDER_PRESETS: MailProviderPreset[] = [
  {
    // Verified for sales@cravionventures.com: Dovecot IMAP 993 and Exim SMTP 465,
    // implicit TLS, certificate *.cravionventures.com.
    id: 'hostingraja',
    label: 'HostingRaja (cPanel) — mail.yourdomain, SSL/TLS',
    host: (domain) => (domain ? `mail.${domain}` : ''),
    imapPort: 993,
    imapSecurity: 'SSL_TLS',
    smtpPort: 465,
    smtpSecurity: 'SSL_TLS',
  },
  {
    id: 'cpanel',
    label: 'Other cPanel hosting — mail.yourdomain, SSL/TLS',
    host: (domain) => (domain ? `mail.${domain}` : ''),
    imapPort: 993,
    imapSecurity: 'SSL_TLS',
    smtpPort: 465,
    smtpSecurity: 'SSL_TLS',
  },
];

/** The port each secure connection type uses. Changing one changes the other. */
const PORTS = {
  imap: { SSL_TLS: 993, STARTTLS: 143 },
  smtp: { SSL_TLS: 465, STARTTLS: 587 },
} as const;

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:ring-1 focus:ring-slate-900 focus:outline-none disabled:bg-slate-50';

/**
 * Email settings: the account exactly as a mail client shows it — address,
 * description, IMAP and SMTP hostname, port and secure connection type, and the
 * password. The password is never shown again after saving.
 */
export function EmailSettingsPage(): React.JSX.Element {
  const mailbox = useMailbox();
  return (
    <>
      <PageHeader
        title="Email account"
        subtitle="The mailbox campaigns are sent from, and where replies are read"
      />
      {mailbox.isLoading && <SkeletonRows rows={6} />}
      {mailbox.error && <ErrorNotice message={(mailbox.error as Error).message} />}
      {mailbox.data && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <AccountForm view={mailbox.data} />
          <div className="space-y-6">
            <ConnectionCard view={mailbox.data} />
            <SendingProviderCard view={mailbox.data} />
            <SendingCard view={mailbox.data} />
          </div>
        </div>
      )}
    </>
  );
}

function AccountForm({ view }: { view: MailboxView }): React.JSX.Element {
  const save = useSaveMailbox();
  const [form, setForm] = useState<MailboxInput>(() => fromView(view));
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(fromView(view)), [view]);

  const set = <K extends keyof MailboxInput>(key: K, value: MailboxInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setSecurity = (protocol: 'imap' | 'smtp', security: MailSecurity) =>
    setForm((f) =>
      protocol === 'imap'
        ? { ...f, imapSecurity: security, imapPort: PORTS.imap[security] }
        : { ...f, smtpSecurity: security, smtpPort: PORTS.smtp[security] },
    );

  /** Fills the server fields from a provider's published settings. Nothing is saved until Save. */
  const applyPreset = (preset: MailProviderPreset) => {
    const domain = form.emailAddress.split('@')[1]?.trim().toLowerCase() ?? '';
    const host = preset.host(domain);
    setForm((f) => ({
      ...f,
      imapHost: host,
      imapPort: preset.imapPort,
      imapSecurity: preset.imapSecurity,
      smtpHost: host,
      smtpPort: preset.smtpPort,
      smtpSecurity: preset.smtpSecurity,
    }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    save.mutate(
      {
        ...form,
        ...(form.description ? {} : { description: '' }),
        ...(password ? { password } : {}),
      },
      {
        onSuccess: () => {
          setPassword('');
          setSaved(true);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader
        title="Your account"
        subtitle={view.configured ? (view.emailAddress ?? undefined) : 'Not connected yet'}
      />
      <form onSubmit={submit} className="divide-y divide-slate-100" noValidate>
        <section className="space-y-4 p-5">
          <h3 className="text-sm font-semibold text-slate-900">Account details</h3>
          <Labelled
            id="provider"
            label="Mail provider"
            hint="Optional. Fills in the server settings below from the provider's published values."
          >
            <select
              id="provider"
              className={inputClass}
              value=""
              onChange={(e) => {
                const preset = MAIL_PROVIDER_PRESETS.find((p) => p.id === e.target.value);
                if (preset) applyPreset(preset);
              }}
            >
              <option value="">Choose to fill in…</option>
              {MAIL_PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled id="emailAddress" label="Email address">
            <input
              id="emailAddress"
              type="email"
              autoComplete="off"
              className={inputClass}
              value={form.emailAddress}
              onChange={(e) => set('emailAddress', e.target.value)}
              placeholder="sales@yourcompany.com"
              required
            />
          </Labelled>
          <Labelled id="description" label="Account description" hint="Optional, for your team.">
            <input
              id="description"
              className={inputClass}
              value={form.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Add an account description"
              maxLength={200}
            />
          </Labelled>
          <Labelled
            id="password"
            label="Password"
            hint={
              view.passwordSet
                ? 'Saved. Leave empty to keep it. It is never shown again.'
                : 'Your mailbox password, or an app password if your provider requires one.'
            }
          >
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={view.passwordSet ? '••••••••' : ''}
            />
          </Labelled>
        </section>

        <ServerSection
          title="IMAP configuration"
          protocol="imap"
          host={form.imapHost}
          port={form.imapPort}
          security={form.imapSecurity}
          onHost={(v) => set('imapHost', v)}
          onSecurity={(s) => setSecurity('imap', s)}
        />
        <ServerSection
          title="SMTP configuration"
          protocol="smtp"
          host={form.smtpHost}
          port={form.smtpPort}
          security={form.smtpSecurity}
          onHost={(v) => set('smtpHost', v)}
          onSecurity={(s) => setSecurity('smtp', s)}
        />

        <div className="space-y-3 p-5">
          {save.error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {save.error instanceof ApiError ? save.error.message : 'Could not save the account.'}
            </p>
          )}
          {saved && (
            <p
              role="status"
              className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            >
              Saved. Test both connections before turning sending on.
            </p>
          )}
          <button
            type="submit"
            disabled={save.isPending}
            className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save account'}
          </button>
        </div>
      </form>
    </Card>
  );
}

function ServerSection(props: {
  title: string;
  protocol: 'imap' | 'smtp';
  host: string;
  port: number;
  security: MailSecurity;
  onHost: (value: string) => void;
  onSecurity: (value: MailSecurity) => void;
}): React.JSX.Element {
  const id = props.protocol;
  return (
    <section className="space-y-4 p-5">
      <h3 className="text-sm font-semibold text-slate-900">{props.title}</h3>
      <Labelled id={`${id}Host`} label="Hostname">
        <input
          id={`${id}Host`}
          className={inputClass}
          value={props.host}
          onChange={(e) => props.onHost(e.target.value.trim())}
          placeholder={`mail.yourcompany.com`}
          autoComplete="off"
        />
      </Labelled>
      <div className="grid grid-cols-[120px_1fr] gap-4">
        <Labelled id={`${id}Port`} label="Port">
          <input id={`${id}Port`} className={inputClass} value={props.port} readOnly disabled />
        </Labelled>
        <Labelled id={`${id}Security`} label="Secure connection type">
          <select
            id={`${id}Security`}
            className={inputClass}
            value={props.security}
            onChange={(e) => props.onSecurity(e.target.value as MailSecurity)}
          >
            {(Object.keys(SECURITY_LABELS) as MailSecurity[]).map((s) => (
              <option key={s} value={s}>
                {SECURITY_LABELS[s]}
              </option>
            ))}
          </select>
        </Labelled>
      </div>
    </section>
  );
}

function ConnectionCard({ view }: { view: MailboxView }): React.JSX.Element {
  const test = useTestMailbox();
  const [result, setResult] = useState<{ kind: string; ok: boolean; message: string } | null>(null);
  const run = (kind: 'smtp' | 'imap') =>
    test.mutate(kind, {
      onSuccess: (r) => setResult({ kind: kind.toUpperCase(), ok: r.ok, message: r.message }),
      onError: (e) =>
        setResult({
          kind: kind.toUpperCase(),
          ok: false,
          message: e instanceof ApiError ? e.message : 'The test could not run.',
        }),
    });
  return (
    <Card>
      <CardHeader
        title="Connection"
        subtitle="Tests sign in only. No email is sent; the inbox is opened read-only."
      />
      <div className="space-y-3 p-5 text-sm">
        <StatusLine label="SMTP (sending)" okAt={view.smtp.okAt} error={view.smtp.error} />
        <StatusLine label="IMAP (replies)" okAt={view.imap.okAt} error={view.imap.error} />
        <p className="text-xs text-slate-500">
          Last reply check: {view.sync.at ? formatDateTime(view.sync.at) : 'not yet'}
          {view.sync.error ? ` — ${view.sync.error}` : ''}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!view.configured || test.isPending}
            onClick={() => run('smtp')}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Test SMTP
          </button>
          <button
            type="button"
            disabled={!view.configured || test.isPending}
            onClick={() => run('imap')}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Test IMAP
          </button>
        </div>
        {test.isPending && <p className="text-xs text-slate-500">Connecting…</p>}
        {result && (
          <p
            role="status"
            className={`rounded-lg px-3 py-2 text-sm ${result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}
          >
            {result.kind}: {result.message}
          </p>
        )}
      </div>
    </Card>
  );
}

function SendingCard({ view }: { view: MailboxView }): React.JSX.Element {
  const sending = useMailboxSending();
  const [hourly, setHourly] = useState(view.hourlyLimit);
  const [daily, setDaily] = useState(view.dailyLimit);
  useEffect(() => {
    setHourly(view.hourlyLimit);
    setDaily(view.dailyLimit);
  }, [view.hourlyLimit, view.dailyLimit]);
  const { tested, missing } = campaignReadiness(view);
  return (
    <Card>
      <CardHeader title="Sending" subtitle="Keep limits below your mail provider’s" />
      <div className="space-y-3 p-5 text-sm">
        {!view.platform.sendingEnabled && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Email sending is not enabled on this LeadFlow server yet. You can set up the account and
            draft campaigns. Test emails and customer campaigns need the platform sending switches
            to be turned on (and your address approved for sending).
          </p>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={view.enabled}
            disabled={!tested || sending.isPending}
            onChange={(e) => sending.mutate({ enabled: e.target.checked })}
          />
          <span>Use this account for campaigns</span>
        </label>
        {!tested && <p className="text-xs text-slate-500">Available after {missing}.</p>}
        <div className="grid grid-cols-2 gap-3">
          <Labelled id="hourly" label="Per hour">
            <input
              id="hourly"
              type="number"
              min={1}
              max={1000}
              className={inputClass}
              value={hourly}
              onChange={(e) => setHourly(Number(e.target.value))}
            />
          </Labelled>
          <Labelled id="daily" label="Per day">
            <input
              id="daily"
              type="number"
              min={1}
              max={10000}
              className={inputClass}
              value={daily}
              onChange={(e) => setDaily(Number(e.target.value))}
            />
          </Labelled>
        </div>
        <button
          type="button"
          disabled={!view.configured || sending.isPending}
          onClick={() => sending.mutate({ hourlyLimit: hourly, dailyLimit: daily })}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
        >
          Save limits
        </button>
        {sending.error && (
          <p role="alert" className="text-xs text-red-700">
            {sending.error instanceof ApiError ? sending.error.message : 'Could not update.'}
          </p>
        )}
      </div>
    </Card>
  );
}

function StatusLine({
  label,
  okAt,
  error,
}: {
  label: string;
  okAt: string | null;
  error: string | null;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-slate-700">{label}</span>
      <span
        className={`text-right text-xs ${okAt ? 'text-emerald-700' : error ? 'text-red-700' : 'text-slate-500'}`}
      >
        {okAt ? `Working · ${formatDateTime(okAt)}` : error ? error : 'Not tested'}
      </span>
    </div>
  );
}

function Labelled({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function fromView(view: MailboxView): MailboxInput {
  return {
    emailAddress: view.emailAddress ?? '',
    description: view.description ?? '',
    imapHost: view.imapHost ?? '',
    imapPort: view.imapPort ?? 993,
    imapSecurity: view.imapSecurity ?? 'SSL_TLS',
    smtpHost: view.smtpHost ?? '',
    smtpPort: view.smtpPort ?? 465,
    smtpSecurity: view.smtpSecurity ?? 'SSL_TLS',
  };
}

/**
 * Mirrors the server (MailboxService.setSending): replies always need IMAP;
 * sending needs the SMTP test for SMTP, or the Resend test with a verified
 * sending domain for Resend. SMTP is not required when Resend sends.
 */
export function campaignReadiness(view: MailboxView): { tested: boolean; missing: string } {
  const needs: string[] = [];
  if (!view.imap.okAt) needs.push('the IMAP (replies) test succeeds');
  if (view.sendingProvider === 'RESEND') {
    if (!view.provider.okAt) needs.push('the Resend test succeeds');
    if (!view.resend.domainVerifiedAt) needs.push('the sending domain is verified in Resend');
  } else if (!view.smtp.okAt) {
    needs.push('the SMTP (sending) test succeeds');
  }
  return { tested: needs.length === 0, missing: needs.join(' and ') };
}
