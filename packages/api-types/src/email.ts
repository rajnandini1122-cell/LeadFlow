/**
 * Email campaigns: the shapes the web app and the API agree on.
 * See docs/email/LEADFLOW_EMAIL_ARCHITECTURE.md.
 */

export type MailSecurity = 'SSL_TLS' | 'STARTTLS';

/** The mailbox as the settings screen sees it. There is no password field, by design. */
export interface MailboxView {
  configured: boolean;
  emailAddress: string | null;
  description: string | null;
  username: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecurity: MailSecurity | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: MailSecurity | null;
  passwordSet: boolean;
  passwordUpdatedAt: string | null;
  enabled: boolean;
  hourlyLimit: number;
  dailyLimit: number;
  smtp: { checkedAt: string | null; okAt: string | null; error: string | null };
  imap: { checkedAt: string | null; okAt: string | null; error: string | null };
  sync: { at: string | null; error: string | null; count: number | null };
  /** Platform switches, so the screen can say why nothing is being sent. */
  platform: { sendingEnabled: boolean; dispatcherEnabled: boolean };
}

export interface MailConnectionTestResult {
  ok: boolean;
  message: string;
  checkedAt: string;
}

export const EMAIL_CAMPAIGN_CATEGORIES = [
  'PROMOTIONAL_OFFER',
  'PRODUCT_ANNOUNCEMENT',
  'PRODUCT_CATALOGUE',
  'SALES_FOLLOW_UP',
  'CUSTOMER_UPDATE',
  'CUSTOM',
] as const;
export type EmailCampaignCategory = (typeof EMAIL_CAMPAIGN_CATEGORIES)[number];

export const EMAIL_CAMPAIGN_PURPOSES = ['PROMOTIONAL', 'TRANSACTIONAL'] as const;
export type EmailCampaignPurpose = (typeof EMAIL_CAMPAIGN_PURPOSES)[number];

export type EmailCampaignStatus = 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type EmailRecipientStatus = 'QUEUED' | 'SENDING' | 'ACCEPTED' | 'FAILED' | 'UNCERTAIN' | 'CANCELLED' | 'SKIPPED';

export const MARKETING_CONSENT_BASES = ['CONSENT', 'EXISTING_CUSTOMER', 'LEGITIMATE_INTEREST_REVIEWED'] as const;
export type MarketingConsentBasis = (typeof MARKETING_CONSENT_BASES)[number];

export const EMAIL_SUPPRESSION_REASONS = ['UNSUBSCRIBED', 'BOUNCED', 'COMPLAINT', 'MANUAL'] as const;
export type EmailSuppressionReason = (typeof EMAIL_SUPPRESSION_REASONS)[number];

/** Merge fields a template may use. Anything else is refused when saving. */
export const EMAIL_MERGE_FIELDS = [
  'first_name',
  'last_name',
  'full_name',
  'company',
  'city',
  'organization',
  'sender_name',
] as const;
export type EmailMergeField = (typeof EMAIL_MERGE_FIELDS)[number];

/** Why an address the filter matched will not be sent to. */
export const EMAIL_EXCLUSION_REASONS = ['INVALID', 'SUPPRESSED', 'NO_CONSENT', 'DUPLICATE'] as const;
export type EmailExclusionReason = (typeof EMAIL_EXCLUSION_REASONS)[number];

export interface EmailRecipientFilter {
  statuses?: string[];
  priorities?: string[];
  sources?: string[];
  cities?: string[];
  states?: string[];
  countries?: string[];
  productIds?: string[];
  assignedToIds?: string[];
  industries?: string[];
  qualifications?: string[];
  includeContacts?: boolean;
}

export interface EmailAudiencePreview {
  selected: number;
  eligible: number;
  excluded: Record<EmailExclusionReason, number>;
  sample: { email: string; name: string | null; company: string | null }[];
}

export interface EmailTemplateView {
  id: string;
  name: string;
  category: EmailCampaignCategory;
  subject: string;
  html: string;
  text: string;
  archived: boolean;
  updatedAt: string;
}

export interface EmailAssetView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  productId: string | null;
  productName: string | null;
  createdAt: string;
}

export interface EmailCampaignCounts {
  selected: number;
  eligible: number;
  excluded: Partial<Record<EmailExclusionReason, number>>;
  queued: number;
  sending: number;
  attempted: number;
  accepted: number;
  retrying: number;
  failed: number;
  uncertain: number;
  cancelled: number;
  skipped: number;
  replies: number;
  unsubscribes: number;
}

export interface EmailCampaignView {
  id: string;
  name: string;
  category: EmailCampaignCategory;
  purpose: EmailCampaignPurpose;
  status: EmailCampaignStatus;
  subject: string;
  html: string;
  text: string;
  assetIds: string[];
  filter: EmailRecipientFilter;
  scheduledAt: string | null;
  confirmedAt: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  counts: EmailCampaignCounts;
}

export interface EmailCampaignListItem {
  id: string;
  name: string;
  category: EmailCampaignCategory;
  purpose: EmailCampaignPurpose;
  status: EmailCampaignStatus;
  subject: string;
  scheduledAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  counts: Pick<EmailCampaignCounts, 'eligible' | 'accepted' | 'failed' | 'replies' | 'unsubscribes'>;
}

export interface EmailCampaignRecipientView {
  id: string;
  email: string;
  name: string | null;
  leadId: string | null;
  status: EmailRecipientStatus;
  attempts: number;
  lastSmtpCode: number | null;
  lastResponse: string | null;
  skipReason: string | null;
  acceptedAt: string | null;
  failedAt: string | null;
  repliedAt: string | null;
  unsubscribedAt: string | null;
}

export interface EmailRenderedPreview {
  subject: string;
  html: string;
  text: string;
  attachments: { fileName: string; sizeBytes: number }[];
  sampleRecipient: string | null;
}

export interface EmailReplyView {
  id: string;
  fromAddress: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string | null;
  leadId: string | null;
  leadName: string | null;
  recipientEmail: string | null;
}

export interface MarketingEligibilityView {
  email: string;
  name: string | null;
  company: string | null;
  /** Where LeadFlow knows the address from. */
  sources: ('LEAD' | 'CONTACT')[];
  status: 'GRANTED' | 'WITHDRAWN' | 'UNKNOWN';
  basis: MarketingConsentBasis | null;
  source: string | null;
  note: string | null;
  recordedAt: string | null;
  suppressed: EmailSuppressionReason | null;
}

export interface EmailSuppressionView {
  email: string;
  reason: EmailSuppressionReason;
  source: string;
  note: string | null;
  createdAt: string;
}

export interface UnsubscribeInfo {
  organizationName: string;
  alreadyUnsubscribed: boolean;
}
