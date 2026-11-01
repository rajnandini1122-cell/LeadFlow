import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { LeadQualification } from '@leadflow/api-types';
import { apiGet, apiPost } from '../../lib/api-client';
import { useRefreshLeadData } from './use-lead-mutations';

export interface QualificationView {
  leadId: string;
  qualification: LeadQualification;
  checklist: { company: boolean; contact: boolean };
  refinedAt: string | null;
  refinedBy: { id: string; fullName: string } | null;
  refinementOutcome: string | null;
  refinementNote: string | null;
}

const key = (leadId: string | undefined) => ['lead-qualification', leadId] as const;

export function useLeadQualification(leadId: string | undefined): UseQueryResult<QualificationView> {
  return useQuery({
    queryKey: key(leadId),
    queryFn: () => apiGet<QualificationView>(`/leads/${leadId as string}/qualification`),
    enabled: Boolean(leadId),
  });
}

/** Qualification changes move the lead between lists, queues and counts. */
function useAfterChange(leadId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshLeadData();
  return () => {
    void queryClient.invalidateQueries({ queryKey: key(leadId) });
    void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['lead-contacts', leadId] });
    refresh(leadId);
  };
}

export function useQualificationNote(leadId: string) {
  const after = useAfterChange(leadId);
  return useMutation({
    mutationFn: (input: { outcome: string; note?: string; nextQualificationAt?: string; contactId?: string }) =>
      apiPost<QualificationView>(`/leads/${leadId}/qualification/notes`, input),
    onSuccess: after,
  });
}

export function useRefineLead(leadId: string) {
  const after = useAfterChange(leadId);
  return useMutation({
    mutationFn: (input: { outcome: string; note?: string; businessFitConfirmed: boolean }) =>
      apiPost<QualificationView>(`/leads/${leadId}/refine`, input),
    onSuccess: after,
  });
}

export function useRevertToRough(leadId: string) {
  const after = useAfterChange(leadId);
  return useMutation({
    mutationFn: (input: { reason: string }) => apiPost<QualificationView>(`/leads/${leadId}/revert-to-rough`, input),
    onSuccess: after,
  });
}
