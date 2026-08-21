/**
 * Money arithmetic on decimal strings.
 *
 * Prisma returns NUMERIC columns as Decimal objects precisely so the value
 * never passes through a float. Converting to Number to add a column up would
 * reintroduce exactly the rounding error the column type exists to prevent, so
 * these helpers work in integer hundredths via BigInt and hand back strings.
 */

export type Decimalish = { toString(): string } | null | undefined;

/** A nullable Decimal as a plain string, with null meaning zero. */
export function decimalString(value: Decimalish): string {
  return value == null ? '0' : value.toString();
}

/** Decimal string to an integer number of hundredths, as a string. */
function scaled(value: string): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return `${negative ? '-' : ''}${whole}${fraction.padEnd(2, '0').slice(0, 2)}`;
}

/** Sums decimal strings without ever going through a float. */
export function sumDecimals(values: string[]): string {
  const total = values.reduce((carry, value) => carry + BigInt(scaled(value)), 0n);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(3, '0');
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);

  return `${negative ? '-' : ''}${whole}${fraction === '00' ? '' : `.${fraction}`}`;
}

/**
 * Revenue for a set of won deals.
 *
 * `wonValue` is what the deal actually closed at; `estimatedValue` is what it
 * was forecast to be. The estimate is used only as a fallback for deals closed
 * before `won_value` existed — without it, historical revenue reads as zero;
 * with it applied unconditionally, every discounted deal is overstated.
 */
export function wonRevenue(wonValue: Decimalish, estimatedValue: Decimalish): string {
  const actual = decimalString(wonValue);
  return actual !== '0' ? actual : decimalString(estimatedValue);
}

/**
 * A whole-number percentage, or 0 when the denominator is empty.
 *
 * Zero rather than null: every caller renders it, and "0%" for an empty period
 * is honest, whereas a null forces each screen to invent its own placeholder.
 */
export function percentage(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}
