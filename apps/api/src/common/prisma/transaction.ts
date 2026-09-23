import type { PrismaService } from './prisma.service';

/**
 * The client handed to a `$transaction` callback.
 *
 * A TYPE, and only a type. It lives in its own module because services
 * legitimately need to name it — a service that composes several repository
 * writes into one atomic operation has to pass the transaction between them —
 * while the ESLint rule that guards this directory exists to stop services
 * reaching the Prisma CLIENT and escaping tenant scoping. Importing a type
 * grants no access to anything, so this one file is exempted by name rather
 * than the whole rule being loosened.
 *
 * It is the extended client minus the methods that would start or end a
 * connection. Passing one around is what makes a repository transaction-aware
 * without letting anybody nest a second, independent transaction inside an
 * existing one.
 */
export type PrismaTransaction = Omit<
  PrismaService['client'],
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
