/**
 * Public-website analytics rules, pure so they are unit-tested.
 */

/** The public LeadFlow pages that are measured -- a closed list bounds cardinality. */
export const PUBLIC_PATHS = [
  '/',
  '/features',
  '/pricing',
  '/about',
  '/contact',
  '/register',
  '/login',
] as const;
export type PublicPath = (typeof PUBLIC_PATHS)[number];

export const WEB_EVENTS = [
  'page_view',
  'registration_start',
  'registration_complete',
  'contact_submit',
] as const;
export type WebEvent = (typeof WEB_EVENTS)[number];

export const TRAFFIC_SOURCES = ['direct', 'organic', 'social', 'referral', 'campaign'] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

const SEARCH_ENGINES =
  /(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu|ecosia|startpage|search\.brave)\./i;
const SOCIAL =
  /(^|\.)(facebook|fb|instagram|linkedin|lnkd|twitter|x|t|whatsapp|wa|youtube|reddit|pinterest)\.(com|me|co|in)$/i;

/** A path as measured: query string and fragment dropped, trailing slash trimmed; null if not public. */
export function measuredPath(raw: string): PublicPath | null {
  const path = raw.split(/[?#]/)[0]?.replace(/\/+$/, '') || '/';
  return (PUBLIC_PATHS as readonly string[]).includes(path) ? (path as PublicPath) : null;
}

/** The referring site's host, or null for none / ourselves / anything unparsable. */
export function referrerDomain(referrer: string | undefined, ownHost: string): string | null {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase().slice(0, 120);
    return host && host !== ownHost.toLowerCase() ? host : null;
  } catch {
    return null;
  }
}

/** Where a visit came from. A campaign tag wins; then the referrer's kind; else direct. */
export function classifySource(input: {
  referrerDomain: string | null;
  utmSource?: string | undefined;
  utmMedium?: string | undefined;
}): TrafficSource {
  const medium = input.utmMedium?.toLowerCase() ?? '';
  if (input.utmSource || medium) {
    if (medium === 'organic') return 'organic';
    if (/social/.test(medium)) return 'social';
    return 'campaign';
  }
  if (!input.referrerDomain) return 'direct';
  if (SEARCH_ENGINES.test(input.referrerDomain)) return 'organic';
  if (SOCIAL.test(input.referrerDomain)) return 'social';
  return 'referral';
}

/** Crawlers and preview bots are not visitors. */
export function isBot(userAgent: string | undefined): boolean {
  if (!userAgent) return true;
  return /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|uptime/i.test(
    userAgent,
  );
}
