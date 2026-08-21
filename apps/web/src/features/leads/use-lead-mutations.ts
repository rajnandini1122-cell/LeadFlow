import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { LeadPriority, LeadStatus, Paginated } from '@leadflow/api-types';
import { api, apiGet, apiPatch, apiPost } from '../../lib/api-client';
import type { LeadActivity, LeadSummary } from './use-leads';

export interface FollowUp {
  id: string;
  leadId: string;
  leadNumber: string;
  leadName: string;
  companyName: string | null;
  mobile: string | null;
  leadStatus: string;
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

export type FollowUpBucket = 'today' | 'upcoming' | 'overdue' | 'completed';

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
    mutationFn: (input: {
      scheduledAt: string;
      type?: string;
      title?: string;
      notes?: string;
      assignedUserId?: string;
    }) => apiPost<FollowUp>(`/leads/${leadId}/follow-ups`, input),
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
    mutationFn: ({ id, ...input }: CompleteFollowUpInput & { id: string; leadId?: string }) =>
      apiPost<{ followUp: FollowUp; nextFollowUpAt: string | null }>(
        `/follow-ups/${id}/complete`,
        input,
      ),
    onSuccess: (_result, variables) => refresh(variables.leadId),
  });
}

export function useRescheduleFollowUp() {
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: ({
      id,
      ...input
    }: {
      id: string;
      leadId?: string;
      scheduledAt: string;
      type?: string;
      reason?: string;
    }) => apiPost<FollowUp>(`/follow-ups/${id}/reschedule`, input),
    onSuccess: (_result, variables) => refresh(variables.leadId),
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
