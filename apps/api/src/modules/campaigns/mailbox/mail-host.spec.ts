import {
  isAcceptableMailHostname,
  isPublicAddress,
  MailHostError,
  resolvePublicMailHost,
  type Lookup,
} from './mail-host';

const resolvesTo =
  (...addresses: string[]): Lookup =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('mail server hostnames', () => {
  it.each(['mail.cravionventures.com', 'smtp.gmail.com', 'MAIL.Example.COM.', 'imap.zoho.in'])(
    'accepts %s',
    (host) => {
      expect(isAcceptableMailHostname(host)).toBe(true);
    },
  );

  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '::1',
    '[::1]',
    'localhost',
    'postgres-17.railway.internal',
    'redis.railway.internal',
    'printer.local',
    'metadata.google.internal',
    'mail',
    'mail.example.com:25',
    'mail.example.com/x',
    'user@mail.example.com',
    '-bad.example.com',
    '',
  ])('refuses %j', (host) => {
    expect(isAcceptableMailHostname(host)).toBe(false);
  });
});

describe('public addresses', () => {
  it.each(['103.146.177.70', '142.250.4.108', '2607:f8b0:4004:c1b::6d'])(
    '%s is public',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // carrier-grade NAT
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fd12:3456::1', // Railway's private network is IPv6 ULA
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    'not-an-ip',
  ])('%s is not public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('resolving a mail host', () => {
  it('returns the checked public address, preferring IPv4', async () => {
    await expect(
      resolvePublicMailHost(
        'mail.example.com',
        resolvesTo('2607:f8b0:4004:c1b::6d', '103.146.177.70'),
      ),
    ).resolves.toBe('103.146.177.70');
  });

  it('refuses a name that resolves to a private address (DNS pointing into the private network)', async () => {
    await expect(
      resolvePublicMailHost('evil.example.com', resolvesTo('127.0.0.1')),
    ).rejects.toMatchObject({
      reason: 'PRIVATE_ADDRESS',
    });
  });

  it('refuses when ANY resolved address is private, even mixed with public ones', async () => {
    await expect(
      resolvePublicMailHost('evil.example.com', resolvesTo('103.146.177.70', '10.0.0.7')),
    ).rejects.toBeInstanceOf(MailHostError);
  });

  it('refuses an IP literal before any lookup happens', async () => {
    const lookup = jest.fn(resolvesTo('103.146.177.70'));
    await expect(resolvePublicMailHost('169.254.169.254', lookup)).rejects.toMatchObject({
      reason: 'INVALID_HOSTNAME',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reports a name that does not resolve without leaking resolver detail', async () => {
    const failing: Lookup = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND nope.example.com 10.0.0.53'), {
        code: 'ENOTFOUND',
      });
    };
    await expect(resolvePublicMailHost('nope.example.com', failing)).rejects.toThrow(
      'could not be found',
    );
    await expect(resolvePublicMailHost('nope.example.com', failing)).rejects.not.toThrow(
      '10.0.0.53',
    );
  });
});
