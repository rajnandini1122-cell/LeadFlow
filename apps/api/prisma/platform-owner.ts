import * as argon2 from 'argon2';
import { PLATFORM_ROLE_KEY } from '@leadflow/api-types';
import type { PrismaClient } from '../src/generated/prisma/client';

/**
 * Creating CRAVION's platform organization and its first PLATFORM_OWNER.
 *
 * The LOGIC, separated from the command that runs it. The CLI in
 * `bootstrap-platform-owner.ts` reads the environment, resolves a connection and
 * prints; everything that decides what happens to the database is here, so it
 * can be tested in-process against a real database instead of only through a
 * spawned process.
 *
 * That split is not cosmetic. The first version of these tests spawned the
 * command and hung: the development database serves one connection at a time,
 * and a child process asking for it while the suite held it waits forever. A
 * test that can only run by spawning is a test that cannot run everywhere.
 *
 * EVERY REFUSAL HERE IS DELIBERATE. This command runs against production with
 * shell access, so the dangerous outcomes are not failures — they are silent
 * successes: a customer organization converted into the platform operator, an
 * existing user's password rewritten, a second set of platform keys created.
 * Each of those is refused by name.
 */

export const PLATFORM_ORGANIZATION_NAME = 'CRAVION VENTURES (OPC) PRIVATE LIMITED';
export const PLATFORM_ORGANIZATION_SLUG = 'cravion-ventures';

/** Matches RegisterDto. The master account is not held to a lower bar than a customer's. */
export const MIN_PASSWORD_LENGTH = 12;

export interface PlatformOwnerInputs {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}

export interface PlatformOwnerResult {
  organization: { id: string; name: string; action: Action };
  user: { id: string; email: string; action: Action };
  membership: { action: Action };
  /** True when an existing user was found and their password deliberately left alone. */
  passwordUntouched: boolean;
}

type Action = 'created' | 'existing' | 'reconciled';

/** Thrown for every refusal, so the CLI can print a message and nothing else. */
export class PlatformBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformBootstrapError';
  }
}

/**
 * Validates the inputs before anything is written.
 *
 * Returns the cleaned values or throws with every problem named at once —
 * somebody who got three variables wrong should learn about three, not discover
 * them one run at a time.
 */
export function validateInputs(raw: Partial<Record<keyof PlatformOwnerInputs, string>>): PlatformOwnerInputs {
  const email = (raw.email ?? '').trim().toLowerCase();
  const firstName = (raw.firstName ?? '').trim();
  const lastName = (raw.lastName ?? '').trim();
  const password = raw.password ?? '';

  const problems: string[] = [];

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    problems.push('PLATFORM_OWNER_EMAIL must be a valid email address');
  }
  if (firstName.length < 1) problems.push('PLATFORM_OWNER_FIRST_NAME is required');
  if (lastName.length < 1) problems.push('PLATFORM_OWNER_LAST_NAME is required');
  if (password.length < MIN_PASSWORD_LENGTH) {
    // The REQUIREMENT is named. The value never is.
    problems.push(`PLATFORM_OWNER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  if (problems.length > 0) {
    throw new PlatformBootstrapError(
      `Refusing to bootstrap:\n  ${problems.join('\n  ')}\n\n` +
        'Set these in the environment of the one-off context you are running in. ' +
        'The password is read from the environment so it stays out of shell ' +
        'history and process listings.',
    );
  }

  return { email, firstName, lastName, password };
}

/**
 * Creates or reconciles the platform owner.
 *
 * Idempotent: a second run finds each piece and changes nothing. The one change
 * a re-run WILL make is raising an existing CRAVION membership to the platform
 * role, which is the point of re-running after a failure partway through.
 */
export async function bootstrapPlatformOwner(
  prisma: PrismaClient,
  inputs: PlatformOwnerInputs,
  argonOptions: { memoryCost: number; timeCost: number; parallelism: number },
): Promise<PlatformOwnerResult> {
  const roleId = await requirePlatformRole(prisma);
  const organization = await reconcileOrganization(prisma);
  const user = await reconcileUser(prisma, inputs, argonOptions);
  const membership = await reconcileMembership(prisma, {
    organizationId: organization.id,
    userId: user.id,
    roleId,
  });

  return {
    organization,
    user: { id: user.id, email: user.email, action: user.action },
    membership,
    passwordUntouched: user.action === 'existing',
  };
}

/**
 * The PLATFORM_OWNER system role, which reference bootstrap owns.
 *
 * Refused rather than created here. `db:bootstrap` is the single authority for
 * system roles; a second creator would be a second definition of what the role
 * grants, and the two would diverge the first time the permission matrix
 * changed.
 */
async function requirePlatformRole(prisma: PrismaClient): Promise<string> {
  const role = await prisma.role.findFirst({
    where: { key: PLATFORM_ROLE_KEY, organizationId: null, isSystem: true },
    select: { id: true },
  });

  if (!role) {
    throw new PlatformBootstrapError(
      `The ${PLATFORM_ROLE_KEY} system role does not exist. Run ` +
        '`npm run db:bootstrap -w apps/api` first — it owns the reference data, ' +
        'including this role and its permissions.',
    );
  }

  return role.id;
}

/**
 * CRAVION's own organization, found by TYPE.
 *
 * Never by name or slug: the type column is the authority, and looking it up by
 * name would mean a rename created a second platform operator. A partial unique
 * index guarantees at most one INTERNAL row.
 */
async function reconcileOrganization(
  prisma: PrismaClient,
): Promise<{ id: string; name: string; action: Action }> {
  const existing = await prisma.organization.findFirst({
    where: { organizationType: 'INTERNAL' },
    select: { id: true, name: true, deletedAt: true },
  });

  if (existing) {
    if (existing.deletedAt) {
      throw new PlatformBootstrapError(
        'The platform organization exists but is soft-deleted. Refusing to ' +
          'resurrect it automatically: restoring a deleted organization is a ' +
          'decision, not a side effect of running a bootstrap.',
      );
    }

    return { id: existing.id, name: existing.name, action: 'existing' };
  }

  /*
   * A slug collision means an unrelated customer already owns this address.
   * Refused rather than suffixed: silently creating "cravion-ventures-2" would
   * leave two similarly named organizations, one of which is the platform
   * operator, and nobody reading the list could tell which.
   *
   * Converting the existing one is the outcome that must never happen — it
   * would hand that tenant's owner administrative access to every customer.
   */
  const slugTaken = await prisma.organization.findFirst({
    where: { slug: PLATFORM_ORGANIZATION_SLUG },
    select: { id: true },
  });

  if (slugTaken) {
    throw new PlatformBootstrapError(
      `An organization with the slug "${PLATFORM_ORGANIZATION_SLUG}" already ` +
        'exists and is not the platform organization. Refusing to touch it — ' +
        'converting an existing tenant into the platform operator would hand ' +
        'its owner administrative access to every customer.',
    );
  }

  const created = await prisma.organization.create({
    data: {
      name: PLATFORM_ORGANIZATION_NAME,
      slug: PLATFORM_ORGANIZATION_SLUG,
      organizationType: 'INTERNAL',
      // ACTIVE, not TRIAL. A trial is a customer lifecycle state with an end
      // date, and this organization has neither a trial nor an end.
      status: 'ACTIVE',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      locale: 'en-IN',
      country: 'IN',
    },
    select: { id: true, name: true },
  });

  // Created for the same reason registration creates them: the application
  // reads settings, and their absence is a null check in every caller.
  await prisma.organizationSettings.create({ data: { organizationId: created.id } });

  return { ...created, action: 'created' };
}

/** The master user. A re-run never rewrites their password. */
async function reconcileUser(
  prisma: PrismaClient,
  inputs: PlatformOwnerInputs,
  argonOptions: { memoryCost: number; timeCost: number; parallelism: number },
): Promise<{ id: string; email: string; action: Action }> {
  const existing = await prisma.user.findFirst({
    where: { email: inputs.email },
    select: { id: true, email: true, status: true },
  });

  if (existing) {
    /*
     * Found, and the password is NOT touched.
     *
     * A re-run that reset it would be a password-reset tool wearing a
     * bootstrap's name — usable by anybody with shell access to take over an
     * existing account, and indistinguishable from an ordinary idempotent run
     * in any log.
     */
    if (existing.status !== 'ACTIVE') {
      throw new PlatformBootstrapError(
        `The user ${inputs.email} exists but is ${existing.status}. Refusing to ` +
          'reactivate an account automatically — that is a deliberate act.',
      );
    }

    return { id: existing.id, email: existing.email, action: 'existing' };
  }

  const passwordHash = await argon2.hash(inputs.password, {
    type: argon2.argon2id,
    ...argonOptions,
  });

  const created = await prisma.user.create({
    data: {
      email: inputs.email,
      fullName: `${inputs.firstName} ${inputs.lastName}`,
      passwordHash,
      status: 'ACTIVE',
    },
    select: { id: true, email: true },
  });

  return { ...created, action: 'created' };
}

/**
 * The membership that carries the role.
 *
 * The auth model resolves permissions from a membership, so the platform owner
 * needs one in CRAVION's organization. This is not a second concept of identity
 * — it is the same one every user has.
 */
async function reconcileMembership(
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; roleId: string },
): Promise<{ action: Action }> {
  const existing = await prisma.organizationUser.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId },
    select: { id: true, roleId: true, status: true },
  });

  if (existing) {
    if (existing.roleId === input.roleId && existing.status === 'ACTIVE') {
      return { action: 'existing' };
    }

    await prisma.organizationUser.update({
      where: { id: existing.id },
      data: { roleId: input.roleId, status: 'ACTIVE' },
    });

    return { action: 'reconciled' };
  }

  await prisma.organizationUser.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      roleId: input.roleId,
      status: 'ACTIVE',
      joinedAt: new Date(),
    },
  });

  return { action: 'created' };
}
