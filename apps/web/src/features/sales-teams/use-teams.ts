import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddTeamMemberRequest,
  CreateTeamRequest,
  TeamAgentCandidate,
  TeamDetail,
  TeamListItem,
  UpdateTeamMemberRequest,
  UpdateTeamRequest,
} from '@leadflow/api-types';
import { apiGet, apiPatch, apiPost } from '../../lib/api-client';

/**
 * Sales team data.
 *
 * Every mutation answers with the whole team, so the cache is replaced with
 * what the server actually stored rather than patched with what the browser
 * hoped for — which is how a paused member reappears as available after a
 * failed request.
 */

export const teamKeys = {
  list: (includeArchived: boolean) => ['teams', { includeArchived }] as const,
  detail: (id: string) => ['teams', id] as const,
  agents: ['teams', 'agents'] as const,
};

export function useTeams(includeArchived: boolean, enabled = true) {
  return useQuery({
    queryKey: teamKeys.list(includeArchived),
    queryFn: () =>
      apiGet<TeamListItem[]>('/teams', includeArchived ? { includeArchived: 'true' } : undefined),
    enabled,
  });
}

export function useTeam(id: string | undefined) {
  return useQuery({
    queryKey: teamKeys.detail(id ?? ''),
    queryFn: () => apiGet<TeamDetail>(`/teams/${id}`),
    enabled: Boolean(id),
  });
}

/** Everyone in the organization, with the teams they are already in. */
export function useAgents(enabled = true) {
  return useQuery({
    queryKey: teamKeys.agents,
    queryFn: () => apiGet<TeamAgentCandidate[]>('/teams/agents'),
    enabled,
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateTeamRequest) => apiPost<TeamDetail>('/teams', body),
    onSuccess: () => invalidateTeams(queryClient),
  });
}

export function useUpdateTeam(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: UpdateTeamRequest) => apiPatch<TeamDetail>(`/teams/${id}`, body),
    onSuccess: (team) => {
      queryClient.setQueryData(teamKeys.detail(id), team);
      void invalidateTeams(queryClient);
    },
  });
}

export function useAddTeamMember(teamId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: AddTeamMemberRequest) =>
      apiPost<TeamDetail>(`/teams/${teamId}/members`, body),
    onSuccess: (team) => {
      queryClient.setQueryData(teamKeys.detail(teamId), team);
      void invalidateTeams(queryClient);
    },
  });
}

export function useRemoveTeamMember(teamId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (memberId: string) =>
      apiPost<TeamDetail>(`/teams/${teamId}/members/${memberId}/remove`),
    onSuccess: (team) => {
      queryClient.setQueryData(teamKeys.detail(teamId), team);
      void invalidateTeams(queryClient);
    },
  });
}

export function useSetMemberAssignment(teamId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { memberId: string } & UpdateTeamMemberRequest) =>
      apiPatch<TeamDetail>(`/teams/${teamId}/members/${input.memberId}`, {
        assignmentEnabled: input.assignmentEnabled,
      }),
    onSuccess: (team) => {
      queryClient.setQueryData(teamKeys.detail(teamId), team);
      void invalidateTeams(queryClient);
    },
  });
}

/** The agent directory carries team membership, so it goes stale with the list. */
function invalidateTeams(queryClient: ReturnType<typeof useQueryClient>): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['teams'] }),
    queryClient.invalidateQueries({ queryKey: teamKeys.agents }),
  ]);
}
