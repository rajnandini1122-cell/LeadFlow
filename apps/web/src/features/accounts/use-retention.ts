import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api-client';

/**
 * Customer retention and repeat business.
 *
 * A signal is an OBSERVATION, never an instruction. Nothing in this file
 * triggers anything on its own: the queue lists reasons a customer might need
 * attention and a person decides. A CRM that acts on its own guesses is one a
 * salesperson learns to ignore.
 */

export type SignalKind =
  | 'FOLLOW_UP_DUE'
  | 'REPEAT_CANDIDATE'
  | 'OPEN_OPPORTUNITY'
  | 'DORMANT'
  | 'EXPANSION_CANDIDATE';

export interface RetentionSignal {
  kind: SignalKind;
  priority: number;
  /** Always states the evidence, so the suggestion can be judged. */
  reason: string;
}

export interface ActionQueueItem {
  accountId: string;
  name: string;
  status: string;
  owner: { id: string; fullName: string } | null;
  headline: RetentionSignal | null;
  signals: RetentionSignal[];
  wonCount: number;
  wonValue: number;
  openOpportunities: number;
  lastWonAt: string | null;
  lastActivityAt: string | null;
  daysSinceActivity: number | null;
  topProduct: { id: string; name: string } | null;
}

export interface ActionQueue {
  items: ActionQueueItem[];
  total: number;
  /**
   * How many customers were actually examined.
   *
   * Signals are a property of history rather than something SQL selects on, so
   * the queue filters within a page. Reported so the screen can say what it
   * looked at instead of implying it saw everything.
   */
  scanned: number;
}

export function useActionQueue(signal?: string): UseQueryResult<ActionQueue> {
  return useQuery({
    queryKey: ['retention', 'queue', signal ?? 'all'],
    queryFn: () =>
      apiGet<ActionQueue>('/accounts/retention/queue', signal ? { signal, limit: 100 } : { limit: 100 }),
  });
}

export interface RetentionSummary {
  needAttention: number;
  repeatCandidates: number;
  followUpsDue: number;
  dormant: number;
  expansionCandidates: number;
  openCustomerOpportunities: number;
  scanned: number;
}

export function useRetentionSummary(): UseQueryResult<RetentionSummary> {
  return useQuery({
    queryKey: ['retention', 'summary'],
    queryFn: () => apiGet<RetentionSummary>('/accounts/retention/summary'),
  });
}

export interface RepeatOptions {
  account: { id: string; name: string; status: string };
  products: {
    productId: string;
    name: string;
    sku: string;
    active: boolean;
    wins: number;
    lastWonAt: string | null;
    /** What they paid last time. CONTEXT — never copied without confirmation. */
    lastWonValue: number | null;
    totalWonValue: number;
  }[];
  contacts: { id: string; name: string; mobile: string | null; email: string | null }[];
}

export function useRepeatOptions(accountId: string, enabled: boolean): UseQueryResult<RepeatOptions> {
  return useQuery({
    queryKey: ['retention', 'repeat-options', accountId],
    queryFn: () => apiGet<RepeatOptions>(`/accounts/${accountId}/repeat-options`),
    enabled: enabled && Boolean(accountId),
  });
}

export interface RepeatOpportunityInput {
  productId?: string;
  contactId?: string;
  productInterest?: string;
  estimatedValue?: number;
  nextFollowUpAt: string;
}

/**
 * Raises the next opportunity for an existing customer.
 *
 * Sends an Idempotency-Key so a double-click returns the SAME opportunity
 * rather than creating a second one. The key is generated per dialog opening,
 * not per click — that is what makes the second click a replay.
 */
export function useCreateRepeatOpportunity(): UseMutationResult<
  { leadId: string; opportunityKind: string | null; replayed: boolean },
  Error,
  { accountId: string; idempotencyKey: string } & RepeatOpportunityInput
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ accountId, idempotencyKey, ...input }) =>
      apiPost<{ leadId: string; opportunityKind: string | null; replayed: boolean }>(
        `/accounts/${accountId}/repeat-opportunity`,
        input,
        { headers: { 'Idempotency-Key': idempotencyKey } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['retention'] });
      void queryClient.invalidateQueries({ queryKey: ['account-kpi'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export interface AccountFollowUpInput {
  scheduledAt: string;
  type?: string;
  title?: string;
  notes?: string;
}

/** Schedules an action on the CUSTOMER, with no lead invented to hold it. */
export function useCreateAccountFollowUp(): UseMutationResult<
  unknown,
  Error,
  { accountId: string } & AccountFollowUpInput
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ accountId, ...input }) =>
      apiPost(`/accounts/${accountId}/follow-ups`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['retention'] });
      void queryClient.invalidateQueries({ queryKey: ['follow-ups'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** How each signal reads on screen. */
export const SIGNAL_PRESENTATION: Record<
  SignalKind,
  { icon: string; label: string; className: string }
> = {
  FOLLOW_UP_DUE: {
    icon: '📞',
    label: 'Follow-up due',
    className: 'bg-red-100 text-red-800',
  },
  DORMANT: { icon: '🟠', label: 'Dormant', className: 'bg-amber-100 text-amber-800' },
  REPEAT_CANDIDATE: {
    icon: '🔄',
    label: 'Repeat business',
    className: 'bg-sky-100 text-sky-800',
  },
  OPEN_OPPORTUNITY: {
    icon: '🟢',
    label: 'Active opportunity',
    className: 'bg-emerald-100 text-emerald-800',
  },
  EXPANSION_CANDIDATE: {
    icon: '💡',
    label: 'Expansion',
    className: 'bg-violet-100 text-violet-800',
  },
};
