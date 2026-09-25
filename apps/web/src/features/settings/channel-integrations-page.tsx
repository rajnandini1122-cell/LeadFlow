import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrganizationDetail } from '@leadflow/api-types';
import { PERMISSIONS } from '@leadflow/api-types';
import { apiGet, apiPatch } from '../../lib/api-client';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useAuth } from '../auth/auth-context';
import { ChannelSetupGuide } from './channel-setup-guide';
import { useState, type FormEvent } from 'react';
import {
  CHANNEL_PRESENTATION,
  useConnectMessenger,
  useConnectWhatsApp,
  useDisconnectMessenger,
  useDisconnectWhatsApp,
  useSyncWhatsAppTemplates,
  useWhatsAppTemplates,
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
          WhatsApp also supports replying, within the 24-hour window WhatsApp allows. Instagram
          and Facebook Messenger are capture-only for now — answer those in the Meta apps.
        </p>
      </div>

      <WhatsAppAutoLeadCard canManage={canManage} />
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
 * Whether a WhatsApp buying enquiry becomes a lead on its own.
 *
 * Lives on this page rather than in general settings because it is a decision
 * about WhatsApp, and it means nothing until WhatsApp is connected below.
 *
 * OFF by default, and the copy is careful about what switching it on does. This
 * is not a display preference like the two cards around it: it assigns real
 * leads to real salespeople and creates a follow-up for each, which is easy to
 * turn on and very hard to undo. So the supporting text says exactly when it
 * fires and what happens to everything else, rather than leaving somebody to
 * discover that every "hi" became a lead.
 *
 * WhatsApp only. A wa_id is a real phone number, so a WhatsApp enquiry can be
 * de-duplicated against existing leads; Instagram and Messenger supply no
 * number, so the same automation there would have nothing to de-duplicate on.
 * The card says so, because the obvious next question is "why not the others?".
 */
function WhatsAppAutoLeadCard({ canManage }: { canManage: boolean }): React.JSX.Element {
  const queryClient = useQueryClient();

  const organization = useQuery({
    queryKey: ['organization'],
    queryFn: () => apiGet<OrganizationDetail>('/organizations/current'),
  });

  const update = useMutation({
    // The same settings endpoint every other organization setting uses, so this
    // is validated, permission-checked and audited identically.
    mutationFn: (whatsappAutoLeadEnabled: boolean) =>
      apiPatch('/organizations/current', { settings: { whatsappAutoLeadEnabled } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['organization'] });
    },
  });

  const enabled = organization.data?.settings.whatsappAutoLeadEnabled ?? false;

  return (
    <Card>
      <CardHeader
        title="Automatic leads from WhatsApp"
        subtitle="Turn buying enquiries into assigned work without waiting for review"
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
              Automatically create leads from WhatsApp buying enquiries
            </span>
            <span className="mt-1 block text-pretty text-slate-600">
              LeadFlow creates a lead only when an inbound WhatsApp message contains a buying
              signal. Other messages remain in the Inbox and review queue.
            </span>
          </span>
        </label>

        {/*
          What actually happens, said before somebody switches it on rather
          than discovered afterwards. Each clause is a real behaviour of the
          conversion pipeline, not reassurance.
        */}
        <ul className="ml-1 space-y-1.5 text-xs text-slate-500">
          <li>
            A new lead is routed by your assignment rules and given a first follow-up, exactly
            like a website enquiry.
          </li>
          <li>
            If the sender already has an active lead, no second one is created — their message
            goes to review instead.
          </li>
          <li>
            Anything the rules cannot route stays in the review queue. Nothing is dropped.
          </li>
          <li>
            WhatsApp only. Instagram and Messenger do not provide a phone number, so leads from
            those channels are still created by a person.
          </li>
        </ul>

        {update.isError && <ErrorNotice message="Could not change this setting." />}
      </div>
    </Card>
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
        {integration.connectable && canManage && <ProviderSetup integration={integration} />}

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

        {integration.channel === 'WHATSAPP' && (
          <WhatsAppTemplates integration={integration} canManage={canManage} />
        )}

        {connected && (
          <p className="text-xs text-slate-500">
            Disabling stops new messages being acted on. Existing conversations, messages and
            leads are kept.
            {integration.channel !== 'WHATSAPP' &&
              ' Replying from LeadFlow is not available on this channel yet.'}
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * The WhatsApp templates this organization can send.
 *
 * LeadFlow DISCOVERS templates; it cannot create one and cannot approve one.
 * Both happen in Meta, and this panel says so rather than offering a button
 * that would imply otherwise. Everything shown is what Meta last reported,
 * including the statuses that mean "not sendable" — hiding those would leave
 * an owner wondering where the template they created went.
 */
function WhatsAppTemplates({
  integration,
  canManage,
}: {
  integration: IntegrationView;
  canManage: boolean;
}): React.JSX.Element {
  const connected = integration.status === 'CONNECTED';
  // No point asking for a list that cannot exist yet.
  const templates = useWhatsAppTemplates(connected);
  const sync = useSyncWhatsAppTemplates();

  const [result, setResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (!connected) {
    return (
      <div className="border-t border-slate-100 pt-4">
        <h3 className="text-sm font-semibold text-slate-800">Message templates</h3>
        <p className="mt-1 text-xs text-pretty text-slate-500">
          Connect WhatsApp before loading templates. Templates are created and approved in
          Meta, then loaded here.
        </p>
      </div>
    );
  }

  const items = templates.data?.items ?? [];

  const refresh = (): void => {
    setResult(null);
    setFailure(null);
    sync.mutate(undefined, {
      onSuccess: (summary) => {
        setResult(
          `Loaded ${summary.total} template${summary.total === 1 ? '' : 's'}, ` +
            `${summary.approved} ready to send.`,
        );
      },
      onError: (error) => {
        // The API's words. They name the fix and carry no provider body.
        setFailure(
          error instanceof Error
            ? error.message
            : 'Could not load templates from Meta. Please try again.',
        );
      },
    });
  };

  return (
    <div className="border-t border-slate-100 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">Message templates</h3>
        {canManage && (
          <button
            type="button"
            disabled={sync.isPending}
            onClick={refresh}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {sync.isPending ? 'Refreshing…' : 'Refresh templates'}
          </button>
        )}
      </div>

      <p className="mt-1 text-xs text-pretty text-slate-500">
        Templates are created and approved in Meta. LeadFlow loads them and can send an
        approved one when the 24-hour reply window has closed.
      </p>

      {result && (
        <p role="status" className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {result}
        </p>
      )}

      {failure && (
        <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {failure}
        </p>
      )}

      {templates.isPending && <SkeletonRows rows={2} />}

      {templates.isError && <ErrorNotice message="Could not load the template list." />}

      {templates.isSuccess && items.length === 0 && (
        <p className="mt-3 text-xs text-slate-500">
          No templates loaded yet. Create and get them approved in Meta, then choose
          Refresh templates.
        </p>
      )}

      {items.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
          {items.map((template) => {
            const sendable = template.status === 'APPROVED' && template.supported;

            return (
              <li key={`${template.name}:${template.language}`} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800">{template.name}</span>
                  <span className="text-xs text-slate-500">{template.language}</span>
                  {template.category && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                      {template.category}
                    </span>
                  )}
                  {/* Meta's status, shown as Meta reported it. */}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      sendable ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    {template.status}
                  </span>
                </div>

                {template.bodyText && (
                  <p className="mt-1 text-xs text-pretty whitespace-pre-wrap text-slate-600">
                    {template.bodyText}
                  </p>
                )}

                {!template.supported && template.unsupportedReason && (
                  <p className="mt-1 text-[11px] text-amber-700">{template.unsupportedReason}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * What each provider's setup form asks for.
 *
 * Kept as data rather than two near-identical components. Instagram and
 * WhatsApp differ only in which identifiers Meta issues; the security
 * behaviour — write-only token, cleared on every outcome, server verifies
 * before CONNECTED — must be identical, and one component is how it stays
 * identical rather than drifting.
 */
const SETUP_FIELDS: Record<
  string,
  { hint: string; primary: { id: string; label: string }; secondary: { id: string; label: string } }
> = {
  WHATSAPP: {
    hint: 'From your Meta app dashboard, under WhatsApp \u203a API Setup.',
    primary: { id: 'phoneNumberId', label: 'Phone number ID' },
    secondary: { id: 'businessAccountId', label: 'WhatsApp Business Account ID (optional)' },
  },
  INSTAGRAM: {
    hint: 'From your Meta app dashboard, under Instagram \u203a API setup with Instagram login.',
    primary: { id: 'instagramAccountId', label: 'Instagram professional account ID' },
    secondary: { id: 'pageId', label: 'Linked Facebook Page ID (optional)' },
  },
  FACEBOOK: {
    hint: 'From your Meta app dashboard, under Messenger \u203a Settings.',
    primary: { id: 'facebookPageId', label: 'Facebook Page ID' },
    // The Page IS the account for Messenger, so there is no second id to give.
    secondary: { id: 'facebookUnused', label: '' },
  },
};

/** Slug per channel, for the connect and disconnect routes. */
const MESSENGER_SLUGS: Record<string, 'instagram' | 'facebook'> = {
  INSTAGRAM: 'instagram',
  FACEBOOK: 'facebook',
};

/**
 * Provider setup.
 *
 * The token is a password field, is sent once, and is cleared from component
 * state whatever the outcome — a bearer credential sitting in a React state
 * tree is one screenshot or one devtools session away from being someone
 * else's.
 *
 * Nothing here claims success on its own. The server calls Meta with these
 * credentials and reports back CONNECTED or ERROR; the form renders what it
 * was told.
 */
function ProviderSetup({ integration }: { integration: IntegrationView }): React.JSX.Element | null {
  const fields = SETUP_FIELDS[integration.channel];

  const messengerSlug = MESSENGER_SLUGS[integration.channel] ?? 'instagram';
  const isMessenger = integration.channel !== 'WHATSAPP';

  const connectWhatsApp = useConnectWhatsApp();
  const connectMessenger = useConnectMessenger(messengerSlug);
  const disconnectWhatsApp = useDisconnectWhatsApp();
  const disconnectMessenger = useDisconnectMessenger(messengerSlug);

  const connect = isMessenger ? connectMessenger : connectWhatsApp;
  const disconnect = isMessenger ? disconnectMessenger : disconnectWhatsApp;

  const connected = integration.status === 'CONNECTED';
  const [open, setOpen] = useState(false);

  const [primary, setPrimary] = useState('');
  const [secondary, setSecondary] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  // A channel with no field definition has no setup flow, whatever the server
  // reported. Rendering an empty form would be worse than rendering nothing.
  if (!fields) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setFailure(null);

    const payload = isMessenger
      ? {
          accountId: primary.trim(),
          ...(secondary.trim() ? { linkedAccountId: secondary.trim() } : {}),
          accessToken: accessToken.trim(),
        }
      : {
          phoneNumberId: primary.trim(),
          ...(secondary.trim() ? { businessAccountId: secondary.trim() } : {}),
          accessToken: accessToken.trim(),
        };

    connect.mutate(payload as never, {
      onSettled: () => {
        // Cleared on success AND on failure. Retrying means pasting it again,
        // which is the correct amount of friction for a credential.
        setAccessToken('');
      },
      onSuccess: (result) => {
        if (result.status === 'ERROR') {
          setFailure(result.message ?? 'Meta rejected the configuration.');
          return;
        }
        setOpen(false);
        setPrimary('');
        setSecondary('');
      },
      onError: () => setFailure('Could not save the configuration.'),
    });
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
      {/*
        * Above the fields, because it explains what they are asking for.
        * Collapsed by default so it is help on the first run rather than a
        * wall of text in the way on every visit afterwards.
        */}
      <ChannelSetupGuide channel={integration.channel} />

      <p className="text-sm text-pretty text-slate-600">{fields.hint}</p>

      <Field
        id={fields.primary.id}
        label={fields.primary.label}
        value={primary}
        onChange={setPrimary}
        required
      />
      {fields.secondary.label && (
        <Field
          id={fields.secondary.id}
          label={fields.secondary.label}
          value={secondary}
          onChange={setSecondary}
        />
      )}
      <Field
        id={`${integration.channel}-access-token`}
        label="Access token"
        value={accessToken}
        onChange={setAccessToken}
        type="password"
        required
        /*
         * "new-password", not "off". It tells the browser this is a value being
         * SET rather than a login being recalled, which is both true and the
         * only reliable way to stop the saved-password prompt appearing for an
         * API token.
         */
        autoComplete="new-password"
        hint="Stored encrypted. It is never shown again, only the last four characters."
      />

      {failure && <ErrorNotice message={failure} />}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={connect.isPending || !primary.trim() || !accessToken.trim()}
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
  autoComplete = 'off',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  type?: string;
  required?: boolean;
  hint?: string;
  autoComplete?: string;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {/*
        * Autofill is actively suppressed here, not merely discouraged.
        *
        * `autoComplete="off"` alone is not enough: browsers ignore it on a form
        * that contains a password field and offer saved credentials for the
        * text input above it. On this form that means an email address being
        * dropped into "Phone number ID" — which looks filled in, saves without
        * complaint, and produces an integration that can never receive a
        * message. A `name` that does not read as a login field, plus the
        * password-manager opt-outs, is what actually stops it.
        */}
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        data-lpignore="true"
        data-1p-ignore=""
        data-form-type="other"
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
