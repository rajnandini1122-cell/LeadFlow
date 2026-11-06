import { PUBLIC_PAGES, publicPage, type PublicPageMeta } from '@leadflow/api-types';

/**
 * Search-engine handling for the PUBLIC LeadFlow website, served by this API.
 *
 * The web app is a single-page app: before this, every URL answered the same
 * HTML with one title, no canonical, no robots or sitemap, and the private CRM
 * routes looked indexable. Now:
 *   * each public page's HTML carries its own title, description, canonical,
 *     Open Graph / Twitter tags and JSON-LD -- in the first response, before
 *     any JavaScript runs;
 *   * every other SPA route (sign-in, the CRM) carries noindex, in the HTML and
 *     as an X-Robots-Tag header;
 *   * /robots.txt and /sitemap.xml are generated from the same page list.
 * robots.txt is a crawling hint, not security: private data is protected by
 * authentication, never by robots rules.
 */

const COMPANY = 'CRAVION VENTURES (OPC) PRIVATE LIMITED';

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Paths without a trailing slash; the root stays "/". */
export function canonicalPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function origin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

function jsonLd(page: PublicPageMeta, base: string): string {
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'Organization',
      '@id': `${base}/#organization`,
      name: COMPANY,
      url: `${base}/`,
      logo: `${base}/logo.svg`,
    },
    {
      '@type': 'WebSite',
      '@id': `${base}/#website`,
      name: 'LeadFlow',
      url: `${base}/`,
      publisher: { '@id': `${base}/#organization` },
    },
    {
      '@type': 'WebPage',
      '@id': `${base}${page.path}#webpage`,
      url: `${base}${page.path === '/' ? '/' : page.path}`,
      name: page.title,
      description: page.description,
      isPartOf: { '@id': `${base}/#website` },
    },
  ];
  if (page.path === '/') {
    graph.push({
      '@type': 'SoftwareApplication',
      name: 'LeadFlow',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web, Android',
      url: `${base}/`,
      description: page.description,
      publisher: { '@id': `${base}/#organization` },
    });
  }
  // `<` escaped so the JSON can never close the script element.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(
    /</g,
    '\\u003c',
  );
}

/** The <head> additions for one request path, and whether it may be indexed. */
export function headFor(
  path: string,
  baseUrl: string,
): { indexable: boolean; title: string | null; tags: string } {
  const page = publicPage(canonicalPath(path));
  if (!page) {
    return {
      indexable: false,
      title: null,
      tags: '<meta name="robots" content="noindex, nofollow" />',
    };
  }
  const base = origin(baseUrl);
  const url = `${base}${page.path === '/' ? '/' : page.path}`;
  const t = escape(page.title);
  const d = escape(page.description);
  const tags = [
    `<meta name="description" content="${d}" />`,
    `<link rel="canonical" href="${url}" />`,
    '<meta name="robots" content="index, follow" />',
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="LeadFlow" />',
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${url}" />`,
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<script type="application/ld+json">${jsonLd(page, base)}</script>`,
  ].join('\n    ');
  return { indexable: true, title: page.title, tags };
}

/** index.html with this path's title and tags. The template's own description is replaced. */
export function renderIndexHtml(
  template: string,
  path: string,
  baseUrl: string,
): { html: string; indexable: boolean } {
  const head = headFor(path, baseUrl);
  let html = template.replace(/\s*<meta name="description"[^>]*>/i, '');
  if (head.title)
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escape(head.title)}</title>`);
  html = html.replace(/<\/head>/i, `    ${head.tags}\n  </head>`);
  return { html, indexable: head.indexable };
}

export function robotsTxt(baseUrl: string): string {
  return [
    'User-agent: *',
    'Allow: /$',
    ...PUBLIC_PAGES.map((p) => `Allow: ${p.path}`).filter((line) => line !== 'Allow: /'),
    'Disallow: /api/',
    'Disallow: /today',
    'Disallow: /dashboard',
    'Disallow: /leads',
    'Disallow: /invite/',
    'Disallow: /reset-password/',
    'Disallow: /verify-email',
    '',
    `Sitemap: ${origin(baseUrl)}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapXml(baseUrl: string): string {
  const base = origin(baseUrl);
  const urls = PUBLIC_PAGES.filter((p) => p.sitemap).map(
    (p) =>
      `  <url>\n    <loc>${base}${p.path === '/' ? '/' : p.path}</loc>\n    <priority>${p.priority.toFixed(1)}</priority>\n  </url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** What the CRAVION Admin "SEO Status" view shows: checked facts, no ranking claims. */
export function seoStatus(baseUrl: string) {
  const base = origin(baseUrl);
  return {
    siteUrl: `${base}/`,
    https: base.startsWith('https://'),
    robotsTxt: `${base}/robots.txt`,
    sitemap: `${base}/sitemap.xml`,
    pages: PUBLIC_PAGES.map((p) => ({
      path: p.path,
      url: `${base}${p.path === '/' ? '/' : p.path}`,
      title: p.title,
      titleLength: p.title.length,
      description: p.description,
      descriptionLength: p.description.length,
      inSitemap: p.sitemap,
      indexable: true,
      structuredData:
        p.path === '/'
          ? ['Organization', 'WebSite', 'WebPage', 'SoftwareApplication']
          : ['Organization', 'WebSite', 'WebPage'],
    })),
    privateRoutes:
      'Every other page (sign-in, the CRM) is served with noindex in the HTML and an X-Robots-Tag header.',
    rendering:
      'Single-page app. Titles, descriptions, canonical URLs, social tags and structured data are written into the HTML by the server; page content renders with JavaScript (Google renders it).',
    searchConsole: {
      connected: false,
      instructions: [
        'In Google Search Console, add the URL-prefix property ' +
          `${base}/` +
          ' (or a Domain property for cravionventures.com).',
        'Verify ownership with a DNS TXT record on cravionventures.com (no code change needed).',
        `Submit ${base}/sitemap.xml under Sitemaps.`,
        'To show clicks, impressions, CTR, position and queries here, create a Google Cloud service account with read access to the property and add its credentials to the CRAVION Admin backend; until then this section stays "Not connected".',
      ],
    },
    coreWebVitals: {
      connected: false,
      note: 'Field data (LCP, INP, CLS) comes from the Chrome UX Report / Search Console once the site has enough traffic; not measured here.',
    },
  };
}
