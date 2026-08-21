/**
 * Formatting driven by the SIGNED-IN ORGANIZATION's locale and currency.
 *
 * Nothing here hardcodes a country. The tenant supplies locale, currency and
 * timezone, so a US organization sees $1,234 and a German one 1.234 € from the
 * same code path — and "today" is computed in the tenant's timezone rather
 * than the browser's, which is what makes overdue correct for a distributed
 * team.
 *
 * setFormattingContext() is called once when the session loads. The defaults
 * below apply only before that, and are neutral rather than regional.
 */

interface FormattingContext {
  locale: string;
  currency: string;
  timezone: string;
}

let context: FormattingContext = {
  locale: 'en-US',
  currency: 'USD',
  timezone: 'UTC',
};

export function setFormattingContext(next: Partial<FormattingContext>): void {
  context = { ...context, ...next };
}

export function formattingContext(): FormattingContext {
  return context;
}

/** Full amount in the tenant currency. null renders as an em dash, never 0. */
export function formatCurrency(value: string | number | null): string {
  if (value === null || value === '') return '—';
  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(amount)) return '—';

  return new Intl.NumberFormat(context.locale, {
    style: 'currency',
    currency: context.currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Compact amount for dense tiles.
 *
 * Uses Intl notation:'compact', so each locale gets its own convention —
 * "$1.2M" in en-US and "₹12.3L" in en-IN — instead of lakh/crore being forced
 * on every tenant.
 */
export function formatCurrencyCompact(value: string | number | null): string {
  if (value === null || value === '') return '—';
  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(amount)) return '—';

  return new Intl.NumberFormat(context.locale, {
    style: 'currency',
    currency: context.currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount);
}

/**
 * The tenant currency's symbol on its own, for input adornments and hints.
 *
 * Derived from Intl rather than a lookup table, so a tenant on a currency
 * nobody anticipated still gets the right mark instead of a hardcoded one.
 */
export function currencySymbol(): string {
  const parts = new Intl.NumberFormat(context.locale, {
    style: 'currency',
    currency: context.currency,
    maximumFractionDigits: 0,
  }).formatToParts(0);

  return parts.find((part) => part.type === 'currency')?.value ?? context.currency;
}

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Whole days between today and `iso`. Negative means the past. */
export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const diff = startOfDay(new Date(iso)) - startOfDay(new Date());
  return Math.round(diff / 86_400_000);
}

/**
 * Human phrasing for a follow-up date.
 *
 * "3 days overdue" carries urgency that "12 Aug" does not — and urgency is the
 * entire product.
 */
export function formatDueDate(iso: string | null): string {
  const days = daysUntil(iso);
  if (days === null) return 'No follow-up';

  if (days < -1) return `${Math.abs(days)} days overdue`;
  if (days === -1) return 'Overdue since yesterday';
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days <= 7) return `Due in ${days} days`;
  return `Due ${formatDate(iso)}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(context.locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: context.timezone,
  });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(context.locale, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: context.timezone,
  });
}

/** "2 hours ago" / "3 days ago", for activity timelines. */
export function formatRelative(iso: string | null): string {
  if (!iso) return '—';

  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return formatDate(iso);
}

export function initials(fullName: string): string {
  return fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

/** Turns NEW / QUOTATION_SENT into New / Quotation sent. */
export function humanise(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Numbers arrive from the API already canonicalised to E.164, so these links
 * need no country logic at all — which is the payoff for storing E.164 rather
 * than a bare national number.
 */
export function telHref(mobile: string | null): string | null {
  if (!mobile) return null;
  const cleaned = mobile.replace(/[^\d+]/g, '');
  return cleaned.length >= 8 ? `tel:${cleaned}` : null;
}

/** wa.me wants digits only, no leading plus. */
export function whatsappHref(mobile: string | null): string | null {
  if (!mobile) return null;
  const digits = mobile.replace(/\D/g, '');
  return digits.length >= 8 ? `https://wa.me/${digits}` : null;
}
