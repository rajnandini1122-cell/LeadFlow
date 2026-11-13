import { ConsentService } from './consent.service';

/**
 * The eligibility list: leads and contacts, plus addresses that only have an
 * eligibility record someone added by hand.
 */
describe('ConsentService.eligibility', () => {
  const at = new Date('2026-11-13T10:00:00Z');
  const make = (recorded: string[], consents: Record<string, object> = {}) => {
    const repository = {
      knownAddresses: jest.fn().mockResolvedValue({
        leads: [
          { email: 'Lead@X.example', firstName: 'Asha', lastName: 'Rao', companyName: 'Rao' },
        ],
        contacts: [],
      }),
      recordedAddresses: jest.fn().mockResolvedValue(recorded),
      consentsFor: jest.fn().mockResolvedValue(new Map(Object.entries(consents))),
      suppressionsFor: jest.fn().mockResolvedValue(new Map()),
    };
    return { service: new ConsentService(repository as never, {} as never), repository };
  };

  it('lists an address added by hand as MANUAL, with its recorded status', async () => {
    const { service, repository } = make(['manual@inbox.example'], {
      'manual@inbox.example': {
        status: 'GRANTED',
        basis: 'CONSENT',
        source: 'manual',
        note: 'Given 2026-11-13 via form',
        recordedAt: at,
      },
    });
    const list = await service.eligibility(' inbox ');
    expect(repository.recordedAddresses).toHaveBeenCalledWith('inbox', 2000);
    expect(list.find((r) => r.email === 'manual@inbox.example')).toEqual({
      email: 'manual@inbox.example',
      name: null,
      company: null,
      sources: ['MANUAL'],
      status: 'GRANTED',
      basis: 'CONSENT',
      source: 'manual',
      note: 'Given 2026-11-13 via form',
      recordedAt: at.toISOString(),
      suppressed: null,
    });
  });

  it('a recorded address that is also a lead stays a LEAD row — never listed twice', async () => {
    const { service } = make(['lead@x.example']);
    const list = await service.eligibility(null);
    expect(list.filter((r) => r.email === 'lead@x.example')).toEqual([
      expect.objectContaining({ sources: ['LEAD'], name: 'Asha Rao' }),
    ]);
  });

  it('nothing is invented: without a record an address is UNKNOWN, not eligible', async () => {
    const { service } = make([]);
    const list = await service.eligibility(null);
    expect(list).toEqual([expect.objectContaining({ email: 'lead@x.example', status: 'UNKNOWN' })]);
  });
});
