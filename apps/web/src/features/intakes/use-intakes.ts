import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  IntakeRetryResponse,
  IntegrationIntakeDetail,
  IntegrationIntakePage,
  IntegrationIntakeQuery,
  LeadSourceIntake,
} from '@leadflow/api-types';
import { apiGet, apiPost } from '../../lib/api-client';

/** The website intake queue, and the one action it offers. */

export const intakeKeys = {
  all: ['integration-intakes'] as const,
  list: (query: IntegrationIntakeQuery) => ['integration-intakes', query] as const,
  one: (id: string) => ['integration-intakes', 'detail', id] as const,
};

export function useIntakes(query: IntegrationIntakeQuery) {
  const search = new URLSearchParams();
  if (query.status) search.set('status', query.status);
  if (query.source) search.set('source', query.source);
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  if (query.offset !== undefined) search.set('offset', String(query.offset));

  const suffix = search.toString();

  return useQuery({
    queryKey: intakeKeys.list(query),
    queryFn: () =>
      apiGet<IntegrationIntakePage>(`/integration-intakes${suffix ? `?${suffix}` : ''}`),
  });
}

export function useIntake(id: string | null) {
  return useQuery({
    queryKey: intakeKeys.one(id ?? ''),
    queryFn: () => apiGet<IntegrationIntakeDetail>(`/integration-intakes/${id as string}`),
    enabled: id !== null,
  });
}

/**
 * Routes the same enquiry again.
 *
 * No payload, and that is the contract rather than an omission: retry means
 * "evaluate what the customer sent, now that the configuration is fixed". An
 * operations screen that could edit a submission would eventually be used to.
 */
export function useRetryIntake() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiPost<IntakeRetryResponse>(`/integration-intakes/${id}/retry`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: intakeKeys.all }),
  });
}

/**
 * The website enquiry behind one lead.
 *
 * Read through the lead, not the operations queue: the salesperson answering
 * this customer needs their actual words and has no business in an operations
 * tool. Null when the lead was created by hand.
 */
export function useLeadSourceIntake(leadId: string) {
  return useQuery({
    queryKey: ['leads', leadId, 'source-intake'],
    queryFn: () => apiGet<LeadSourceIntake | null>(`/leads/${leadId}/source-intake`),
  });
}
