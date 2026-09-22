import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddTerritoryCoverageRequest,
  CreateTerritoryRequest,
  ResolveTerritoryRequest,
  TerritoryDetail,
  TerritoryListItem,
  TerritoryResolution,
  UpdateTerritoryRequest,
} from '@leadflow/api-types';
import { apiGet, apiPatch, apiPost } from '../../lib/api-client';

/** The map, and the read-only question you can ask of it. */

export const territoryKeys = {
  list: ['territories'] as const,
};

export function useTerritories(enabled = true) {
  return useQuery({
    queryKey: territoryKeys.list,
    queryFn: () => apiGet<TerritoryListItem[]>('/territories'),
    enabled,
  });
}

/**
 * One territory, with the places it covers.
 *
 * Fetched separately rather than folded into the list: a tenant with fifty
 * territories and a few hundred selectors between them should not carry all of
 * it to render a table of names, and the coverage editor only ever shows one
 * territory at a time.
 */
export function useTerritory(id: string | null) {
  return useQuery({
    queryKey: ['territories', id],
    queryFn: () => apiGet<TerritoryDetail>(`/territories/${id as string}`),
    enabled: id !== null,
  });
}

export function useCreateTerritory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateTerritoryRequest) => apiPost<TerritoryDetail>('/territories', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: territoryKeys.list }),
  });
}

export function useUpdateTerritory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string } & UpdateTerritoryRequest) => {
      const { id, ...changes } = input;
      return apiPatch<TerritoryDetail>(`/territories/${id}`, changes);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: territoryKeys.list }),
  });
}

export function useAddCoverage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { territoryId: string } & AddTerritoryCoverageRequest) => {
      const { territoryId, ...body } = input;
      return apiPost<TerritoryDetail>(`/territories/${territoryId}/coverage`, body);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: territoryKeys.list }),
  });
}

/**
 * Stops a place resolving to a territory.
 *
 * POST .../remove rather than DELETE, matching the API: the row is kept, so
 * calling it a delete would promise something it does not do.
 */
export function useRemoveCoverage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { territoryId: string; coverageId: string }) =>
      apiPost<TerritoryDetail>(
        `/territories/${input.territoryId}/coverage/${input.coverageId}/remove`,
        {},
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: territoryKeys.list }),
  });
}

/**
 * Asks where a location belongs.
 *
 * A mutation because it POSTs a body — NOT because it changes anything. It
 * writes nothing: no lead, no intake, no rule, and no change to the coverage
 * it read.
 */
export function useResolveTerritory() {
  return useMutation({
    mutationFn: (body: ResolveTerritoryRequest) =>
      apiPost<TerritoryResolution>('/territories/resolve', body),
  });
}
