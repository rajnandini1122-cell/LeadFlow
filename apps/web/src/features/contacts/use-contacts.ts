import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { LeadStatus, Paginated } from '@leadflow/api-types';
import { apiGet, apiPatch, apiPost } from '../../lib/api-client';

export interface Contact {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  mobile: string | null;
  email: string | null;
  companyName: string | null;
  city: string | null;
  notes: string | null;
  leadCount: number;
  createdAt: string;
}

export interface ContactLead {
  id: string;
  leadNumber: string;
  status: LeadStatus;
  priority: string;
  estimatedValue: string | null;
  nextFollowUpAt: string | null;
  assignedTo: { id: string; fullName: string } | null;
  createdAt: string;
}

export type ContactDetail = Contact & {
  /** Set when this record was absorbed by another — it is a tombstone. */
  mergedIntoId: string | null;
  leads: ContactLead[];
};

export type DuplicateCandidate = Contact & { matchedOn: string[] };

export interface DuplicateGroup {
  matchedOn: 'mobile' | 'email';
  value: string;
  contacts: Contact[];
}

/** Which record wins each contested field during a merge. */
export type FieldChoices = Partial<
  Record<'firstName' | 'lastName' | 'mobile' | 'email' | 'companyName' | 'city' | 'notes',
  'source' | 'target'>
>;

const PAGE_SIZE = 25;

function useRefreshContacts(): (contactId?: string) => void {
  const queryClient = useQueryClient();

  return (contactId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['contacts'] });
    void queryClient.invalidateQueries({ queryKey: ['contact-duplicates'] });
    // A merge moves leads between contacts, so the lead lists are stale too.
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    if (contactId) void queryClient.invalidateQueries({ queryKey: ['contact', contactId] });
  };
}

export function useContacts(
  search: string,
): UseInfiniteQueryResult<InfiniteData<Paginated<Contact>>> {
  return useInfiniteQuery({
    queryKey: ['contacts', 'page', search],
    queryFn: ({ pageParam }) =>
      apiGet<Paginated<Contact>>('/contacts', {
        limit: PAGE_SIZE,
        ...(search ? { search } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useContact(id: string | undefined): UseQueryResult<ContactDetail> {
  return useQuery({
    queryKey: ['contact', id],
    queryFn: () => apiGet<ContactDetail>(`/contacts/${id as string}`),
    enabled: Boolean(id),
  });
}

export function useContactDuplicates(
  id: string | undefined,
): UseQueryResult<DuplicateCandidate[]> {
  return useQuery({
    queryKey: ['contact-duplicates', id],
    queryFn: () => apiGet<DuplicateCandidate[]>(`/contacts/${id as string}/duplicates`),
    enabled: Boolean(id),
  });
}

export function useDuplicateGroups(enabled: boolean): UseQueryResult<DuplicateGroup[]> {
  return useQuery({
    queryKey: ['contact-duplicates', 'all'],
    queryFn: () => apiGet<DuplicateGroup[]>('/contacts/duplicates'),
    enabled,
  });
}

export function useUpdateContact(
  id: string,
): UseMutationResult<Contact, Error, Record<string, unknown>> {
  const refresh = useRefreshContacts();

  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPatch<Contact>(`/contacts/${id}`, body),
    onSuccess: () => refresh(id),
  });
}

export function useCreateContact(): UseMutationResult<Contact, Error, Record<string, unknown>> {
  const refresh = useRefreshContacts();

  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<Contact>('/contacts', body),
    onSuccess: () => refresh(),
  });
}

export interface MergeInput {
  sourceId: string;
  targetId: string;
  fieldChoices?: FieldChoices;
}

/**
 * Merges two contacts.
 *
 * Never called automatically — the API requires the ids explicitly and the UI
 * requires a confirmation step, because a merge cannot be undone.
 */
export function useMergeContacts(): UseMutationResult<
  { targetId: string; leadsMoved: number },
  Error,
  MergeInput
> {
  const refresh = useRefreshContacts();

  return useMutation({
    mutationFn: (input: MergeInput) =>
      apiPost<{ targetId: string; leadsMoved: number }>('/contacts/merge', input),
    onSuccess: (_result, input) => {
      // Both records change: one absorbs the leads, the other becomes a
      // tombstone, and either may be open in another tab.
      refresh(input.targetId);
      refresh(input.sourceId);
    },
  });
}
