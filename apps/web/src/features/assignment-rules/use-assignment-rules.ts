import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignmentPreviewRequest,
  AssignmentPreviewResult,
  AssignmentRuleView,
  CreateAssignmentRuleRequest,
  UpdateAssignmentRuleRequest,
} from '@leadflow/api-types';
import { apiGet, apiPatch, apiPost } from '../../lib/api-client';

/** The routing table, and the read-only question you can ask of it. */

export const ruleKeys = {
  list: ['assignment-rules'] as const,
};

export function useAssignmentRules() {
  return useQuery({
    queryKey: ruleKeys.list,
    queryFn: () => apiGet<AssignmentRuleView[]>('/assignment-rules'),
  });
}

export function useCreateRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateAssignmentRuleRequest) =>
      apiPost<AssignmentRuleView>('/assignment-rules', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ruleKeys.list }),
  });
}

export function useUpdateRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string } & UpdateAssignmentRuleRequest) => {
      const { id, ...changes } = input;
      return apiPatch<AssignmentRuleView>(`/assignment-rules/${id}`, changes);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ruleKeys.list }),
  });
}

/**
 * Asks where a hypothetical enquiry would go.
 *
 * A mutation rather than a query because it POSTs a body — NOT because it
 * changes anything. It writes nothing at all: no lead, no intake, no
 * follow-up, and no cursor that would make asking twice give two answers.
 */
export function usePreviewAssignment() {
  return useMutation({
    mutationFn: (body: AssignmentPreviewRequest) =>
      apiPost<AssignmentPreviewResult>('/assignment-rules/preview', body),
  });
}
