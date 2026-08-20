/**
 * Formatting helpers, tuned for Indian SMEs.
 *
 * Currency uses the Indian digit grouping (lakh/crore) rather than thousands,
 * because "₹18,50,000" is what an Indian business owner reads fluently and
 * "₹1,850,000" is not.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** Full amount, e.g. ₹18,50,000. `null` renders as an em dash, never ₹0. */
export function formatCurrency(value: string | number | null): string {
  if (value === null || value === '') return '—';
  const amount = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(amount) ? INR.format(amount) : '—';
}

/** Compact amount for dense tiles: ₹18.5L, ₹2.3Cr. */
export function formatCurrencyCompact(value: string | number | null): string {
  if (value === null || value === '') return '—';
  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(amount)) return '—';

  if (amount >= 10_000_000) return `₹${(amount / 10_000_000).toFixed(2)}Cr`;
  if (amount >= 100_000) return `₹${(amount / 100_000).toFixed(1)}L`;
  if (amount >= 1_000) return `₹${(amount / 1_000).toFixed(0)}K`;
  return `₹${amount}`;
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
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
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

/** Digits only, so `tel:` and `wa.me` links work regardless of input format. */
export function telHref(mobile: string | null): string | null {
  if (!mobile) return null;
  const digits = mobile.replace(/\D/g, '');
  return digits.length >= 10 ? `tel:+91${digits.slice(-10)}` : null;
}

export function whatsappHref(mobile: string | null): string | null {
  if (!mobile) return null;
  const digits = mobile.replace(/\D/g, '');
  return digits.length >= 10 ? `https://wa.me/91${digits.slice(-10)}` : null;
}
