import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EmailAssetView,
  EmailAudiencePreview,
  EmailCampaignCategory,
  EmailCampaignListItem,
  EmailCampaignPurpose,
  EmailCampaignRecipientView,
  EmailCampaignView,
  EmailRecipientFilter,
  EmailRecipientStatus,
  EmailRenderedPreview,
  EmailReplyView,
  EmailSuppressionView,
  EmailTemplateView,
  MailboxView,
  MailConnectionTestResult,
  MailSecurity,
  MarketingConsentBasis,
  MarketingEligibilityView,
  UnsubscribeInfo,
} from '@leadflow/api-types';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../../lib/api-client';

/**
 * Email: the mailbox, eligibility, templates and campaigns.
 *
 * Counts come from the server and are shown as they are: "accepted by the mail
 * server" is never relabelled "delivered", and there are no open or click
 * figures because LeadFlow does not track them.
 */

export interface MailboxInput {
  emailAddress: string;
  description?: string;
  username?: string;
  password?: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: MailSecurity;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSecurity;
}

export interface CampaignInput {
  name: string;
  category: EmailCampaignCategory;
  purpose: EmailCampaignPurpose;
  templateId?: string;
  subject: string;
  html: string;
  text?: string;
  assetIds: string[];
  filter: EmailRecipientFilter;
}

export const emailKeys = {
  mailbox: ['email', 'mailbox'] as const,
  eligibility: (search: string) => ['email', 'eligibility', search] as const,
  suppressions: ['email', 'suppressions'] as const,
  templates: ['email', 'templates'] as const,
  assets: ['email', 'assets'] as const,
  campaigns: ['email', 'campaigns'] as const,
  campaign: (id: string) => ['email', 'campaign', id] as const,
  recipients: (id: string, status: string) =>
    ['email', 'campaign', id, 'recipients', status] as const,
  replies: (id: string) => ['email', 'campaign', id, 'replies'] as const,
  preview: (id: string) => ['email', 'campaign', id, 'preview'] as const,
};

// --- mailbox -------------------------------------------------------------------

export function useMailbox() {
  return useQuery({
    queryKey: emailKeys.mailbox,
    queryFn: () => apiGet<MailboxView>('/email/mailbox'),
  });
}

export function useSaveMailbox() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MailboxInput) => apiPut<MailboxView>('/email/mailbox', input),
    onSuccess: (view) => client.setQueryData(emailKeys.mailbox, view),
  });
}

export function useTestMailbox() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (kind: 'smtp' | 'imap') =>
      apiPost<MailConnectionTestResult>(`/email/mailbox/test/${kind}`),
    onSettled: () => void client.invalidateQueries({ queryKey: emailKeys.mailbox }),
  });
}

export function useMailboxSending() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { enabled?: boolean; hourlyLimit?: number; dailyLimit?: number }) =>
      apiPatch<MailboxView>('/email/mailbox/sending', input),
    onSuccess: (view) => client.setQueryData(emailKeys.mailbox, view),
  });
}

// --- eligibility -----------------------------------------------------------------

export function useEligibility(search: string) {
  return useQuery({
    queryKey: emailKeys.eligibility(search),
    queryFn: () =>
      apiGet<MarketingEligibilityView[]>('/email/eligibility', search ? { search } : undefined),
  });
}

export function useGrantEligibility() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { emails: string[]; basis: MarketingConsentBasis; note: string }) =>
      apiPost<{ granted: string[]; refused: { email: string; reason: string }[] }>(
        '/email/eligibility/grant',
        input,
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['email', 'eligibility'] }),
  });
}

export function useWithdrawEligibility() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { emails: string[]; note?: string }) =>
      apiPost('/email/eligibility/withdraw', input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['email', 'eligibility'] }),
  });
}

export function useSuppressions() {
  return useQuery({
    queryKey: emailKeys.suppressions,
    queryFn: () => apiGet<EmailSuppressionView[]>('/email/suppressions'),
  });
}

export function useSuppress() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { emails: string[]; note: string }) =>
      apiPost('/email/suppressions', input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['email'] }),
  });
}

// --- templates and attachments -----------------------------------------------------

export function useTemplates() {
  return useQuery({
    queryKey: emailKeys.templates,
    queryFn: () => apiGet<EmailTemplateView[]>('/email/templates'),
  });
}

export function useSaveTemplate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...input
    }: {
      id?: string;
      name: string;
      category: EmailCampaignCategory;
      subject: string;
      html: string;
      text?: string;
    }) =>
      id
        ? apiPut<EmailTemplateView>(`/email/templates/${id}`, input)
        : apiPost<EmailTemplateView>('/email/templates', input),
    onSuccess: () => void client.invalidateQueries({ queryKey: emailKeys.templates }),
  });
}

export function useAssets() {
  return useQuery({
    queryKey: emailKeys.assets,
    queryFn: () => apiGet<EmailAssetView[]>('/email/assets'),
  });
}

export function useUploadAsset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ file, productId }: { file: File; productId?: string }) => {
      const form = new FormData();
      form.append('file', file);
      if (productId) form.append('productId', productId);
      return apiPost<EmailAssetView>('/email/assets', form);
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: emailKeys.assets }),
  });
}

export function useDeleteAsset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/email/assets/${id}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: emailKeys.assets }),
  });
}

// --- campaigns ---------------------------------------------------------------------

export function useCampaigns() {
  return useQuery({
    queryKey: emailKeys.campaigns,
    queryFn: () => apiGet<EmailCampaignListItem[]>('/email/campaigns'),
  });
}

export function useCampaign(id: string | undefined, live = false) {
  return useQuery({
    queryKey: emailKeys.campaign(id ?? 'new'),
    queryFn: () => apiGet<EmailCampaignView>(`/email/campaigns/${id}`),
    enabled: Boolean(id),
    refetchInterval: live ? 10_000 : false,
  });
}

export function useSaveCampaign() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: CampaignInput }) =>
      id
        ? apiPut<EmailCampaignView>(`/email/campaigns/${id}`, input)
        : apiPost<EmailCampaignView>('/email/campaigns', input),
    onSuccess: (view) => {
      client.setQueryData(emailKeys.campaign(view.id), view);
      void client.invalidateQueries({ queryKey: emailKeys.campaigns });
      void client.invalidateQueries({ queryKey: emailKeys.preview(view.id) });
    },
  });
}

export function useAudiencePreview() {
  return useMutation({
    mutationFn: (input: { purpose: EmailCampaignPurpose; filter: EmailRecipientFilter }) =>
      apiPost<EmailAudiencePreview>('/email/campaigns/audience', input),
  });
}

export function useRenderedPreview(id: string | undefined) {
  return useQuery({
    queryKey: emailKeys.preview(id ?? 'new'),
    queryFn: () => apiGet<EmailRenderedPreview>(`/email/campaigns/${id}/preview`),
    enabled: Boolean(id),
  });
}

export function useTestSend() {
  return useMutation({
    mutationFn: (id: string) =>
      apiPost<{ sentTo: string; accepted: boolean; message: string }>(
        `/email/campaigns/${id}/test`,
      ),
  });
}

export function useCampaignAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: 'confirm' | 'pause' | 'resume' | 'cancel';
      body?: unknown;
    }) => apiPost<EmailCampaignView>(`/email/campaigns/${id}/${action}`, body),
    onSuccess: (view) => {
      client.setQueryData(emailKeys.campaign(view.id), view);
      void client.invalidateQueries({ queryKey: emailKeys.campaigns });
    },
  });
}

export function useCampaignRecipients(id: string, status: EmailRecipientStatus | '') {
  return useQuery({
    queryKey: emailKeys.recipients(id, status),
    queryFn: () =>
      apiGet<EmailCampaignRecipientView[]>(
        `/email/campaigns/${id}/recipients`,
        status ? { status } : undefined,
      ),
  });
}

export function useCampaignReplies(id: string) {
  return useQuery({
    queryKey: emailKeys.replies(id),
    queryFn: () => apiGet<EmailReplyView[]>(`/email/campaigns/${id}/replies`),
  });
}

// --- public ------------------------------------------------------------------------

export function useUnsubscribeInfo(token: string) {
  return useQuery({
    queryKey: ['unsubscribe', token],
    queryFn: () => apiGet<UnsubscribeInfo>(`/email/unsubscribe/${encodeURIComponent(token)}`),
    retry: false,
  });
}

export function useUnsubscribe() {
  return useMutation({
    mutationFn: (token: string) =>
      apiPost<UnsubscribeInfo>(`/email/unsubscribe/${encodeURIComponent(token)}`),
  });
}

export const CATEGORY_LABELS: Record<EmailCampaignCategory, string> = {
  PROMOTIONAL_OFFER: 'Promotional offer',
  PRODUCT_ANNOUNCEMENT: 'Product announcement',
  PRODUCT_CATALOGUE: 'Product catalogue',
  SALES_FOLLOW_UP: 'Sales follow-up',
  CUSTOMER_UPDATE: 'Customer update',
  CUSTOM: 'Custom',
};

export const BASIS_LABELS: Record<MarketingConsentBasis, string> = {
  CONSENT: 'They agreed to receive marketing email',
  EXISTING_CUSTOMER: 'Existing customer (similar products)',
  LEGITIMATE_INTEREST_REVIEWED: 'Legitimate interest, reviewed',
};
