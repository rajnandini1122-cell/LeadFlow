import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../../lib/api-client';

/**
 * Data access for the channel review queue and conversation views.
 *
 * Every mutation invalidates `['leads']` as well as its own keys, because
 * linking a conversation writes to the lead's activity timeline and its
 * lastActivityAt. Leaving that stale would show a lead as untouched moments
 * after a customer message arrived on it.
 */

export type ReviewCategory =
  | 'ALL'
  | 'POTENTIAL_LEAD'
  | 'UNRESOLVED'
  | 'UNLINKED'
  | 'REVIEW_REQUIRED'
  | 'LINKED';

export type Channel = 'WHATSAPP' | 'FACEBOOK' | 'INSTAGRAM';

export interface ReviewContact {
  id: string;
  name: string | null;
  mobile: string | null;
  email: string | null;
  companyName: string | null;
}

export interface ReviewRow {
  id: string;
  channel: Channel;
  linkState: 'UNLINKED' | 'LINKED' | 'REVIEW_REQUIRED';
  potentialLead: boolean;
  potentialLeadSignals: string[];
  archivedAt: string | null;
  lastMessageAt: string | null;
  contact: ReviewContact | null;
  companyName: string | null;
  owner: { id: string; fullName: string } | null;
  lead: { id: string; leadNumber: string; status: string } | null;
  lastMessagePreview: string | null;
}

export interface CandidateLead {
  id: string;
  leadNumber: string;
  status: string;
  companyName: string | null;
  productInterest: string | null;
  assignedTo: { id: string; fullName: string } | null;
  createdAt: string;
  lastActivityAt: string | null;
}

export type DeliveryStatus =
  | 'PENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  /** The send was never resolved. It may or may not have reached the customer. */
  | 'UNCONFIRMED';

/**
 * What the API says about one attachment.
 *
 * Deliberately no URL and no provider id — those are credentials, and the
 * server keeps them. The bytes are fetched from our own authenticated endpoint
 * using the index.
 */
export interface MessageAttachmentView {
  index: number;
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'OTHER' | string;
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number | null;
  retrievable: boolean;
}

export interface ConversationMessage {
  id: string;
  direction: 'INCOMING' | 'OUTGOING';
  senderType: 'CONTACT' | 'AGENT' | 'SYSTEM';
  messageType: string;
  content: string | null;
  attachments: MessageAttachmentView[];
  /** Set only for messages we sent. */
  deliveryStatus?: DeliveryStatus | null;
  failureReason?: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface ConversationDetail {
  id: string;
  channel: Channel;
  status: string;
  linkState: 'UNLINKED' | 'LINKED' | 'REVIEW_REQUIRED';
  potentialLead: boolean;
  potentialLeadSignals: string[];
  archivedAt: string | null;
  archivedReason: string | null;
  lastMessageAt: string | null;
  companyName: string | null;
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    mobile: string | null;
    email: string | null;
    companyName: string | null;
  } | null;
  owner: { id: string; fullName: string } | null;
  lead: { id: string; leadNumber: string; status: string } | null;
  integration: { id: string; displayName: string | null; status: string } | null;
  /**
   * Calculated by the API. The composer renders only when this is true — the
   * client never decides for itself, because the rules depend on integration
   * state and on WhatsApp's 24-hour window.
   */
  canSend: boolean;
  /** Why not. Safe to show verbatim. */
  sendDisabledReason?: string | null;
  /** When the free-form reply window closes, if one applies. */
  windowExpiresAt?: string | null;
  /**
   * The provider's own text limit.
   *
   * Meta's limits differ per channel — 4096 on WhatsApp, 2000 on Messenger,
   * 1000 on Instagram — so the composer reads this rather than assuming one
   * number and letting the provider reject what it accepted.
   */
  maxTextLength?: number | null;
  candidateLeads: CandidateLead[];
  messages: ConversationMessage[];
}

export interface LinkedConversation {
  id: string;
  channel: Channel;
  ownerId: string | null;
  lastMessageAt: string | null;
  status: string;
  contact: { id: string; firstName: string | null; lastName: string | null; mobile: string | null } | null;
  messages: { id: string; content: string | null; createdAt: string }[];
}

export interface ConversationPage {
  items: ReviewRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function useReviewQueue(filters: {
  category: ReviewCategory;
  channel?: Channel | undefined;
  archived?: boolean;
}): UseQueryResult<ConversationPage> {
  const params: Record<string, unknown> = {};
  if (filters.category !== 'ALL') params['category'] = filters.category;
  if (filters.channel) params['channel'] = filters.channel;
  if (filters.archived) params['archived'] = true;

  return useQuery({
    queryKey: ['conversations', 'review', params],
    queryFn: () => apiGet<ConversationPage>('/conversations/review', params),
  });
}

export type InboxFilter = 'ALL' | 'MINE' | 'UNASSIGNED';

export interface InboxCounts {
  all: number;
  mine: number;
  unassigned: number;
  review: number;
}

/**
 * The unified inbox.
 *
 * Reads the same conversations the review queue does — one store, two views —
 * and simply does not hide threads that already belong to a lead.
 */
export function useInbox(filters: {
  filter: InboxFilter;
  channel?: Channel | undefined;
  archived?: boolean;
}): UseQueryResult<ConversationPage> {
  const params: Record<string, unknown> = {};
  if (filters.filter !== 'ALL') params['filter'] = filters.filter;
  if (filters.channel) params['channel'] = filters.channel;
  if (filters.archived) params['archived'] = true;

  return useQuery({
    queryKey: ['conversations', 'inbox', params],
    queryFn: () => apiGet<ConversationPage>('/conversations/inbox', params),
  });
}

export function useInboxCounts(enabled: boolean): UseQueryResult<InboxCounts> {
  return useQuery({
    queryKey: ['conversations', 'inbox', 'counts'],
    queryFn: () => apiGet<InboxCounts>('/conversations/inbox/counts'),
    enabled,
  });
}

export interface IntegrationView {
  channel: Channel;
  id: string | null;
  status: 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  enabled: boolean;
  displayName: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastActivityAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  connectedBy: { id: string; fullName: string } | null;
  /** Last four characters of the stored token. Never the token itself. */
  accessTokenHint: string | null;
  /** True where a real setup flow exists. WhatsApp only, from Phase E1. */
  connectable: boolean;
}

export function useIntegrations(): UseQueryResult<IntegrationView[]> {
  return useQuery({
    queryKey: ['channel-integrations'],
    queryFn: () => apiGet<IntegrationView[]>('/channel-integrations'),
  });
}

/** The shape every provider connect endpoint returns. */
export interface ConnectWhatsAppResult {
  id: string;
  status: 'CONNECTED' | 'ERROR';
  displayName?: string | null;
  message?: string;
}

/**
 * Connect a WhatsApp Business number.
 *
 * The access token is write-only: it goes up once, is encrypted server-side and
 * is never returned by any endpoint. The form must not keep it either — see
 * the setup card, which clears the field on success and on failure alike.
 */
export function useConnectWhatsApp(): UseMutationResult<
  ConnectWhatsAppResult,
  Error,
  { phoneNumberId: string; businessAccountId?: string; accessToken: string }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input) =>
      apiPost<ConnectWhatsAppResult>('/channel-integrations/whatsapp/connect', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channel-integrations'] });
    },
  });
}

/**
 * Connect an Instagram account or a Facebook Page.
 *
 * One hook for both, because both endpoints take the same three values. The
 * slug picks the route; nothing else differs.
 */
export function useConnectMessenger(
  slug: 'instagram' | 'facebook',
): UseMutationResult<
  ConnectWhatsAppResult,
  Error,
  { accountId: string; linkedAccountId?: string; accessToken: string }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input) =>
      apiPost<ConnectWhatsAppResult>(`/channel-integrations/${slug}/connect`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channel-integrations'] });
    },
  });
}

export function useDisconnectMessenger(
  slug: 'instagram' | 'facebook',
): UseMutationResult<unknown, Error, void> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiPost(`/channel-integrations/${slug}/disconnect`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channel-integrations'] });
    },
  });
}

export function useDisconnectWhatsApp(): UseMutationResult<unknown, Error, void> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiPost('/channel-integrations/whatsapp/disconnect'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channel-integrations'] });
    },
  });
}

export function useSetIntegrationEnabled(): UseMutationResult<
  unknown,
  Error,
  { id: string; enabled: boolean }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, enabled }) => apiPatch(`/channel-integrations/${id}`, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channel-integrations'] });
    },
  });
}

/**
 * Send a reply.
 *
 * The idempotency key is generated once per composed message and reused if the
 * request is retried, so a double click or a flaky connection cannot deliver a
 * customer two copies. The server enforces it; this is the client half.
 */
export function useSendMessage(
  conversationId: string,
): UseMutationResult<
  ConversationMessage,
  Error,
  { content: string; idempotencyKey: string; file?: File | null }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input) => {
      /*
       * Multipart only when there is a file.
       *
       * A text-only send stays exactly the JSON request it has always been,
       * so nothing about the existing path changes shape to accommodate media.
       */
      if (!input.file) {
        return apiPost<ConversationMessage>(`/conversations/${conversationId}/messages`, {
          content: input.content,
          idempotencyKey: input.idempotencyKey,
        });
      }

      const form = new FormData();
      form.append('idempotencyKey', input.idempotencyKey);
      if (input.content) form.append('content', input.content);
      form.append('file', input.file);

      return apiPost<ConversationMessage>(
        `/conversations/${conversationId}/messages`,
        form,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

/**
 * Where to fetch an attachment's bytes.
 *
 * Our own authenticated endpoint, never the provider. The browser is never
 * given a provider link, because those are unguessable capability URLs that
 * also expire.
 */
export function attachmentUrl(
  conversationId: string,
  messageId: string,
  index: number,
): string {
  return `/api/v1/conversations/${conversationId}/messages/${messageId}/attachments/${index}`;
}

export function useAssignConversation(): UseMutationResult<
  unknown,
  Error,
  { conversationId: string; userId: string | null }
> {
  return useConversationMutation(({ conversationId, userId }) =>
    apiPost(`/conversations/${conversationId}/assign`, { userId }),
  );
}

export function useReviewCount(enabled: boolean): UseQueryResult<{ count: number }> {
  return useQuery({
    queryKey: ['conversations', 'review', 'count'],
    queryFn: () => apiGet<{ count: number }>('/conversations/review/count'),
    enabled,
  });
}

export function useConversation(id: string | undefined): UseQueryResult<ConversationDetail> {
  return useQuery({
    queryKey: ['conversations', id],
    queryFn: () => apiGet<ConversationDetail>(`/conversations/${id}`),
    enabled: Boolean(id),
  });
}

export function useLeadConversations(
  leadId: string | undefined,
): UseQueryResult<LinkedConversation[]> {
  return useQuery({
    queryKey: ['conversations', 'lead', leadId],
    queryFn: () => apiGet<LinkedConversation[]>('/conversations', { leadId }),
    enabled: Boolean(leadId),
  });
}

/** Shared invalidation: conversations moved, and a lead timeline changed. */
function useConversationMutation<TArgs>(
  request: (args: TArgs) => Promise<unknown>,
): UseMutationResult<unknown, Error, TArgs> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}

export function useLinkConversation(): UseMutationResult<
  unknown,
  Error,
  { conversationId: string; leadId: string }
> {
  return useConversationMutation(({ conversationId, leadId }) =>
    apiPost(`/conversations/${conversationId}/link`, { leadId }),
  );
}

export function useUnlinkConversation(): UseMutationResult<unknown, Error, { conversationId: string }> {
  return useConversationMutation(({ conversationId }) =>
    apiPost(`/conversations/${conversationId}/unlink`),
  );
}

export function useArchiveConversation(): UseMutationResult<
  unknown,
  Error,
  { conversationId: string; reason?: string }
> {
  return useConversationMutation(({ conversationId, reason }) =>
    apiPost(`/conversations/${conversationId}/archive`, reason ? { reason } : {}),
  );
}

export function useRestoreConversation(): UseMutationResult<
  unknown,
  Error,
  { conversationId: string }
> {
  return useConversationMutation(({ conversationId }) =>
    apiPost(`/conversations/${conversationId}/restore`),
  );
}

/** Presentation for a channel. Kept in one place so badges never disagree. */
export const CHANNEL_PRESENTATION: Record<Channel, { label: string; icon: string; tone: string }> = {
  WHATSAPP: { label: 'WhatsApp', icon: '💬', tone: 'bg-emerald-50 text-emerald-700' },
  FACEBOOK: { label: 'Facebook', icon: '📘', tone: 'bg-blue-50 text-blue-700' },
  INSTAGRAM: { label: 'Instagram', icon: '📸', tone: 'bg-fuchsia-50 text-fuchsia-700' },
};

export const LINK_STATE_PRESENTATION: Record<
  ReviewRow['linkState'],
  { label: string; tone: string; meaning: string }
> = {
  UNLINKED: {
    label: 'Needs a lead',
    tone: 'bg-amber-50 text-amber-700',
    meaning: 'No lead is attached to this conversation yet.',
  },
  LINKED: {
    label: 'Linked',
    tone: 'bg-emerald-50 text-emerald-700',
    meaning: 'Attached to a lead.',
  },
  REVIEW_REQUIRED: {
    label: 'Review required',
    tone: 'bg-red-50 text-red-700',
    meaning:
      'Several active leads matched this person, so nothing was attached automatically.',
  },
};
