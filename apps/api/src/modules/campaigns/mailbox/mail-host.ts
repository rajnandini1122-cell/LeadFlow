import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Mail server hosts an organization may point LeadFlow at.
 *
 * The API connects to whatever host a tenant administrator types in, from
 * inside Railway's network. Without this, "SMTP host" is a server-side request
 * forgery primitive: 127.0.0.1, the Postgres or Redis service on the private
 * network, or a cloud metadata address would all be one form submission away.
 *
 * Three rules close it:
 *   1. A HOSTNAME, never an IP literal. Mail providers publish names, and TLS is
 *      verified against the name, so an IP buys nothing legitimate.
 *   2. Every address the name resolves to must be public. One private address
 *      among public ones is refused, not skipped: a name that resolves into the
 *      private network is not one to talk to.
 *   3. The connection is made to the address that was checked, with SNI and
 *      certificate verification bound to the name. A second lookup at connect
 *      time (DNS rebinding) never happens.
 */

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Suffixes that only ever name private infrastructure. */
const PRIVATE_SUFFIXES = [
  '.internal',
  '.local',
  '.localhost',
  '.lan',
  '.home.arpa',
  '.railway.internal',
];

export class MailHostError extends Error {
  constructor(
    readonly reason: 'INVALID_HOSTNAME' | 'NOT_FOUND' | 'PRIVATE_ADDRESS',
    message: string,
  ) {
    super(message);
  }
}

export function normalizeMailHostname(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, '');
}

/** Syntax only: a public-looking DNS name, not an address. */
export function isAcceptableMailHostname(input: string): boolean {
  const host = normalizeMailHostname(input);
  if (isIP(host) !== 0) return false;
  if (!HOSTNAME.test(host)) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    return !PRIVATE.check(address, 'ipv6');
  }
  return !PRIVATE.check(address, 'ipv4');
}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

const systemLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Resolves a mail host to ONE public address to connect to, or throws.
 * IPv4 is preferred: Railway egress is IPv4.
 */
export async function resolvePublicMailHost(
  input: string,
  lookup: Lookup = systemLookup,
): Promise<string> {
  const host = normalizeMailHostname(input);
  if (!isAcceptableMailHostname(host)) {
    throw new MailHostError(
      'INVALID_HOSTNAME',
      'Enter the mail server’s hostname, for example mail.example.com.',
    );
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new MailHostError('NOT_FOUND', `The mail server ${host} could not be found.`);
  }
  if (addresses.length === 0) {
    throw new MailHostError('NOT_FOUND', `The mail server ${host} could not be found.`);
  }
  if (addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new MailHostError(
      'PRIVATE_ADDRESS',
      `The mail server ${host} resolves to a private network address.`,
    );
  }

  return (addresses.find((entry) => entry.family === 4) ?? addresses[0]!).address;
}
