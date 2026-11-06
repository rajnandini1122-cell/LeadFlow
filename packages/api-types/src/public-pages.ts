/**
 * The PUBLIC LeadFlow website: the pages search engines may index, with their
 * titles and descriptions. One source for the web app (document.title) and the
 * API (which writes the same tags into the HTML it serves, robots.txt and the
 * sitemap), so a crawler and a browser always see the same page.
 *
 * Descriptions say only what LeadFlow does today. Everything else -- the CRM
 * itself, sign-in, invitations, password resets -- is noindex.
 */
export interface PublicPageMeta {
  path: string;
  title: string;
  description: string;
  /** In the sitemap. */
  sitemap: boolean;
  priority: number;
}

export const PUBLIC_PAGES: readonly PublicPageMeta[] = [
  {
    path: '/',
    title: 'LeadFlow — Lead management CRM for small sales teams',
    description:
      'Capture every enquiry, give each lead an owner, schedule follow-ups and see what is overdue. A simple sales CRM for small businesses, on the web and Android.',
    sitemap: true,
    priority: 1,
  },
  {
    path: '/features',
    title: 'Features — lead tracking, follow-ups and sales pipeline | LeadFlow',
    description:
      'Lead tracking, contacts, follow-up queues, an activity timeline, team roles, reports and CSV import — the LeadFlow features that keep a sales pipeline moving.',
    sitemap: true,
    priority: 0.9,
  },
  {
    path: '/pricing',
    title: 'Pricing — LeadFlow sales CRM',
    description: 'Simple per-organization pricing. Start free while LeadFlow is in early access.',
    sitemap: true,
    priority: 0.8,
  },
  {
    path: '/about',
    title: 'About LeadFlow — a CRAVION Ventures product',
    description:
      'LeadFlow is a customer lead management and sales operations platform developed and operated by CRAVION VENTURES (OPC) PRIVATE LIMITED.',
    sitemap: true,
    priority: 0.5,
  },
  {
    path: '/contact',
    title: 'Contact LeadFlow',
    description:
      'Questions about LeadFlow, or want a walkthrough for your team? Send us a message.',
    sitemap: true,
    priority: 0.6,
  },
  {
    path: '/register',
    title: 'Create your LeadFlow account',
    description: 'Set up LeadFlow for your sales team in a few minutes.',
    sitemap: true,
    priority: 0.7,
  },
];

export function publicPage(path: string): PublicPageMeta | undefined {
  return PUBLIC_PAGES.find((page) => page.path === path);
}
