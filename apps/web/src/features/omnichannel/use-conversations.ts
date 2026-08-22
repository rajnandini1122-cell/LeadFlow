import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api-client';

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

export interface ConversationMessage {
  id: string;
  direction: 'INCOMING' | 'OUTGOING';
  senderType: 'CONTACT' | 'AGENT' | 'SYSTEM';
  messageType: string;
  content: string | null;
  attachments: unknown;
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
  /** False in this phase everywhere. The UI must not offer what cannot send. */
  canSend: boolean;
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

export function useReviewQueue(filters: {
  category: ReviewCategory;
  channel?: Channel | undefined;
  archived?: boolean;
}): UseQueryResult<{ items: ReviewRow[]; total: number }> {
  const params: Record<string, unknown> = {};
  if (filters.category !== 'ALL') params['category'] = filters.category;
  if (filters.channel) params['channel'] = filters.channel;
  if (filters.archived) params['archived'] = true;

  return useQuery({
    queryKey: ['conversations', 'review', params],
    queryFn: () => apiGet<{ items: ReviewRow[]; total: number }>('/conversations/review', params),
  });
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
