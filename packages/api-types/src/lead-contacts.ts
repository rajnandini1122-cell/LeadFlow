/**
 * Points of contact (POCs) on a lead -- the contract shared by the API, the web
 * app and the Android app (which is the same web bundle in a WebView).
 */

/** Most active people one lead can carry. Generous; it stops runaway clients. */
export const MAX_LEAD_CONTACTS = 25;

/** Most extra people that can be sent with a NEW lead, on top of the enquirer. */
export const MAX_CONTACTS_ON_CREATE = 10;

/**
 * Suggestions for the department field. Free text is still accepted: these
 * are what the form offers, not a closed list.
 */
export const CONTACT_DEPARTMENTS = [
  'Purchase',
  'Procurement',
  'Accounts',
  'Owner',
  'Management',
  'Quality',
  'Production',
  'Logistics',
  'Sales',
] as const;

export interface LeadContactView {
  /** The link id -- what the edit, primary and deactivate endpoints take. */
  id: string;
  /** The person (contacts.id). Shared by every lead this person is on. */
  contactId: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  designation: string | null;
  department: string | null;
  /** E.164. */
  mobile: string | null;
  /** E.164, only when different from `mobile`. */
  whatsapp: string | null;
  email: string | null;
  notes: string | null;
  isPrimary: boolean;
  active: boolean;
  inactiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The short form shown in lists and on follow-ups. */
export interface ContactRef {
  id: string;
  name: string;
  designation: string | null;
  mobile: string | null;
}
