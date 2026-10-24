import { homeDialPrefix, leadMarket, marketWhere } from './market';

describe('lead market', () => {
  it('knows the home dialling code', () => {
    expect(homeDialPrefix('IN')).toBe('+91');
    expect(homeDialPrefix('in')).toBe('+91');
    expect(homeDialPrefix('ZZ')).toBeNull();
  });

  it.each([
    [{ country: 'IN', mobile: '+971501234567' }, 'DOMESTIC'], // country wins over the phone
    [{ country: 'AE', mobile: '+919820011001' }, 'INTERNATIONAL'], // importer with an Indian agent's number
    [{ country: null, mobile: '+919820011001' }, 'DOMESTIC'],
    [{ country: null, mobile: '+14155552671' }, 'INTERNATIONAL'],
    [{ country: null, mobile: '+971501234567' }, 'INTERNATIONAL'],
    [{ country: 'in', mobile: null }, 'DOMESTIC'],
    [{ country: null, mobile: null }, 'UNKNOWN'],
  ])('classifies %o as %s for an India-based organization', (lead, market) => {
    expect(leadMarket(lead, 'IN')).toBe(market);
  });

  it('uses the ORGANIZATION’s home country, not a hard-coded India', () => {
    expect(leadMarket({ country: null, mobile: '+919820011001' }, 'AE')).toBe('INTERNATIONAL');
    expect(leadMarket({ country: null, mobile: '+971501234567' }, 'AE')).toBe('DOMESTIC');
  });

  it('builds a WHERE that matches only home-country leads for DOMESTIC', () => {
    expect(JSON.stringify(marketWhere('DOMESTIC', 'IN'))).toContain('+91');
    expect(marketWhere('UNKNOWN', 'IN')).toEqual({ country: null, mobile: null });
  });
});
