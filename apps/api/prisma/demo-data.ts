import type { LeadPriority, LeadStatus } from '@leadflow/api-types';

/**
 * Demo dataset for local development and manual testing.
 *
 * Deliberately company-neutral and multi-region: the two demo organizations sit
 * in different countries, currencies and timezones so that a locale bug is
 * visible the moment you sign in rather than in a customer's first week.
 *
 * Shaped so the UI shows something meaningful immediately: leads across every
 * pipeline stage, follow-ups genuinely overdue / due today / upcoming, and a
 * realistic spread of deal sizes. Flat fixtures make a broken dashboard
 * indistinguishable from a working one.
 *
 * All names, companies and numbers are fictional.
 */

export interface DemoMember {
  email: string;
  fullName: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'SALES_REP';
  mobile: string;
}

export interface DemoLead {
  firstName: string;
  lastName: string;
  companyName: string;
  city: string;
  source: string;
  productInterest: string;
  estimatedValue: number;
  status: LeadStatus;
  priority: LeadPriority;
  /**
   * Days from now for the next follow-up. Negative = overdue, 0 = today.
   * Ignored for WON/LOST, which carry no next action by design.
   */
  followUpInDays: number;
  /** Days ago the lead was created — drives "new this week" style counts. */
  createdDaysAgo: number;
  assignTo: 'rep1' | 'rep2' | 'manager';
  lostReason?: string;
}

export interface DemoOrganization {
  name: string;
  slug: string;
  /** Locale settings differ per organization on purpose — see the file header. */
  timezone: string;
  currency: string;
  locale: string;
  country: string;
  /** E.164 dialling prefix used to build demo phone numbers. */
  phonePrefix: string;
  members: DemoMember[];
  leads: DemoLead[];
}

/** Neutral fallback when an organization has configured none of its own. */
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

export const DEMO_ORGANIZATIONS: DemoOrganization[] = [
  {
    name: 'Northwind Supply',
    slug: 'northwind-supply',
    timezone: 'America/Chicago',
    currency: 'USD',
    locale: 'en-US',
    country: 'US',
    phonePrefix: '+1415555',
    members: [
      { email: 'owner@northwind.example', fullName: 'Dana Whitfield', role: 'OWNER', mobile: '+14155550101' },
      { email: 'admin@northwind.example', fullName: 'Marcus Bell', role: 'ADMIN', mobile: '+14155550102' },
      { email: 'manager@northwind.example', fullName: 'Priya Raman', role: 'MANAGER', mobile: '+14155550103' },
      { email: 'sofia@northwind.example', fullName: 'Sofia Alvarez', role: 'SALES_REP', mobile: '+14155550104' },
      { email: 'tomas@northwind.example', fullName: 'Tomas Novak', role: 'SALES_REP', mobile: '+14155550105' },
    ],
    leads: [
      // --- overdue: what a manager must act on first ------------------------
      { firstName: 'Helen', lastName: 'Barrett', companyName: 'Barrett Industrial', city: 'Cleveland', source: 'Trade show', productInterest: 'Packaging line, 500 units/hr', estimatedValue: 185000, status: 'NEGOTIATION', priority: 'URGENT', followUpInDays: -4, createdDaysAgo: 42, assignTo: 'rep1' },
      { firstName: 'Omar', lastName: 'Haddad', companyName: 'Crescent Textiles', city: 'Charlotte', source: 'Referral', productInterest: 'Bulk dyeing units', estimatedValue: 94000, status: 'QUOTATION_SENT', priority: 'HIGH', followUpInDays: -2, createdDaysAgo: 30, assignTo: 'rep2' },
      { firstName: 'Grace', lastName: 'Okonkwo', companyName: 'Okonkwo Agro Foods', city: 'Des Moines', source: 'Inbound call', productInterest: 'Cold storage retrofit', estimatedValue: 62000, status: 'FOLLOW_UP', priority: 'HIGH', followUpInDays: -1, createdDaysAgo: 18, assignTo: 'rep1' },

      // --- due today --------------------------------------------------------
      { firstName: 'Aiden', lastName: 'Clarke', companyName: 'Bluewave Logistics', city: 'Seattle', source: 'Website', productInterest: 'Fleet tracking, 40 vehicles', estimatedValue: 48000, status: 'QUALIFIED', priority: 'HIGH', followUpInDays: 0, createdDaysAgo: 12, assignTo: 'rep2' },
      { firstName: 'Nadia', lastName: 'Fischer', companyName: 'Fischer Hardware', city: 'Denver', source: 'Outbound', productInterest: 'POS and inventory system', estimatedValue: 16500, status: 'CONTACTED', priority: 'MEDIUM', followUpInDays: 0, createdDaysAgo: 6, assignTo: 'rep1' },
      { firstName: 'Ravi', lastName: 'Deshpande', companyName: 'Sunrise Packaging', city: 'Austin', source: 'Trade show', productInterest: 'Corrugation machinery', estimatedValue: 125000, status: 'NEGOTIATION', priority: 'URGENT', followUpInDays: 0, createdDaysAgo: 55, assignTo: 'manager' },

      // --- upcoming ---------------------------------------------------------
      { firstName: 'Elena', lastName: 'Petrova', companyName: 'Petrova Auto Components', city: 'Detroit', source: 'Outbound', productInterest: 'CNC tooling contract', estimatedValue: 78000, status: 'QUALIFIED', priority: 'MEDIUM', followUpInDays: 1, createdDaysAgo: 9, assignTo: 'rep2' },
      { firstName: 'Jonah', lastName: 'Meyers', companyName: 'Meyers Home Decor', city: 'Portland', source: 'Social media', productInterest: 'Retail shelving, 3 stores', estimatedValue: 22000, status: 'CONTACTED', priority: 'LOW', followUpInDays: 2, createdDaysAgo: 4, assignTo: 'rep1' },
      { firstName: 'Bianca', lastName: 'Rossi', companyName: 'Rossi Constructions', city: 'Phoenix', source: 'Referral', productInterest: 'Site safety equipment', estimatedValue: 39500, status: 'FOLLOW_UP', priority: 'MEDIUM', followUpInDays: 3, createdDaysAgo: 21, assignTo: 'rep2' },
      { firstName: 'Kwame', lastName: 'Mensah', companyName: 'Mensah Pharma Distribution', city: 'Atlanta', source: 'Partner', productInterest: 'Temperature-controlled vans', estimatedValue: 142000, status: 'QUOTATION_SENT', priority: 'HIGH', followUpInDays: 4, createdDaysAgo: 26, assignTo: 'manager' },
      { firstName: 'Ingrid', lastName: 'Larsen', companyName: 'Larsen Steel Traders', city: 'Pittsburgh', source: 'Email', productInterest: 'Weighbridge installation', estimatedValue: 54000, status: 'NEW', priority: 'MEDIUM', followUpInDays: 5, createdDaysAgo: 2, assignTo: 'rep1' },
      { firstName: 'Mateo', lastName: 'Silva', companyName: 'Silva Organics', city: 'San Diego', source: 'Website', productInterest: 'Cold-press oil unit', estimatedValue: 31000, status: 'NEW', priority: 'LOW', followUpInDays: 6, createdDaysAgo: 1, assignTo: 'rep2' },
      { firstName: 'Yusuf', lastName: 'Demir', companyName: 'Demir Leather Works', city: 'Newark', source: 'Trade show', productInterest: 'Effluent treatment plant', estimatedValue: 86000, status: 'QUALIFIED', priority: 'HIGH', followUpInDays: 8, createdDaysAgo: 15, assignTo: 'rep1' },
      { firstName: 'Chloe', lastName: 'Dubois', companyName: 'Dubois Bakery Group', city: 'Chicago', source: 'Inbound call', productInterest: 'Commercial kitchen upgrade', estimatedValue: 27500, status: 'CONTACTED', priority: 'MEDIUM', followUpInDays: 10, createdDaysAgo: 7, assignTo: 'rep2' },

      // --- won --------------------------------------------------------------
      { firstName: 'Victor', lastName: 'Nakamura', companyName: 'Nakamura Electricals', city: 'San Jose', source: 'Referral', productInterest: 'Switchgear supply contract', estimatedValue: 112000, status: 'WON', priority: 'HIGH', followUpInDays: 0, createdDaysAgo: 68, assignTo: 'rep1' },
      { firstName: 'Amara', lastName: 'Bello', companyName: 'Bello Marine Exports', city: 'Miami', source: 'Partner', productInterest: 'Freezer container fleet', estimatedValue: 230000, status: 'WON', priority: 'URGENT', followUpInDays: 0, createdDaysAgo: 84, assignTo: 'manager' },
      { firstName: 'Peter', lastName: 'Andersson', companyName: 'Andersson Furniture', city: 'Minneapolis', source: 'Website', productInterest: 'Panel saw and edge bander', estimatedValue: 46500, status: 'WON', priority: 'MEDIUM', followUpInDays: 0, createdDaysAgo: 51, assignTo: 'rep2' },

      // --- lost -------------------------------------------------------------
      { firstName: 'Laura', lastName: 'Mendes', companyName: 'Mendes Garments', city: 'Los Angeles', source: 'Outbound', productInterest: 'Embroidery machines', estimatedValue: 38000, status: 'LOST', priority: 'LOW', followUpInDays: 0, createdDaysAgo: 47, assignTo: 'rep1', lostReason: 'Chose a lower-cost competitor' },
      { firstName: 'Daniel', lastName: 'Kovacs', companyName: 'Kovacs Print House', city: 'Boston', source: 'Email', productInterest: 'Digital press', estimatedValue: 72000, status: 'LOST', priority: 'MEDIUM', followUpInDays: 0, createdDaysAgo: 62, assignTo: 'rep2', lostReason: 'Budget deferred to next financial year' },
    ],
  },

  {
    // Second tenant is deliberately in another country, currency and timezone:
    // a hardcoded locale shows up immediately when you switch between the two.
    name: 'Meridian Foods',
    slug: 'meridian-foods',
    timezone: 'Europe/London',
    currency: 'GBP',
    locale: 'en-GB',
    country: 'GB',
    phonePrefix: '+442079',
    members: [
      { email: 'owner@meridian.example', fullName: 'Farhan Ahmed', role: 'OWNER', mobile: '+442079460101' },
      { email: 'manager@meridian.example', fullName: 'Claire Donnelly', role: 'MANAGER', mobile: '+442079460102' },
      { email: 'rohan@meridian.example', fullName: 'Rohan Pillai', role: 'SALES_REP', mobile: '+442079460103' },
      { email: 'sana@meridian.example', fullName: 'Sana Khan', role: 'SALES_REP', mobile: '+442079460104' },
    ],
    leads: [
      { firstName: 'Vincent', lastName: 'Moreau', companyName: 'Moreau Restaurants', city: 'Manchester', source: 'Referral', productInterest: 'Bulk spice supply, monthly', estimatedValue: 14500, status: 'NEGOTIATION', priority: 'HIGH', followUpInDays: -3, createdDaysAgo: 33, assignTo: 'rep1' },
      { firstName: 'Shalini', lastName: 'Dube', companyName: 'Dube Caterers', city: 'Birmingham', source: 'Inbound call', productInterest: 'Frozen snacks, event season', estimatedValue: 26000, status: 'QUOTATION_SENT', priority: 'URGENT', followUpInDays: 0, createdDaysAgo: 11, assignTo: 'rep2' },
      { firstName: 'Thomas', lastName: 'Whelan', companyName: 'Whelan Supermarkets', city: 'Leeds', source: 'Outbound', productInterest: 'Private-label staples', estimatedValue: 51000, status: 'QUALIFIED', priority: 'HIGH', followUpInDays: 2, createdDaysAgo: 19, assignTo: 'rep1' },
      { firstName: 'Beatrix', lastName: 'Toth', companyName: 'Toth Snacks', city: 'Bristol', source: 'Website', productInterest: 'Packaging film', estimatedValue: 8800, status: 'CONTACTED', priority: 'LOW', followUpInDays: 4, createdDaysAgo: 5, assignTo: 'rep2' },
      { firstName: 'Callum', lastName: 'Fraser', companyName: 'Fraser Hotels', city: 'Edinburgh', source: 'Partner', productInterest: 'Daily produce contract', estimatedValue: 69000, status: 'NEW', priority: 'MEDIUM', followUpInDays: 7, createdDaysAgo: 3, assignTo: 'rep1' },
      { firstName: 'Alice', lastName: 'Sandoval', companyName: 'Sandoval Bakery Chain', city: 'Cardiff', source: 'Trade show', productInterest: 'Industrial ovens', estimatedValue: 43000, status: 'WON', priority: 'HIGH', followUpInDays: 0, createdDaysAgo: 58, assignTo: 'rep2' },
      { firstName: 'Niall', lastName: 'Doyle', companyName: 'Doyle Dairy', city: 'Belfast', source: 'Outbound', productInterest: 'Milk chilling units', estimatedValue: 35000, status: 'LOST', priority: 'MEDIUM', followUpInDays: 0, createdDaysAgo: 40, assignTo: 'rep1', lostReason: 'Went with an existing supplier' },
    ],
  },
];
