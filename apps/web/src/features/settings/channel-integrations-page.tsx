import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrganizationDetail } from '@leadflow/api-types';
import { PERMISSIONS } from '@leadflow/api-types';
import { apiGet, apiPatch } from '../../lib/api-client';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useAuth } from '../auth/auth-context';
import { useState, type FormEvent } from 'react';
import {
  CHANNEL_PRESENTATION,
  useConnectWhatsApp,
  useDisconnectWhatsApp,
  useIntegrations,
  useSetIntegrationEnabled,
  type IntegrationView,
} from '../omnichannel/use-conversations';

/**
 * Channel integrations.
 *
 * The honest version of this screen. No provider is implemented yet, so
 * "Connect" is disabled and says why, rather than opening a flow that ends
 * nowhere or — worse — writing a CONNECTED row that means nothing. An owner who
 * believes their WhatsApp number is live stops checking their phone, and that
 * costs them a customer rather than a click.
 *
 * Everything shown is real: a channel with no record reads Not connected, and a
 * channel that has never carried a message shows no activity date rather than
 * an invented one.
 */

const STATUS_PRESENTATION: Record<
  IntegrationView['status'],
  { label: string; tone: string; meaning: string }
> = {
  CONNECTING: {
    label: 'Finishing setup',
    tone: 'bg-sky-50 text-sky-700',
    meaning: 'Configuration was saved but has not been confirmed with Meta yet.',
  },
  NOT_CONNECTED: {
    label: 'Not connected',
    tone: 'bg-slate-100 text-slate-600',
    meaning: 'This channel has never been connected to LeadFlow.',
  },
  CONNECTED: {
    label: 'Connected',
    tone: 'bg-emerald-50 text-emerald-700',
    meaning: 'Credentials are in place and the provider is responding.',
  },
  DISCONNECTED: {
    label: 'Disconnected',
    tone: 'bg-amber-50 text-amber-700',
    meaning: 'The connection was removed. History is kept.',
  },
  ERROR: {
    label: 'Needs attention',
    tone: 'bg-red-50 text-red-700',
    meaning: 'The provider rejected the last request.',
  },
};

export function ChannelIntegrationsPage(): React.JSX.Element {
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.ORG_UPDATE);

  const integrations = useIntegrations();
  const setEnabled = useSetIntegrationEnabled();

  return (
    <>
      <PageHeader
        title="Channel integrations"
        subtitle="Connect the accounts your customers already message you on"
      />

      <div
        role="note"
        className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
      >
        <p className="font-medium">Incoming messages only.</p>
        <p className="mt-1 text-pretty">
          Connected channels capture what customers send you and match it to your leads.
          Replying from LeadFlow is not available yet, so keep answering wherever you do today.
          Instagram and Facebook cannot be connected in this release.
        </p>
      </div>

      <SharedQueueCard canManage={canManage} />

      {integrations.isPending ? (
        <Card>
          <SkeletonRows rows={3} />
        </Card>
      ) : integrations.isError ? (
        <Card>
          <ErrorNotice message="Could not load your channel integrations." />
        </Card>
      ) : (
        <div className="space-y-4">
          {integrations.data.map((integration) => (
            <IntegrationCard
              key={integration.channel}
              integration={integration}
              canManage={canManage}
              busy={setEnabled.isPending}
              onToggle={(enabled) => {
                if (integration.id) setEnabled.mutate({ id: integration.id, enabled });
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Who may see conversations nobody owns.
 *
 * Lives here rather than in general settings because it is a decision about
 * channel correspondence, and it only means anything once messages are
 * arriving. Off by default: an unassigned enquiry is a customer's private
 * message to the business, not a shared noticeboard, so opening it to the whole
 * sales team is something an organization should choose rather than inherit.
 */
function SharedQueueCard({ canManage }: { canManage: boolean }): React.JSX.Element {
  const queryClient = useQueryClient();

  const organization = useQuery({
    queryKey: ['organization'],
    queryFn: () => apiGet<OrganizationDetail>('/organizations/current'),
  });

  const update = useMutation({
    mutationFn: (sharedUnassignedQueue: boolean) =>
      apiPatch('/organizations/current', { settings: { sharedUnassignedQueue } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['organization'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const enabled = organization.data?.settings.sharedUnassignedQueue ?? false;

  return (
    <Card>
      <CardHeader
        title="Unassigned conversations"
        subtitle="Who can see enquiries nobody has picked up"
      />

      <div className="space-y-4 p-5">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canManage || update.isPending || organization.isPending}
            onChange={(event) => update.mutate(event.target.checked)}
            className="mt-1"
          />
          <span className="text-sm">
            <span className="font-medium text-slate-900">
              Let every salesperson see unassigned conversations
            </span>
            <span className="mt-1 block text-pretty text-slate-600">
              Off by default. Administrators and managers always see them; with this on, sales
              representatives can pick up enquiries nobody owns. It never exposes a conversation
              attached to someone else&rsquo;s lead.
            </span>
          </span>
        </label>

        {update.isError && <ErrorNotice message="Could not change this setting." />}
      </div>
    </Card>
  );
}

function IntegrationCard({
  integration,
  canManage,
  busy,
  onToggle,
}: {
  integration: IntegrationView;
  canManage: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}): React.JSX.Element {
  const channel = CHANNEL_PRESENTATION[integration.channel];
  const status = STATUS_PRESENTATION[integration.status];
  const connected = integration.status !== 'NOT_CONNECTED';

  return (
    <Card>
      <CardHeader
        title={channel.label}
        subtitle={integration.displayName ?? undefined}
      />

      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.tone}`}>
            {status.label}
          </span>
          {connected && (
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                integration.enabled ? 'bg-slate-100 text-slate-700' : 'bg-slate-100 text-slate-500'
              }`}
            >
              {integration.enabled ? 'Enabled' : 'Disabled'}
            </span>
          )}
        </div>

        <p className="text-sm text-pretty text-slate-600">{status.meaning}</p>

        {integration.lastErrorMessage && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {integration.lastErrorMessage}
          </p>
        )}

        <dl className="divide-y divide-slate-100 border-t border-slate-100 text-sm">
          {integration.connectedAt && (
            <Row label="Connected" value={formatDateTime(integration.connectedAt)} />
          )}
          {integration.connectedBy && (
            <Row label="Connected by" value={integration.connectedBy.fullName} />
          )}
          {/* No activity means no row. Nothing is invented here. */}
          {integration.lastActivityAt && (
            <Row label="Last message" value={formatDateTime(integration.lastActivityAt)} />
          )}
        </dl>

        {/*
          Gated on `connectable`, which the SERVER decides. The component
          knowing how to render a WhatsApp form is not the same as the
          deployment being able to use one, and letting the client decide would
          put a working-looking form in front of a build that cannot honour it.
        */}
        {integration.channel === 'WHATSAPP' && integration.connectable && canManage && (
          <WhatsAppSetup integration={integration} />
        )}

        <div className="flex flex-wrap items-center gap-3">
          {!connected && !integration.connectable ? (
            <>
              <button
                type="button"
                disabled
                title="This channel cannot be connected in this release"
                className="cursor-not-allowed rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-400"
              >
                Connect
              </button>
              <span className="text-xs text-slate-500">Not available yet</span>
            </>
          ) : !connected ? null : canManage ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onToggle(!integration.enabled)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              {integration.enabled ? 'Disable' : 'Enable'}
            </button>
          ) : null}
        </div>

        {connected && (
          <p className="text-xs text-slate-500">
            Disabling stops new messages being acted on. Existing conversations, messages and
            leads are kept.
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * The WhatsApp Cloud API setup form.
 *
 * Three values from the Meta app dashboard. The token is a password field, is
 * sent once, and is cleared from component state whatever the outcome - a
 * bearer credential sitting in a React state tree is one screenshot or one
 * devtools session away from being someone else's.
 *
 * Nothing here claims success on its own. The server calls Meta with these
 * credentials and reports back CONNECTED or ERROR; the form only renders what
 * it was told.
 */
function WhatsAppSetup({ integration }: { integration: IntegrationView }): React.JSX.Element {
  const connect = useConnectWhatsApp();
  const disconnect = useDisconnectWhatsApp();

  const connected = integration.status === 'CONNECTED';
  const [open, setOpen] = useState(false);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [businessAccountId, setBusinessAccountId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setFailure(null);

    connect.mutate(
      {
        phoneNumberId: phoneNumberId.trim(),
        ...(businessAccountId.trim() ? { businessAccountId: businessAccountId.trim() } : {}),
        accessToken: accessToken.trim(),
      },
      {
        onSettled: () => {
          // Cleared on success AND on failure. Retrying means pasting it
          // again, which is the correct amount of friction for a credential.
          setAccessToken('');
        },
        onSuccess: (result) => {
          if (result.status === 'ERROR') {
            setFailure(result.message ?? 'Meta rejected the configuration.');
            return;
          }
          setOpen(false);
          setPhoneNumberId('');
          setBusinessAccountId('');
        },
        onError: () => setFailure('Could not save the configuration.'),
      },
    );
  };

  if (connected && !open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-slate-500">
          Token {integration.accessTokenHint ?? '****'}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Replace credentials
        </button>
        <button
          type="button"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate()}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
        >
          Disconnect
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800"
      >
        Connect
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-slate-200 p-4">
      <p className="text-sm text-pretty text-slate-600">
        From your Meta app dashboard, under WhatsApp &rsaquo; API Setup.
      </p>

      <Field
        id="wa-phone-number-id"
        label="Phone number ID"
        value={phoneNumberId}
        onChange={setPhoneNumberId}
        required
      />
      <Field
        id="wa-business-account-id"
        label="WhatsApp Business Account ID (optional)"
        value={businessAccountId}
        onChange={setBusinessAccountId}
      />
      <Field
        id="wa-access-token"
        label="Permanent access token"
        value={accessToken}
        onChange={setAccessToken}
        type="password"
        required
        hint="Stored encrypted. It is never shown again, only the last four characters."
      />

      {failure && <ErrorNotice message={failure} />}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={connect.isPending || !phoneNumberId.trim() || !accessToken.trim()}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          {connect.isPending ? 'Checking with Meta...' : 'Save and verify'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setAccessToken('');
            setFailure(null);
          }}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  required = false,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  type?: string;
  required?: boolean;
  hint?: string;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      />
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-900">{value}</dd>
    </div>
  );
}
