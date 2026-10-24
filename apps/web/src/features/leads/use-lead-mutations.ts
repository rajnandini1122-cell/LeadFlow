import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { LeadPriority, LeadStatus, Paginated } from '@leadflow/api-types';
import { api, apiGet, apiPatch, apiPost } from '../../lib/api-client';
import { idempotencyHeaders } from '../../lib/idempotency';
import type { LeadActivity, LeadSummary } from './use-leads';

/**
 * One follow-up, as the API returns it.
 *
 * A follow-up hangs off a LEAD or a CUSTOMER ACCOUNT, never both. The lead
 * fields are null for an account follow-up — the API says so explicitly — but
 * this type used to declare them always present, so the queue rendered a
 * customer follow-up as a link to `/leads/null` with no name. They are typed
 * as the API sends them now, so the compiler makes every screen handle both.
 */
export interface FollowUp {
  id: string;
  leadId: string | null;
  leadNumber: string | null;
  leadName: string | null;
  /** The customer, for a follow-up owed on the relationship rather than a deal. */
  accountId: string | null;
  accountName: string | null;
  companyName: string | null;
  mobile: string | null;
  leadStatus: string | null;
  leadPriority: string | null;
  /** What the last call on this lead established (CALL_OUTCOMES code). */
  leadLastOutcome?: string | null;
  leadLastOutcomeAt?: string | null;
  estimatedValue: string | null;
  scheduledAt: string;
  type: string;
  status: string;
  title: string | null;
  notes: string | null;
  outcome: string | null;
  completedAt: string | null;
  assignedTo: { id: string; fullName: string };
  isOverdue: boolean;
}

/**
 * The follow-up views, computed server-side in the ORGANIZATION's timezone.
 * Overdue and Today are disjoint; Tomorrow and This week sit inside Upcoming.
 */
export type FollowUpBucket =
  | 'overdue'
  | 'today'
  | 'tomorrow'
  | 'week'
  | 'upcoming'
  | 'awaiting'
  | 'completed'
  | 'completed_today';

/** True totals per bucket — never the length of a capped page. */
export type FollowUpCounts = Record<FollowUpBucket, number>;

export interface WorkspaceSummary {
  timezone: string;
  scope: 'OWN' | 'TEAM';
  followUps: FollowUpCounts;
  leads: { fresh: number; awaiting: number; unassigned: number | null };
}

/** What logging one call produced. */
export interface RecordOutcomeResult {
  leadId: string;
  outcome: string;
  leadStatus: LeadStatus;
  completedFollowUpId: string | null;
  followUp: FollowUp | null;
  nextFollowUpAt: string | null;
  replayed: boolean;
}

export interface RecordOutcomeInput {
  outcome: string;
  followUpId?: string;
  note?: string;
  nextFollowUpAt?: string;
  nextType?: string;
  markQualified?: boolean;
  close?: boolean;
  lostReason?: string;
  productId?: string;
  productInterest?: string;
  quantity?: string;
  expectedPurchaseDate?: string;
}

/**
 * Invalidates everything a lead write can affect.
 *
 * Completing a follow-up can change the lead's status, its next action, the
 * timeline and every bucket at once. Listing the affected keys at each call
 * site guarantees one of them eventually gets missed and the UI shows stale
 * data, so it is done in one place.
 */
function useRefreshLeadData(): (leadId?: string) => void {
  const queryClient = useQueryClient();

  return (leadId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
    void queryClient.invalidateQueries({ queryKey: ['follow-ups'] });
    /*
     * The dashboard counts the same follow-ups from its own endpoint.
     *
     * Without this it kept showing "6 overdue" after one was completed, while
     * the sidebar badge beside it had already dropped to 5 — two numbers for
     * the same thing, disagreeing on screen. A count that does not move when
     * you do the work is worse than no count: it stops being believed.
     */
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    // The workspace tiles and the queue tab counts read the same buckets.
    void queryClient.invalidateQueries({ queryKey: ['workspace'] });
    void queryClient.invalidateQueries({ queryKey: ['follow-up-counts'] });
    if (leadId) {
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['lead-activities', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['lead-follow-ups', leadId] });
    }
  };
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export function useLeadActivities(
  leadId: string | undefined,
  limit = 25,
): UseQueryResult<Paginated<LeadActivity>> {
  return useQuery({
    queryKey: ['lead-activities', leadId, limit],
    queryFn: () =>
      apiGet<Paginated<LeadActivity>>(`/leads/${leadId as string}/activities`, { limit }),
    enabled: Boolean(leadId),
  });
}

export function useLeadFollowUps(leadId: string | undefined): UseQueryResult<FollowUp[]> {
  return useQuery({
    queryKey: ['lead-follow-ups', leadId],
    queryFn: () => apiGet<FollowUp[]>(`/leads/${leadId as string}/follow-ups`),
    enabled: Boolean(leadId),
  });
}

/**
 * A bucket of follow-ups, straight from the API.
 *
 * Buckets are computed server-side in the ORGANIZATION's timezone. Deriving
 * them in the browser would use the viewer's clock, so a manager travelling
 * would see a different "today" from their team.
 */
export function useFollowUps(
  bucket: FollowUpBucket,
  options: { assignedUserId?: string; enabled?: boolean } = {},
): UseQueryResult<FollowUp[]> {
  const params: Record<string, unknown> = { bucket, limit: 200 };
  if (options.assignedUserId) params['assignedUserId'] = options.assignedUserId;

  return useQuery({
    queryKey: ['follow-ups', bucket, options.assignedUserId ?? null],
    queryFn: () => apiGet<FollowUp[]>('/follow-ups', params),
    enabled: options.enabled ?? true,
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export interface UpdateLeadInput {
  firstName?: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  companyName?: string;
  city?: string;
  source?: string;
  productInterest?: string;
  estimatedValue?: number;
  priority?: LeadPriority;
  status?: LeadStatus;
  lostReason?: string;
  wonValue?: number;
  nextFollowUpAt?: string;
}

export function useUpdateLead(leadId: string) {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: (input: UpdateLeadInput) => apiPatch<LeadSummary>(`/leads/${leadId}`, input),
    onSuccess: () => refresh(leadId),
  });
}

export function useAssignLead(leadId: string) {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: (input: { assignedToId: string; reason?: string }) =>
      apiPost<LeadSummary>(`/leads/${leadId}/assign`, input),
    onSuccess: () => refresh(leadId),
  });
}

export function useArchiveLead(leadId: string) {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: async () => {
      await api.delete(`/leads/${leadId}`);
    },
    onSuccess: () => refresh(leadId),
  });
}

/**
 * Takes a lead out of the live pipeline, reversibly.
 *
 * A different thing from `useArchiveLead` above, and the difference matters:
 * archiving records no reason and cannot be undone, while this records who,
 * when and why — and can be reversed. A wrongly imported lead needs the second.
 */
export function useDeactivateLead(leadId: string) {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: (input: { reason: string }) =>
      apiPost<LeadSummary>(`/leads/${leadId}/deactivate`, input),
    onSuccess: () => refresh(leadId),
  });
}

/**
 * Puts it back.
 *
 * CAN FAIL with 409: deactivation released this lead's mobile and email, so
 * another active lead may have taken them in the meantime. The error names the
 * lead that holds the identifier, so the caller should surface its message
 * rather than a generic failure.
 */
export function useReactivateLead(leadId: string) {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: (input: { nextFollowUpAt?: string; reason?: string }) =>
      apiPost<LeadSummary>(`/leads/${leadId}/reactivate`, input),
    onSuccess: () => refresh(leadId),
  });
}

/**
 * "I tried and could not reach them."
 *
 * One request for the three facts about one failed call — what happened, the
 * note, and when to try again — so they commit together. Previously the lead
 * screen needed three: log the activity, type a note, open the reschedule
 * dialog. That produced three timeline entries for one call, and a rep who
 * stopped after the first left the retry unscheduled.
 *
 * Deliberately NOT useCompleteFollowUp: an unanswered call is an attempt, not
 * an outcome, so the work is still owed and the follow-up must stay open.
 */
export function useRecordAttempt(leadId: string) {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: ({
      idempotencyKey,
      ...input
    }: {
      activityType: string;
      note?: string;
      retryAt: string;
      type?: string;
      /** One per dialog opening, so a double click is ONE attempt. */
      idempotencyKey?: string;
    }) =>
      apiPost<{
        followUp: FollowUp | null;
        nextFollowUpAt: string | null;
        leadStatus: LeadStatus;
      }>(`/leads/${leadId}/attempts`, input, idempotencyHeaders(idempotencyKey)),
    // Every queue the attempt touches: the lead, its timeline, its follow-ups,
    // the follow-up buckets and the dashboard counts.
    onSuccess: () => refresh(leadId),
  });
}

export function useLogActivity(leadId: string) {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: (input: {
      activityType: string;
      description?: string;
      nextFollowUpAt?: string;
    }) => apiPost(`/leads/${leadId}/activities`, input),
    onSuccess: () => refresh(leadId),
  });
}

export function useAddNote(leadId: string) {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: (body: string) => apiPost(`/leads/${leadId}/notes`, { body }),
    onSuccess: () => refresh(leadId),
  });
}

export function useCreateFollowUp(leadId: string) {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: ({
      idempotencyKey,
      ...input
    }: {
      scheduledAt: string;
      type?: string;
      title?: string;
      notes?: string;
      assignedUserId?: string;
      idempotencyKey?: string;
    }) => apiPost<FollowUp>(`/leads/${leadId}/follow-ups`, input, idempotencyHeaders(idempotencyKey)),
    onSuccess: () => refresh(leadId),
  });
}

export interface CompleteFollowUpInput {
  outcome?: string;
  notes?: string;
  nextFollowUpAt?: string;
  leadStatus?: LeadStatus;
  lostReason?: string;
  wonValue?: number;
}

export function useCompleteFollowUp() {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: ({
      id,
      idempotencyKey,
      leadId: _leadId,
      ...input
    }: CompleteFollowUpInput & { id: string; leadId?: string; idempotencyKey?: string }) =>
      apiPost<{ followUp: FollowUp; nextFollowUpAt: string | null }>(
        `/follow-ups/${id}/complete`,
        input,
        idempotencyHeaders(idempotencyKey),
      ),
    onSuccess: (_result, variables) => refresh(variables.leadId),
  });
}

export function useRescheduleFollowUp() {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: ({
      id,
      idempotencyKey,
      leadId: _leadId,
      ...input
    }: {
      id: string;
      leadId?: string;
      scheduledAt: string;
      type?: string;
      reason?: string;
      idempotencyKey?: string;
    }) => apiPost<FollowUp>(`/follow-ups/${id}/reschedule`, input, idempotencyHeaders(idempotencyKey)),
    onSuccess: (_result, variables) => refresh(variables.leadId),
  });
}

/** True totals for every bucket, for the queue tabs. */
export function useFollowUpCounts(options: { assignedUserId?: string } = {}): UseQueryResult<FollowUpCounts> {
  const params: Record<string, unknown> = {};
  if (options.assignedUserId) params['assignedUserId'] = options.assignedUserId;
  return useQuery({
    queryKey: ['follow-up-counts', options.assignedUserId ?? null],
    queryFn: () => apiGet<FollowUpCounts>('/follow-ups/counts', params),
  });
}

/** The "My work today" numbers, in the organization's timezone. */
export function useWorkspaceSummary(options: { assignedUserId?: string } = {}): UseQueryResult<WorkspaceSummary> {
  const params: Record<string, unknown> = {};
  if (options.assignedUserId) params['assignedUserId'] = options.assignedUserId;
  return useQuery({
    queryKey: ['workspace', options.assignedUserId ?? null],
    queryFn: () => apiGet<WorkspaceSummary>('/workspace/summary', params),
  });
}

/**
 * Logs one call's outcome — reached or not — with everything it decides.
 *
 * The server's rule decides whether the worked follow-up is completed (the
 * call happened) or replaced by a retry (it did not). One Idempotency-Key per
 * dialog opening makes a double click one call, not two.
 */
export function useRecordOutcome(leadId: string) {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: ({ idempotencyKey, ...input }: RecordOutcomeInput & { idempotencyKey?: string }) =>
      apiPost<RecordOutcomeResult>(`/leads/${leadId}/outcomes`, input, idempotencyHeaders(idempotencyKey)),
    onSuccess: () => refresh(leadId),
  });
}

export function useCancelFollowUp() {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: async ({ id }: { id: string; leadId?: string; reason?: string }) => {
      await api.delete(`/follow-ups/${id}`);
    },
    onSuccess: (_result, variables) => refresh(variables.leadId),
  });
}
