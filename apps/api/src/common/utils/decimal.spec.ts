import { decimalString, percentage, sumDecimals, wonRevenue } from './decimal';

describe('decimalString', () => {
  it('renders null as zero', () => {
    expect(decimalString(null)).toBe('0');
    expect(decimalString(undefined)).toBe('0');
  });

  it('passes a Decimal through by its string form', () => {
    expect(decimalString({ toString: () => '1234.50' })).toBe('1234.50');
  });
});

describe('sumDecimals', () => {
  it('adds whole amounts', () => {
    expect(sumDecimals(['100', '250', '13'])).toBe('363');
  });

  it('keeps two decimal places exact', () => {
    // 0.1 + 0.2 is the canonical float failure. Money must not do that.
    expect(sumDecimals(['0.10', '0.20'])).toBe('0.30');
  });

  it('does not drift over many additions', () => {
    expect(sumDecimals(Array.from({ length: 10 }, () => '0.10'))).toBe('1');
  });

  it('handles an empty list', () => {
    expect(sumDecimals([])).toBe('0');
  });

  it('handles negatives', () => {
    expect(sumDecimals(['100', '-25.50'])).toBe('74.50');
  });

  it('handles a total that is exactly zero', () => {
    expect(sumDecimals(['50', '-50'])).toBe('0');
  });

  it('survives values beyond a float’s safe integer range', () => {
    // NUMERIC(14,2) allows twelve digits before the point, which exceeds
    // Number.MAX_SAFE_INTEGER once scaled to hundredths.
    expect(sumDecimals(['999999999999.99', '0.01'])).toBe('1000000000000');
  });
});

describe('wonRevenue', () => {
  it('prefers what the deal actually closed at', () => {
    expect(wonRevenue({ toString: () => '85000' }, { toString: () => '100000' })).toBe('85000');
  });

  it('falls back to the estimate for deals closed before wonValue existed', () => {
    expect(wonRevenue(null, { toString: () => '100000' })).toBe('100000');
  });

  it('is zero when neither is known', () => {
    expect(wonRevenue(null, null)).toBe('0');
  });
});

describe('percentage', () => {
  it('rounds to a whole number', () => {
    expect(percentage(2, 3)).toBe(67);
  });

  it('is zero for an empty denominator rather than NaN', () => {
    expect(percentage(0, 0)).toBe(0);
  });

  it('handles a complete rate', () => {
    expect(percentage(4, 4)).toBe(100);
  });
});
