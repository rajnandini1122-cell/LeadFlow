/**
 * Deciding whether a message reads like a buying enquiry.
 *
 * Rules, not a model. Everything here is a word list and a word-boundary match,
 * which means anyone can read why a conversation was flagged and argue with it.
 * A classifier that cannot explain itself would be worse than useless in a
 * review queue, because the whole point of the queue is that a person judges
 * the suggestion rather than trusting it.
 *
 * This ONLY decides which pile a conversation lands in. No lead is ever created
 * from a keyword — see IngestionService, which stores the flag and stops.
 *
 * Deliberately isolated in its own file with no imports: replacing these rules
 * later, with better ones or with a model, must not require touching the lead
 * flow or the ingestion path.
 */

/**
 * Words that suggest someone is trying to buy something.
 *
 * Matched on word boundaries, so "order" does not fire on "border" and "kg"
 * does not fire on "kgb". Multi-word entries are matched as phrases.
 */
export const BUYING_SIGNALS = [
  'price',
  'pricing',
  'quotation',
  'quote',
  'moq',
  'minimum order',
  'bulk',
  'quantity',
  'kg',
  'kgs',
  'ton',
  'tons',
  'tonne',
  'order',
  'requirement',
  'purchase',
  'wholesale',
  'distributor',
  'supplier',
  'export',
  'sample',
  'samples',
  'catalogue',
  'catalog',
  'rate',
  'rates',
  'stock',
  'delivery',
  'invoice',
] as const;

export interface SignalMatch {
  /** True when at least one signal was found. */
  isPotentialLead: boolean;
  /** The signals that matched, deduplicated, in the order they are listed. */
  signals: string[];
}

/**
 * Escapes a signal for use inside a regular expression.
 *
 * None of the current signals contain metacharacters, but the list is meant to
 * be edited by whoever tunes it, and a stray "." silently turning into
 * match-anything is exactly the kind of bug nobody looks for.
 */
function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which buying signals appear in a piece of text.
 *
 * Case-insensitive, and matched on word boundaries rather than substrings:
 * substring matching flags "thanks for the tips" as a bulk enquiry because it
 * contains "ton" backwards-ish, and a queue full of false positives gets
 * ignored, which is the same as not having one.
 */
export function detectBuyingSignals(text: string | null | undefined): SignalMatch {
  if (!text || !text.trim()) return { isPotentialLead: false, signals: [] };

  const haystack = text.toLowerCase();
  const found: string[] = [];

  for (const signal of BUYING_SIGNALS) {
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escape(signal)}(?:[^\\p{L}\\p{N}]|$)`, 'u');
    if (pattern.test(haystack)) found.push(signal);
  }

  return { isPotentialLead: found.length > 0, signals: found };
}
