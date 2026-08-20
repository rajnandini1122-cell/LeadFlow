import type { LeadPriority, LeadStatus } from '@idea001/api-types';

/**
 * Demo dataset for local development and manual testing.
 *
 * Shaped so the UI shows something meaningful the moment you sign in: leads
 * spread across every pipeline stage, follow-ups that are genuinely overdue,
 * due today and upcoming, and a realistic spread of deal sizes. Flat fixtures
 * where every lead looks alike make it impossible to tell a working dashboard
 * from a broken one.
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
  members: DemoMember[];
  leads: DemoLead[];
}

export const DEMO_ORGANIZATIONS: DemoOrganization[] = [
  {
    name: 'Cravion',
    slug: 'cravion',
    members: [
      { email: 'owner@cravion.test', fullName: 'Rajesh Nair', role: 'OWNER', mobile: '9820011001' },
      { email: 'admin@cravion.test', fullName: 'Sneha Kulkarni', role: 'ADMIN', mobile: '9820011002' },
      { email: 'manager@cravion.test', fullName: 'Vikram Desai', role: 'MANAGER', mobile: '9820011003' },
      { email: 'priya@cravion.test', fullName: 'Priya Sharma', role: 'SALES_REP', mobile: '9820011004' },
      { email: 'amit@cravion.test', fullName: 'Amit Verma', role: 'SALES_REP', mobile: '9820011005' },
    ],
    leads: [
      // --- overdue: what a manager must act on first ------------------------
      { firstName: 'Suresh', lastName: 'Menon', companyName: 'Menon Industrial Supplies', city: 'Kochi', source: 'IndiaMART', productInterest: 'Packaging line, 500 units/hr', estimatedValue: 1850000, status: 'NEGOTIATION', priority: 'URGENT', followUpInDays: -4, createdDaysAgo: 42, assignTo: 'rep1' },
      { firstName: 'Fatima', lastName: 'Sheikh', companyName: 'Crescent Textiles', city: 'Surat', source: 'Referral', productInterest: 'Bulk dyeing units', estimatedValue: 940000, status: 'QUOTATION_SENT', priority: 'HIGH', followUpInDays: -2, createdDaysAgo: 30, assignTo: 'rep2' },
      { firstName: 'Harpreet', lastName: 'Singh', companyName: 'Singh Agro Foods', city: 'Ludhiana', source: 'WhatsApp', productInterest: 'Cold storage retrofit', estimatedValue: 620000, status: 'FOLLOW_UP', priority: 'HIGH', followUpInDays: -1, createdDaysAgo: 18, assignTo: 'rep1' },

      // --- due today --------------------------------------------------------
      { firstName: 'Ananya', lastName: 'Iyer', companyName: 'Bluewave Logistics', city: 'Chennai', source: 'Website', productInterest: 'Fleet tracking, 40 vehicles', estimatedValue: 480000, status: 'QUALIFIED', priority: 'HIGH', followUpInDays: 0, createdDaysAgo: 12, assignTo: 'rep2' },
      { firstName: 'Mohammed', lastName: 'Rafiq', companyName: 'Rafiq Hardware Mart', city: 'Hyderabad', source: 'Walk-in', productInterest: 'POS and inventory system', estimatedValue: 165000, status: 'CONTACTED', priority: 'MEDIUM', followUpInDays: 0, createdDaysAgo: 6, assignTo: 'rep1' },
      { firstName: 'Deepa', lastName: 'Rao', companyName: 'Sunrise Packaging', city: 'Bengaluru', source: 'Trade Show', productInterest: 'Corrugation machinery', estimatedValue: 1250000, status: 'NEGOTIATION', priority: 'URGENT', followUpInDays: 0, createdDaysAgo: 55, assignTo: 'manager' },

      // --- upcoming ---------------------------------------------------------
      { firstName: 'Kiran', lastName: 'Patil', companyName: 'Patil Auto Components', city: 'Pune', source: 'Cold Call', productInterest: 'CNC tooling contract', estimatedValue: 780000, status: 'QUALIFIED', priority: 'MEDIUM', followUpInDays: 1, createdDaysAgo: 9, assignTo: 'rep2' },
      { firstName: 'Ritu', lastName: 'Bansal', companyName: 'Bansal Home Decor', city: 'Jaipur', source: 'Instagram', productInterest: 'Retail shelving, 3 stores', estimatedValue: 220000, status: 'CONTACTED', priority: 'LOW', followUpInDays: 2, createdDaysAgo: 4, assignTo: 'rep1' },
      { firstName: 'Arjun', lastName: 'Reddy', companyName: 'Reddy Constructions', city: 'Vijayawada', source: 'Referral', productInterest: 'Site safety equipment', estimatedValue: 395000, status: 'FOLLOW_UP', priority: 'MEDIUM', followUpInDays: 3, createdDaysAgo: 21, assignTo: 'rep2' },
      { firstName: 'Meera', lastName: 'Joshi', companyName: 'Joshi Pharma Distributors', city: 'Nagpur', source: 'IndiaMART', productInterest: 'Temperature-controlled vans', estimatedValue: 1420000, status: 'QUOTATION_SENT', priority: 'HIGH', followUpInDays: 4, createdDaysAgo: 26, assignTo: 'manager' },
      { firstName: 'Sanjay', lastName: 'Gupta', companyName: 'Gupta Steel Traders', city: 'Kanpur', source: 'WhatsApp', productInterest: 'Weighbridge installation', estimatedValue: 540000, status: 'NEW', priority: 'MEDIUM', followUpInDays: 5, createdDaysAgo: 2, assignTo: 'rep1' },
      { firstName: 'Lakshmi', lastName: 'Narayanan', companyName: 'LN Organics', city: 'Coimbatore', source: 'Website', productInterest: 'Cold-press oil unit', estimatedValue: 310000, status: 'NEW', priority: 'LOW', followUpInDays: 6, createdDaysAgo: 1, assignTo: 'rep2' },
      { firstName: 'Imran', lastName: 'Qureshi', companyName: 'Qureshi Leather Works', city: 'Kanpur', source: 'Trade Show', productInterest: 'Tannery effluent treatment', estimatedValue: 860000, status: 'QUALIFIED', priority: 'HIGH', followUpInDays: 8, createdDaysAgo: 15, assignTo: 'rep1' },
      { firstName: 'Nisha', lastName: 'Agarwal', companyName: 'Agarwal Sweets and Foods', city: 'Indore', source: 'Walk-in', productInterest: 'Commercial kitchen upgrade', estimatedValue: 275000, status: 'CONTACTED', priority: 'MEDIUM', followUpInDays: 10, createdDaysAgo: 7, assignTo: 'rep2' },

      // --- won --------------------------------------------------------------
      { firstName: 'Rohit', lastName: 'Malhotra', companyName: 'Malhotra Electricals', city: 'Delhi', source: 'Referral', productInterest: 'Switchgear supply contract', estimatedValue: 1120000, status: 'WON', priority: 'HIGH', followUpInDays: 0, createdDaysAgo: 68, assignTo: 'rep1' },
      { firstName: 'Kavita', lastName: 'Shetty', companyName: 'Shetty Marine Exports', city: 'Mangaluru', source: 'IndiaMART', productInterest: 'Freezer container fleet', estimatedValue: 2300000, status: 'WON', priority: 'URGENT', followUpInDays: 0, createdDaysAgo: 84, assignTo: 'manager' },
      { firstName: 'Devendra', lastName: 'Chauhan', companyName: 'Chauhan Furnitures', city: 'Ahmedabad', source: 'Website', productInterest: 'Panel saw and edge bander', estimatedValue: 465000, status: 'WON', priority: 'MEDIUM', followUpInDays: 0, createdDaysAgo: 51, assignTo: 'rep2' },

      // --- lost -------------------------------------------------------------
      { firstName: 'Pooja', lastName: 'Mehta', companyName: 'Mehta Garments', city: 'Mumbai', source: 'Cold Call', productInterest: 'Embroidery machines', estimatedValue: 380000, status: 'LOST', priority: 'LOW', followUpInDays: 0, createdDaysAgo: 47, assignTo: 'rep1', lostReason: 'Chose a lower-cost competitor' },
      { firstName: 'Gaurav', lastName: 'Kapoor', companyName: 'Kapoor Print House', city: 'Chandigarh', source: 'WhatsApp', productInterest: 'Digital press', estimatedValue: 720000, status: 'LOST', priority: 'MEDIUM', followUpInDays: 0, createdDaysAgo: 62, assignTo: 'rep2', lostReason: 'Budget deferred to next financial year' },
    ],
  },

  {
    name: 'ABC Foods',
    slug: 'abc-foods',
    members: [
      { email: 'owner@abcfoods.test', fullName: 'Farhan Ahmed', role: 'OWNER', mobile: '9930022001' },
      { email: 'manager@abcfoods.test', fullName: 'Divya Menon', role: 'MANAGER', mobile: '9930022002' },
      { email: 'rohan@abcfoods.test', fullName: 'Rohan Pillai', role: 'SALES_REP', mobile: '9930022003' },
      { email: 'sana@abcfoods.test', fullName: 'Sana Khan', role: 'SALES_REP', mobile: '9930022004' },
    ],
    leads: [
      { firstName: 'Vinod', lastName: 'Kamath', companyName: 'Kamath Restaurants', city: 'Udupi', source: 'Referral', productInterest: 'Bulk spice supply, monthly', estimatedValue: 145000, status: 'NEGOTIATION', priority: 'HIGH', followUpInDays: -3, createdDaysAgo: 33, assignTo: 'rep1' },
      { firstName: 'Shalini', lastName: 'Dubey', companyName: 'Dubey Caterers', city: 'Lucknow', source: 'WhatsApp', productInterest: 'Frozen snacks, wedding season', estimatedValue: 260000, status: 'QUOTATION_SENT', priority: 'URGENT', followUpInDays: 0, createdDaysAgo: 11, assignTo: 'rep2' },
      { firstName: 'Thomas', lastName: 'Varghese', companyName: 'Varghese Supermarkets', city: 'Thrissur', source: 'Walk-in', productInterest: 'Private-label staples', estimatedValue: 510000, status: 'QUALIFIED', priority: 'HIGH', followUpInDays: 2, createdDaysAgo: 19, assignTo: 'rep1' },
      { firstName: 'Bhavna', lastName: 'Trivedi', companyName: 'Trivedi Snacks', city: 'Rajkot', source: 'IndiaMART', productInterest: 'Namkeen packaging film', estimatedValue: 88000, status: 'CONTACTED', priority: 'LOW', followUpInDays: 4, createdDaysAgo: 5, assignTo: 'rep2' },
      { firstName: 'Karthik', lastName: 'Subramanian', companyName: 'KS Hotels', city: 'Madurai', source: 'Website', productInterest: 'Daily produce contract', estimatedValue: 690000, status: 'NEW', priority: 'MEDIUM', followUpInDays: 7, createdDaysAgo: 3, assignTo: 'rep1' },
      { firstName: 'Alka', lastName: 'Saxena', companyName: 'Saxena Bakery Chain', city: 'Bhopal', source: 'Trade Show', productInterest: 'Industrial ovens', estimatedValue: 430000, status: 'WON', priority: 'HIGH', followUpInDays: 0, createdDaysAgo: 58, assignTo: 'rep2' },
      { firstName: 'Naveen', lastName: 'Yadav', companyName: 'Yadav Dairy', city: 'Meerut', source: 'Cold Call', productInterest: 'Milk chilling units', estimatedValue: 350000, status: 'LOST', priority: 'MEDIUM', followUpInDays: 0, createdDaysAgo: 40, assignTo: 'rep1', lostReason: 'Went with an existing supplier' },
    ],
  },
];
