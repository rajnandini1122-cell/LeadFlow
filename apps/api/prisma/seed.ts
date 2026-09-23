import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_PERMISSION_MATRIX,
  type ActivityType,
  type RoleKey,
} from '@leadflow/api-types';
import {
  DEFAULT_LEAD_SOURCES,
  DEMO_ORGANIZATIONS,
  type DemoLead,
  type DemoOrganization,
} from './demo-data';
import { seedOmnichannel, OMNICHANNEL_SUMMARY } from './seed-omnichannel';
import { planIdsByCode, syncReferenceData, systemRoleIdsByKey } from './reference-data';
import { DEFAULT_PLAN_CODE, TRIAL_DAYS } from '../src/modules/subscriptions/plan-catalogue';

/**
 * Idempotent DEVELOPMENT seed.
 *
 * Reference data — permissions, system roles, plans — plus demo organizations
 * with demo people, demo leads and a shared password, so a fresh checkout has
 * something to look at.
 *
 * NOT FOR PRODUCTION, and it refuses to run there (see the guard below). For a
 * real deployment the reference half of this lives in `prisma/bootstrap.ts`,
 * which creates no organizations and no users. Both call the same
 * `syncReferenceData`, so there is one definition of what a role is.
 *
 * Uses the UNEXTENDED PrismaClient deliberately: seeding writes across several
 * organizations, which the tenant-scoping extension exists to prevent. This is
 * the migration-time equivalent of runAsSystem().
 *
 * Safe to run repeatedly — organizations, users and memberships are upserted,
 * and leads are keyed on (organization_id, lead_number).
 */

/*
 * Refuses to run in production, BEFORE anything is written.
 *
 * This seed creates organizations called Northwind Supply and Meridian Foods,
 * staffed by demo users who all share one password. In a development database
 * that is the point. In a production database it is a set of working
 * credentials nobody chose and nobody is watching, sitting in the same tenant
 * table as real customers.
 *
 * First statement in the file on purpose: the check has to happen before the
 * client is constructed, let alone before a write. A guard inside main() would
 * still be a guard, but it would sit below code that could grow a side effect.
 *
 * Production's path is `npm run db:bootstrap -w apps/api`, which writes the
 * reference data this shares and nothing else.
 */
if (process.env['NODE_ENV'] === 'production') {
  console.error(
    'Refusing to seed: this creates DEMO organizations, demo users and a shared ' +
      'demo password, which must never exist in a production database.\n' +
      'Use `npm run db:bootstrap -w apps/api` instead — it writes reference data ' +
      '(permissions, system roles, plans) and creates no tenant data.',
  );
  process.exit(1);
}

const connectionString =
  process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';

if (!connectionString) {
  console.error('DATABASE_URL (or DIRECT_DATABASE_URL) must be set to seed.');
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1 }) });

const ROLE_DESCRIPTIONS: Record<RoleKey, string> = {
  OWNER: 'Full company access: dashboard, team, leads, reports, settings, billing',
  ADMIN: 'Manage users, manage leads, configure company settings',
  MANAGER: 'View team, assign leads, monitor follow-ups, view team performance',
  SALES_REP: 'View and update assigned leads, log activity, schedule follow-ups',
};

const DAY_MS = 86_400_000;

function daysFromNow(days: number, hour = 11): Date {
  const date = new Date(Date.now() + days * DAY_MS);
  date.setHours(hour, 0, 0, 0);
  return date;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

// -----------------------------------------------------------------------------
// Organizations
// -----------------------------------------------------------------------------

async function seedOrganization(
  demo: DemoOrganization,
  roleIds: Map<RoleKey, string>,
  passwordHash: string,
): Promise<string> {
  const organization = await prisma.organization.upsert({
    where: { slug: demo.slug },
    create: {
      name: demo.name,
      slug: demo.slug,
      status: 'ACTIVE',
      timezone: demo.timezone,
      currency: demo.currency,
      locale: demo.locale,
      country: demo.country,
    },
    update: {
      name: demo.name,
      status: 'ACTIVE',
      timezone: demo.timezone,
      currency: demo.currency,
      locale: demo.locale,
      country: demo.country,
    },
  });

  /*
   * Omnichannel is ON for the demo organizations.
   *
   * The flag defaults to false in the schema, which is right for a real
   * tenant: an organization that has connected no channel should not be shown
   * an inbox and a review queue it cannot use. But a DEMO database exists to be
   * explored, and with the flag off the Inbox, Channel review and Channel
   * integration screens are all hidden — including the pages you would go to in
   * order to connect a channel in the first place.
   */
  await prisma.organizationSettings.upsert({
    where: { organizationId: organization.id },
    create: {
      organizationId: organization.id,
      leadSources: DEFAULT_LEAD_SOURCES,
      omnichannelEnabled: true,
    },
    update: { leadSources: DEFAULT_LEAD_SOURCES, omnichannelEnabled: true },
  });

  // --- members ---------------------------------------------------------------
  const userIds = new Map<string, string>();
  /*
   * email -> id, alongside the role-keyed map above.
   *
   * A separate map rather than a change to `userIds`: that one is keyed by role
   * for two SALES_REPs and by email for the rest, and the omnichannel fixtures
   * need to name a specific person. Reworking the existing keying would touch
   * lead assignment, which works.
   */
  const memberIds = new Map<string, string>();

  for (const member of demo.members) {
    const user = await prisma.user.upsert({
      where: { email: member.email },
      create: {
        email: member.email,
        fullName: member.fullName,
        mobile: member.mobile,
        passwordHash,
        status: 'ACTIVE',
        // Staggered so "last active" reads plausibly rather than all-identical.
        lastLoginAt: daysAgo(Math.random() * 3),
      },
      update: { fullName: member.fullName, passwordHash, status: 'ACTIVE' },
    });

    await prisma.organizationUser.upsert({
      where: {
        organizationId_userId: { organizationId: organization.id, userId: user.id },
      },
      create: {
        organizationId: organization.id,
        userId: user.id,
        roleId: roleIds.get(member.role) as string,
        status: 'ACTIVE',
        joinedAt: daysAgo(90),
      },
      update: { status: 'ACTIVE', roleId: roleIds.get(member.role) as string },
    });

    userIds.set(member.role === 'SALES_REP' ? member.email : member.role, user.id);
    memberIds.set(member.email, user.id);
  }

  const reps = demo.members.filter((m) => m.role === 'SALES_REP');
  const assignees = {
    rep1: userIds.get(reps[0]?.email ?? '') as string,
    rep2: userIds.get(reps[1]?.email ?? reps[0]?.email ?? '') as string,
    manager: userIds.get('MANAGER') as string,
  };
  const ownerId = userIds.get('OWNER') as string;

  // --- leads -----------------------------------------------------------------
  let created = 0;
  /*
   * Company name -> lead id, for the omnichannel fixtures.
   *
   * Filled from BOTH newly created and already-present leads, so a re-run of
   * the seed can still attach conversations to leads an earlier run made.
   */
  const leadsByCompany = new Map<string, string>();

  for (const [index, lead] of demo.leads.entries()) {
    const leadNumber = `LD-${String(index + 1).padStart(5, '0')}`;
    const existing = await prisma.lead.findFirst({
      where: { organizationId: organization.id, leadNumber },
      select: { id: true },
    });
    if (existing) {
      leadsByCompany.set(lead.companyName, existing.id);
      continue;
    }

    const isTerminal = lead.status === 'WON' || lead.status === 'LOST';
    const createdAt = daysAgo(lead.createdDaysAgo);
    const assignedToId = assignees[lead.assignTo];

    const mobile = `${demo.phonePrefix}${String(1000 + index * 7).slice(-4)}`;

    /*
     * The person behind the enquiry.
     *
     * Created here because the application creates one on every lead, and a
     * seeded database without them left the Contacts screen empty while the
     * Leads screen was full — demo data that does not match what the product
     * actually produces.
     */
    const contact = await prisma.contact.create({
      data: {
        organizationId: organization.id,
        firstName: lead.firstName,
        lastName: lead.lastName,
        mobile,
        email: `${lead.firstName.toLowerCase()}@${slugify(lead.companyName)}.example`,
        companyName: lead.companyName,
        city: lead.city,
        createdBy: ownerId,
        updatedBy: ownerId,
      },
    });

    const row = await prisma.lead.create({
      data: {
        organizationId: organization.id,
        leadNumber,
        contactId: contact.id,
        firstName: lead.firstName,
        lastName: lead.lastName,
        // E.164, built from the organization's own dialling prefix. Unique
        // within the organization so the partial unique index on
        // (organization_id, mobile) is satisfied on re-runs.
        mobile,
        email: `${lead.firstName.toLowerCase()}@${slugify(lead.companyName)}.example`,
        companyName: lead.companyName,
        city: lead.city,
        source: lead.source,
        productInterest: lead.productInterest,
        estimatedValue: lead.estimatedValue,
        status: lead.status,
        priority: lead.priority,
        assignedToId,
        assignedById: ownerId,
        // The leads_active_requires_followup CHECK constraint permits NULL only
        // for terminal statuses — the "no lead left behind" guarantee.
        nextFollowUpAt: isTerminal ? null : daysFromNow(lead.followUpInDays),
        lastActivityAt: daysAgo(Math.min(lead.createdDaysAgo, 2)),
        lostReason: lead.lostReason ?? null,
        wonAt: lead.status === 'WON' ? daysAgo(3) : null,
        lostAt: lead.status === 'LOST' ? daysAgo(5) : null,
        createdBy: ownerId,
        createdAt,
      },
    });

    await prisma.leadActivity.createMany({
      data: timelineFor(lead, createdAt, demo.currency, demo.locale).map((entry) => ({
        organizationId: organization.id,
        leadId: row.id,
        activityType: entry.type,
        description: entry.description,
        performedById: assignedToId,
        createdAt: entry.at,
      })),
    });

    /*
     * The scheduled next action, as a real FollowUp row.
     *
     * `leads.next_follow_up_at` alone is not enough: the follow-up screens, the
     * overdue badge and every dashboard and report count read the FollowUp
     * table. Seeding only the column produced a database where eight leads were
     * overdue and the Follow-ups page was empty — the two disagreeing is
     * exactly the bug the product exists to prevent.
     *
     * Terminal leads get none, matching the rule that a closed lead is not
     * live work.
     */
    if (!isTerminal) {
      const scheduledAt = daysFromNow(lead.followUpInDays);
      const overdue = scheduledAt.getTime() < Date.now();

      await prisma.followUp.create({
        data: {
          organizationId: organization.id,
          leadId: row.id,
          assignedUserId: assignedToId,
          scheduledAt,
          type: 'CALL',
          status: overdue ? 'OVERDUE' : 'UPCOMING',
          title: `Follow up on ${lead.productInterest}`,
          createdBy: ownerId,
        },
      });
    }

    leadsByCompany.set(lead.companyName, row.id);
    created += 1;
  }

  console.log(
    `  ${demo.name} (${demo.slug}) — ${demo.members.length} members, ${created} leads created`,
  );

  /*
   * Conversations, for the first organization only.
   *
   * One tenant with omnichannel data and one without is deliberate: it makes an
   * empty inbox in Meridian obviously correct rather than obviously broken, and
   * it means the cross-tenant checks have a tenant with nothing to leak.
   */
  if (demo.slug === DEMO_ORGANIZATIONS[0]?.slug) {
    await seedOmnichannel({
      prisma,
      organizationId: organization.id,
      userIds: memberIds,
      leadsByCompany,
    });
    console.log(
      `  ${demo.name} — ${OMNICHANNEL_SUMMARY.conversations} conversations, ` +
        `${OMNICHANNEL_SUMMARY.messages} messages, ${OMNICHANNEL_SUMMARY.templates} templates`,
    );
  }

  return organization.id;
}

/**
 * A plausible activity history for a lead, sized to its pipeline stage.
 *
 * A NEW lead with twelve activities, or a WON deal with one, would both look
 * obviously synthetic on the timeline.
 */
function timelineFor(
  lead: DemoLead,
  createdAt: Date,
  currency: string,
  locale: string,
): { type: ActivityType; description: string; at: Date }[] {
  const entries: { type: ActivityType; description: string; at: Date }[] = [
    {
      type: 'LEAD_CREATED',
      description: `Lead captured from ${lead.source}`,
      at: createdAt,
    },
    {
      type: 'LEAD_ASSIGNED',
      description: 'Assigned for first contact',
      at: new Date(createdAt.getTime() + 3_600_000),
    },
  ];

  const stagesReached: Record<string, number> = {
    NEW: 0,
    CONTACTED: 1,
    QUALIFIED: 2,
    FOLLOW_UP: 3,
    QUOTATION_SENT: 4,
    NEGOTIATION: 5,
    WON: 6,
    LOST: 6,
  };
  const depth = stagesReached[lead.status] ?? 0;
  let cursor = createdAt.getTime() + 2 * 3_600_000;
  const step = (): Date => {
    cursor += 1.5 * DAY_MS;
    return new Date(cursor);
  };

  if (depth >= 1) {
    entries.push({
      type: 'CALL_COMPLETED',
      description: `Spoke to ${lead.firstName} about ${lead.productInterest}`,
      at: step(),
    });
  }
  if (depth >= 2) {
    entries.push({
      type: 'WHATSAPP_SENT',
      description: 'Shared product catalogue and pricing sheet',
      at: step(),
    });
    entries.push({
      type: 'STATUS_CHANGED',
      description: 'Budget and timeline confirmed — marked qualified',
      at: step(),
    });
  }
  if (depth >= 3) {
    entries.push({
      type: 'CALL_NOT_ANSWERED',
      description: 'Called, no answer — retry scheduled',
      at: step(),
    });
  }
  if (depth >= 4) {
    entries.push({
      type: 'NOTE_ADDED',
      description: `Quotation sent for ${formatMoney(lead.estimatedValue, currency, locale)}`,
      at: step(),
    });
  }
  if (depth >= 5) {
    entries.push({
      type: 'CALL_COMPLETED',
      description: 'Negotiating payment terms and delivery schedule',
      at: step(),
    });
  }

  if (lead.status === 'WON') {
    entries.push({ type: 'LEAD_WON', description: 'Purchase order received', at: step() });
  }
  if (lead.status === 'LOST') {
    entries.push({
      type: 'LEAD_LOST',
      description: lead.lostReason ?? 'Marked lost',
      at: step(),
    });
  }

  return entries;
}

// -----------------------------------------------------------------------------



/**
 * Gives a demo organization a trial subscription if it has none.
 *
 * Never overwrites an existing one — re-running the seed must not reset a
 * subscription somebody has been working with.
 */
async function seedSubscription(organizationId: string, planIds: Map<string, string>): Promise<void> {
  const planId = planIds.get(DEFAULT_PLAN_CODE);
  if (!planId) return;

  const existing = await prisma.subscription.findUnique({ where: { organizationId } });
  if (existing) return;

  const now = new Date();
  const trialEnd = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);

  await prisma.subscription.create({
    data: {
      organizationId,
      planId,
      status: 'TRIAL',
      billingInterval: 'MONTHLY',
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
      trialEndsAt: trialEnd,
    },
  });
}

async function main(): Promise<void> {
  console.log('Seeding LeadFlow…\n');

  /*
   * The same reference data production bootstraps with, from the same
   * function. Demo organizations are what this file adds on top — and the
   * only thing it adds.
   */
  await syncReferenceData(prisma, (message) => console.log(message));

  const roleIds = await systemRoleIdsByKey(prisma);
  const planIds = await planIdsByCode(prisma);

  const password = process.env['SEED_PASSWORD'] ?? 'ChangeMe!2026';
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  console.log('');
  for (const demo of DEMO_ORGANIZATIONS) {
    const organizationId = await seedOrganization(demo, roleIds, passwordHash);
    await seedSubscription(organizationId, planIds);
  }

  console.log('\nSign in with any of these — password:', password);
  for (const demo of DEMO_ORGANIZATIONS) {
    console.log(`\n  ${demo.name}`);
    for (const member of demo.members) {
      console.log(`    ${member.role.padEnd(10)} ${member.email}`);
    }
  }
  if (!process.env['SEED_PASSWORD']) {
    console.log('\n(Set SEED_PASSWORD to override. Never use this default outside development.)');
  }
}

/** Formats in the ORGANIZATION's currency and locale, never a fixed one. */
function formatMoney(value: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function describe(key: string): string {
  const [resource, ...rest] = key.split('.');
  return `${rest.join(' ')} ${resource}`.trim();
}

function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
