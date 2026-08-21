import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Paginated, RoleKey } from '@leadflow/api-types';
import { api, apiGet, apiPost } from '../../lib/api-client';

export interface EligibleSuccessor {
  id: string;
  fullName: string;
  role: RoleKey;
}

export interface WorkloadReport {
  userId: string;
  fullName: string;
  role: RoleKey;
  status: string;
  activeLeads: number;
  openFollowUps: number;
  wonLeads: number;
  lostLeads: number;
  archivedLeads: number;
  pipelineValue: string;
  /** True when an exit would orphan work unless a successor is named. */
  requiresReassignment: boolean;
  eligibleSuccessors: EligibleSuccessor[];
}

export interface OffboardInput {
  action: 'DEACTIVATE' | 'REMOVE';
  reassignToId?: string;
  includeHistorical?: boolean;
  reason?: string;
}

export interface OffboardResult {
  action: 'DEACTIVATE' | 'REMOVE';
  userId: string;
  reassignToId: string | null;
  leadsReassigned: number;
  historicalLeadsReassigned: number;
  followUpsReassigned: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actor: { id: string; fullName: string } | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Everything a handover invalidates.
 *
 * Leads change owner, follow-ups change assignee, the roster changes and every
 * aggregate figure moves. Listing the keys at each call site guarantees one
 * eventually gets missed and the screen shows numbers that are no longer true.
 */
function useRefreshAfterHandover(): () => void {
  const queryClient = useQueryClient();

  return () => {
    for (const key of [
      ['users'],
      ['workload'],
      ['leads'],
      ['follow-ups'],
      ['dashboard'],
      ['report-team'],
      ['report-overview'],
      ['report-daily'],
      ['audit-trail'],
      ['my-organizations'],
    ]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/**
 * What a member is carrying right now.
 *
 * Fetched only when the offboarding dialog opens: the counts drive an
 * irreversible decision, so they must be current rather than whatever was
 * loaded when the page was opened.
 */
export function useWorkload(userId: string | undefined): UseQueryResult<WorkloadReport> {
  return useQuery({
    queryKey: ['workload', userId],
    queryFn: () => apiGet<WorkloadReport>(`/users/${userId as string}/workload`),
    enabled: Boolean(userId),
    staleTime: 0,
  });
}

export function useOffboard(
  userId: string,
): UseMutationResult<OffboardResult, Error, OffboardInput> {
  const refresh = useRefreshAfterHandover();

  return useMutation({
    mutationFn: (input: OffboardInput) =>
      apiPost<OffboardResult>(`/users/${userId}/offboard`, input),
    onSuccess: refresh,
  });
}

export function useTransferAdmin(): UseMutationResult<
  { newAdminId: string; steppedDown: boolean },
  Error,
  { toUserId: string; stepDown: boolean }
> {
  const refresh = useRefreshAfterHandover();

  return useMutation({
    mutationFn: (input: { toUserId: string; stepDown: boolean }) =>
      apiPost<{ newAdminId: string; steppedDown: boolean }>('/users/transfer-admin', input),
    onSuccess: refresh,
  });
}

/** The caller leaves, optionally handing their work to a colleague. */
export function useLeaveOrganization(): UseMutationResult<
  void,
  Error,
  { reassignToId?: string } | void
> {
  return useMutation({
    mutationFn: async (input: { reassignToId?: string } | void) => {
      await api.post('/organizations/leave', input ?? {});
    },
  });
}

export function useAuditTrail(enabled: boolean): UseQueryResult<Paginated<AuditEntry>> {
  return useQuery({
    queryKey: ['audit-trail'],
    queryFn: () => apiGet<Paginated<AuditEntry>>('/organizations/audit', { limit: 50 }),
    enabled,
  });
}

/** Audit action keys rendered as something a person would say. */
export const AUDIT_LABELS: Record<string, string> = {
  'user.offboarded': 'Member offboarded',
  'user.removed': 'Member removed',
  'user.left_organization': 'Member left',
  'user.role_changed': 'Role changed',
  'user.updated': 'Member updated',
  'user.invited': 'Member invited',
  'user.suspended': 'Member suspended',
  'user.admin_transferred': 'Admin responsibility transferred',
  'lead.bulk_reassigned': 'Leads reassigned in bulk',
  'organization.updated': 'Organization updated',
};
