/**
 * Neutral lead sources, used when an organization has configured none of its
 * own.
 *
 * Country-agnostic on purpose: the previous list was India-specific and baked
 * into the client, which made the product read as a regional tool. Tenants
 * override this in organization settings.
 */
export const DEFAULT_LEAD_SOURCES = [
  'Website',
  'Referral',
  'Inbound call',
  'Email',
  'Trade show',
  'Social media',
  'Partner',
  'Outbound',
  'Other',
];
