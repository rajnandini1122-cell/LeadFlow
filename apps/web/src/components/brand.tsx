/**
 * The LeadFlow brand assets.
 *
 * Defined once, as SVG, so every surface uses the same mark. Inline SVG rather
 * than an image file for two reasons: it stays sharp at any size without
 * shipping several raster variants, and it inherits the page's own rendering
 * so the mark never appears as a broken-image icon while loading.
 *
 * The wordmark is HTML text beside the mark rather than paths inside it, so it
 * matches the site's typography and remains selectable and readable by a
 * screen reader.
 */

/** Brand colours. Anything that needs them should import, not retype. */
export const BRAND = {
  blue: '#1D6FE8',
  navy: '#1E293B',
} as const;

/**
 * The LF monogram.
 *
 * A blue L with a navy F set into its corner. Drawn from plain rectangles so
 * the geometry is obvious and stays correct at every size.
 */
export function LogoMark({
  className = 'h-8 w-8',
  title,
}: {
  className?: string;
  /** Give a title only when the mark stands alone, or it is read twice. */
  title?: string;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}

      {/* L — vertical stem and foot */}
      <rect x="8" y="8" width="13" height="44" rx="2" fill={BRAND.blue} />
      <rect x="8" y="39" width="40" height="13" rx="2" fill={BRAND.blue} />

      {/* F — stem sits in the corner of the L, arms reach right */}
      <rect x="26" y="8" width="13" height="31" fill={BRAND.navy} />
      <rect x="26" y="8" width="28" height="12" rx="2" fill={BRAND.navy} />
      <rect x="26" y="25" width="21" height="11" rx="2" fill={BRAND.navy} />
    </svg>
  );
}

/**
 * The full lockup: monogram plus wordmark.
 *
 * `inverted` is for dark backgrounds, where navy on near-black is unreadable.
 */
export function Logo({
  className = '',
  markClassName = 'h-8 w-8',
  textClassName = 'text-base',
  inverted = false,
}: {
  className?: string;
  markClassName?: string;
  textClassName?: string;
  inverted?: boolean;
}): React.JSX.Element {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark className={markClassName} />
      <span className={`font-semibold tracking-tight ${textClassName}`}>
        <span style={{ color: BRAND.blue }}>Lead</span>
        <span className={inverted ? 'text-white' : ''} style={inverted ? {} : { color: BRAND.navy }}>
          Flow
        </span>
      </span>
    </span>
  );
}

/**
 * Ownership notice.
 *
 * Kept here rather than typed into each footer so the year and the entity
 * cannot drift between the marketing site and the application.
 */
export const COMPANY_NAME = 'Cravion Ventures';

/**
 * The registered entity that operates LeadFlow.
 *
 * The full legal name, used where ownership is being STATED rather than where
 * the brand is being shown — a footer notice, an about section, a contact
 * page. `COMPANY_NAME` remains the short form for ordinary prose.
 *
 * Only details already verified in this repository are published here: the
 * legal name, the public website and the sales address that SALES_EMAIL
 * defaults to. No phone number or postal address appears, because none is
 * verified here — PLATFORM_MASTER_PHONE carries a placeholder, and printing a
 * placeholder as a company contact number is worse than printing nothing.
 */
export const COMPANY_LEGAL_NAME = 'CRAVION VENTURES (OPC) PRIVATE LIMITED';
export const COMPANY_WEBSITE = 'https://www.cravionventures.com';
export const COMPANY_SALES_EMAIL = 'sales@cravionventures.com';
export const COPYRIGHT_YEAR = 2026;

/**
 * Who operates this platform.
 *
 * Stated plainly so LeadFlow does not read as an anonymous SaaS product with
 * no one behind it. Ownership is a fact a customer is entitled to see before
 * they put their pipeline into it.
 */
export function OperatedBy({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <p className={`text-xs text-slate-500 ${className}`}>
      LeadFlow is a digital platform operated by{' '}
      <a
        href={COMPANY_WEBSITE}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline"
      >
        {COMPANY_LEGAL_NAME}
      </a>
      .
    </p>
  );
}

export function Copyright({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <p className={`text-xs text-slate-400 ${className}`}>
      © {COPYRIGHT_YEAR} {COMPANY_NAME}
      <sup className="ml-0.5 text-[9px]">™</sup>. All rights reserved.
    </p>
  );
}
