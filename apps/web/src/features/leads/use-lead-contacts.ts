import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { LeadContactView } from '@leadflow/api-types';
import { apiGet, apiPatch, apiPost } from '../../lib/api-client';
import { useRefreshLeadData } from './use-lead-mutations';

export type LeadContact = LeadContactView;

/** What the add / edit form sends. Blank optional fields are left out (add) or cleared (edit). */
export interface LeadContactInput {
  firstName: string;
  lastName?: string;
  designation?: string;
  department?: string;
  mobile?: string;
  whatsapp?: string;
  email?: string;
  notes?: string;
  isPrimary?: boolean;
  allowDuplicate?: boolean;
}

const key = (leadId: string | undefined) => ['lead-contacts', leadId] as const;

export function useLeadContacts(leadId: string | undefined): UseQueryResult<LeadContact[]> {
  return useQuery({
    queryKey: key(leadId),
    queryFn: () => apiGet<LeadContact[]>(`/leads/${leadId as string}/contacts`),
    // An unexpected payload must never take the whole lead page down with it.
    select: (data) => (Array.isArray(data) ? data : []),
    enabled: Boolean(leadId),
  });
}

/** Contacts changed: this list, the lead (primary shown in lists) and its timeline. */
function useAfterChange(leadId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshLeadData();
  return () => {
    void queryClient.invalidateQueries({ queryKey: key(leadId) });
    refresh(leadId);
  };
}

export function useAddLeadContact(leadId: string) {
  const after = useAfterChange(leadId);
  return useMutation({
    mutationFn: (input: LeadContactInput) => apiPost<LeadContact>(`/leads/${leadId}/contacts`, input),
    onSuccess: after,
  });
}

export function useUpdateLeadContact(leadId: string) {
  const after = useAfterChange(leadId);
  return useMutation({
    mutationFn: ({ linkId, ...input }: Partial<LeadContactInput> & { linkId: string }) =>
      apiPatch<LeadContact>(`/leads/${leadId}/contacts/${linkId}`, input),
    onSuccess: after,
  });
}

export function useLeadContactAction(leadId: string) {
  const after = useAfterChange(leadId);
  return useMutation({
    mutationFn: ({ linkId, action }: { linkId: string; action: 'primary' | 'deactivate' | 'reactivate' }) =>
      apiPost<LeadContact[]>(`/leads/${leadId}/contacts/${linkId}/${action}`),
    onSuccess: after,
  });
}

export function contactLabel(contact: { name: string; designation: string | null }): string {
  return contact.designation ? `${contact.name} · ${contact.designation}` : contact.name;
}
