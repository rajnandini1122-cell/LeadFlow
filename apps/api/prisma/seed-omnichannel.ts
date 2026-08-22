import type { PrismaClient } from '../src/generated/prisma/client';

/**
 * Demo conversations, so the inbox, review queue and template picker have
 * something real to show.
 *
 * The lead and user fixtures already gave the CRM screens data. The omnichannel
 * screens had none, which made them impossible to evaluate without connecting a
 * live Meta account — so this fills that gap and nothing else. It is additive:
 * no existing seed function is changed, and running it is idempotent.
 *
 * Three rules it holds to:
 *
 *   1. **Integrations are DISCONNECTED with no credential.** They exist so the
 *      settings screen and the conversation joins have rows to point at. They
 *      are emphatically not marked CONNECTED — that would tell an owner their
 *      WhatsApp number is live when no provider integration exists, and they
 *      would stop checking their phone. Seeded conversations cannot send.
 *
 *   2. **Only states the real code can produce.** An inbound message never has
 *      a delivery status; an outbound one always does. FAILED carries a reason,
 *      UNCONFIRMED carries the recovery sweep's wording. A fixture that
 *      contradicts the status rules would make a broken implementation look
 *      correct.
 *
 *   3. **Ownership and visibility are real.** Conversations are spread across
 *      owners and link states so that signing in as a rep versus an owner
 *      genuinely shows different things — which is the point of having demo
 *      data at all.
 *
 * All names, numbers and handles are fictional. Phone numbers use ranges
 * reserved for documentation and drama.
 */

interface SeedContext {
  prisma: PrismaClient;
  organizationId: string;
  /** email -> user id, for assigning owners. */
  userIds: Map<string, string>;
  /** Lead ids by company name, for linking conversations to real leads. */
  leadsByCompany: Map<string, string>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const ago = (ms: number): Date => new Date(Date.now() - ms);

/**
 * The demo accounts each channel would speak as.
 *
 * Format-plausible but not real: a WhatsApp phone number id, an Instagram
 * professional account id and a Facebook Page id.
 */
const DEMO_ACCOUNTS = {
  WHATSAPP: { id: '100000000000001', name: 'Northwind Supply (demo)' },
  INSTAGRAM: { id: '178400000000001', name: '@northwindsupply (demo)' },
  FACEBOOK: { id: '612000000000001', name: 'Northwind Supply Page (demo)' },
} as const;

type Channel = keyof typeof DEMO_ACCOUNTS;

/** One demo message. Deliberately close to what the real ingestion writes. */
interface DemoMessage {
  direction: 'INCOMING' | 'OUTGOING';
  content: string | null;
  /** Hours ago. Drives the 24-hour window, so it decides what the UI offers. */
  hoursAgo: number;
  messageType?: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'TEMPLATE';
  deliveryStatus?: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'UNCONFIRMED';
  failureReason?: string;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
}

interface DemoConversation {
  channel: Channel;
  /** The customer's provider-scoped identity. */
  customerId: string;
  contact: { firstName: string; lastName: string; mobile?: string; companyName?: string };
  /** Company name of the lead to link to, or null to leave it unlinked. */
  linkToLeadCompany: string | null;
  linkState: 'LINKED' | 'UNLINKED' | 'REVIEW_REQUIRED';
  /** Email of the owning user, or null for the unassigned queue. */
  ownerEmail: string | null;
  messages: DemoMessage[];
}

/**
 * The demo threads.
 *
 * Chosen to cover what somebody evaluating the app needs to see: every channel,
 * every delivery state the code can produce, an open window and a closed one, a
 * media message, a template, and all three link states including the one that
 * lands in the review queue.
 */
const DEMO_CONVERSATIONS: DemoConversation[] = [
  // --- WhatsApp, window OPEN, linked to a real lead -------------------------
  {
    channel: 'WHATSAPP',
    customerId: '14155550201',
    contact: {
      firstName: 'Helen',
      lastName: 'Barrett',
      mobile: '+14155550201',
      companyName: 'Barrett Industrial',
    },
    linkToLeadCompany: 'Barrett Industrial',
    linkState: 'LINKED',
    ownerEmail: 'sofia@northwind.example',
    messages: [
      { direction: 'INCOMING', content: 'Hi, following up on the packaging line quote.', hoursAgo: 5 },
      {
        direction: 'OUTGOING',
        content: 'Morning Helen — revised quote is with our engineer, you will have it today.',
        hoursAgo: 4,
        deliveryStatus: 'READ',
      },
      { direction: 'INCOMING', content: 'Perfect. Does it include installation?', hoursAgo: 2 },
    ],
  },

  // --- WhatsApp, window CLOSED: this is where templates matter --------------
  {
    channel: 'WHATSAPP',
    customerId: '14155550202',
    contact: {
      firstName: 'Omar',
      lastName: 'Haddad',
      mobile: '+14155550202',
      companyName: 'Crescent Textiles',
    },
    linkToLeadCompany: 'Crescent Textiles',
    linkState: 'LINKED',
    ownerEmail: 'tomas@northwind.example',
    messages: [
      {
        direction: 'INCOMING',
        content: 'Can you send pricing for the bulk dyeing units?',
        // Past 24 hours, so free-form is refused and only a template can go out.
        hoursAgo: 52,
      },
      {
        direction: 'OUTGOING',
        content: 'Sent through just now — let me know if the volumes look right.',
        hoursAgo: 50,
        deliveryStatus: 'DELIVERED',
      },
      {
        direction: 'OUTGOING',
        // A template: the one thing that can be sent after the window closes.
        content: 'Hi Omar, your quote QT-4471 is ready. Reply to this message to continue.',
        hoursAgo: 26,
        messageType: 'TEMPLATE',
        deliveryStatus: 'READ',
        metadata: {
          template: {
            name: 'quote_ready',
            language: 'en_US',
            parameters: { header: [], body: ['Omar', 'QT-4471'] },
          },
        },
      },
    ],
  },

  // --- WhatsApp with a failed send and an unconfirmed one -------------------
  {
    channel: 'WHATSAPP',
    customerId: '14155550203',
    contact: {
      firstName: 'Grace',
      lastName: 'Okonkwo',
      mobile: '+14155550203',
      companyName: 'Okonkwo Agro Foods',
    },
    linkToLeadCompany: 'Okonkwo Agro Foods',
    linkState: 'LINKED',
    ownerEmail: 'sofia@northwind.example',
    messages: [
      { direction: 'INCOMING', content: 'Is the cold storage retrofit still available?', hoursAgo: 8 },
      {
        direction: 'OUTGOING',
        content: 'Yes — I will send the site survey checklist.',
        hoursAgo: 7,
        deliveryStatus: 'FAILED',
        failureReason: 'WhatsApp rejected the message. Please check the conversation and try again.',
      },
      {
        direction: 'OUTGOING',
        content: 'Attaching the checklist now.',
        hoursAgo: 6,
        messageType: 'DOCUMENT',
        deliveryStatus: 'UNCONFIRMED',
        failureReason:
          'Delivery could not be confirmed, and the message was not resent automatically. ' +
          'Check WhatsApp before sending it again.',
        attachments: [
          {
            providerMediaId: null,
            providerUrl: null,
            type: 'DOCUMENT',
            mimeType: 'application/pdf',
            filename: 'site-survey-checklist.pdf',
            sizeBytes: 184320,
          },
        ],
      },
    ],
  },

  // --- Instagram, inbound media, UNLINKED: needs a lead --------------------
  {
    channel: 'INSTAGRAM',
    customerId: 'ig-user-770001',
    contact: { firstName: 'Priyanka', lastName: 'Nair' },
    linkToLeadCompany: null,
    linkState: 'UNLINKED',
    ownerEmail: null, // the unassigned queue
    messages: [
      {
        direction: 'INCOMING',
        content: 'Saw your post — do you supply shelving for retail?',
        hoursAgo: 3,
      },
      {
        direction: 'INCOMING',
        content: 'This is the shop layout.',
        hoursAgo: 3,
        messageType: 'IMAGE',
        attachments: [
          {
            providerMediaId: 'demo-media-ig-1',
            providerUrl: null,
            type: 'IMAGE',
            mimeType: 'image/jpeg',
            filename: 'shop-layout.jpg',
            sizeBytes: 402118,
          },
        ],
      },
    ],
  },

  // --- Facebook Messenger, REVIEW_REQUIRED: several leads matched ----------
  {
    channel: 'FACEBOOK',
    customerId: 'fb-user-880002',
    contact: { firstName: 'Daniel', lastName: 'Kovacs', companyName: 'Kovacs Print House' },
    linkToLeadCompany: null,
    // Two active leads matched this person, so nothing was linked
    // automatically and a human has to decide.
    linkState: 'REVIEW_REQUIRED',
    ownerEmail: null,
    messages: [
      {
        direction: 'INCOMING',
        content: 'Hello, we spoke about the digital press last quarter. Any new pricing?',
        hoursAgo: 20,
      },
    ],
  },

  // --- Facebook Messenger, linked and owned by the manager -----------------
  {
    channel: 'FACEBOOK',
    customerId: 'fb-user-880003',
    contact: { firstName: 'Ravi', lastName: 'Deshpande', companyName: 'Sunrise Packaging' },
    linkToLeadCompany: 'Sunrise Packaging',
    linkState: 'LINKED',
    ownerEmail: 'manager@northwind.example',
    messages: [
      { direction: 'INCOMING', content: 'Can we move the corrugation demo to Thursday?', hoursAgo: 11 },
      {
        direction: 'OUTGOING',
        content: 'Thursday 2pm works. I will confirm with the technician.',
        hoursAgo: 10,
        deliveryStatus: 'SENT',
      },
    ],
  },

  // --- Instagram, unlinked, older: gives the inbox a second page of variety -
  {
    channel: 'INSTAGRAM',
    customerId: 'ig-user-770004',
    contact: { firstName: 'Marco', lastName: 'Ferreira' },
    linkToLeadCompany: null,
    linkState: 'UNLINKED',
    ownerEmail: 'tomas@northwind.example',
    messages: [
      { direction: 'INCOMING', content: 'Do you ship to Canada?', hoursAgo: 30 },
      {
        direction: 'OUTGOING',
        content: 'We do — I will send the freight rates.',
        hoursAgo: 29,
        deliveryStatus: 'DELIVERED',
      },
    ],
  },
];

/**
 * WhatsApp templates for the demo organization.
 *
 * Written directly into the cache table, which is exactly what a real sync
 * produces — the row shape is the same whether Meta filled it or this did.
 * Two are sendable and two are not, so the picker's refusals are visible
 * without needing a Meta account.
 */
const DEMO_TEMPLATES = [
  {
    name: 'quote_ready',
    language: 'en_US',
    category: 'UTILITY',
    status: 'APPROVED' as const,
    supported: true,
    unsupportedReason: null,
    bodyText: 'Hi {{1}}, your quote {{2}} is ready. Reply to this message to continue.',
    footer: 'Northwind Supply',
    bodyParameterCount: 2,
  },
  {
    name: 'follow_up_reminder',
    language: 'en_US',
    category: 'UTILITY',
    status: 'APPROVED' as const,
    supported: true,
    unsupportedReason: null,
    bodyText: 'Hello {{1}}, just checking whether you had a chance to review our proposal.',
    footer: null,
    bodyParameterCount: 1,
  },
  {
    name: 'seasonal_offer',
    language: 'en_US',
    category: 'MARKETING',
    // Not approved: shown in settings, refused by the picker.
    status: 'PENDING' as const,
    supported: true,
    unsupportedReason: null,
    bodyText: 'Hi {{1}}, our seasonal pricing is live until {{2}}.',
    footer: null,
    bodyParameterCount: 2,
  },
  {
    name: 'catalogue_launch',
    language: 'en_US',
    category: 'MARKETING',
    status: 'APPROVED' as const,
    // Approved but unsendable: demonstrates the second, separate condition.
    supported: false,
    unsupportedReason: 'This template has an IMAGE header, which LeadFlow cannot send yet.',
    bodyText: 'Hi {{1}}, our new catalogue is out.',
    footer: null,
    bodyParameterCount: 1,
  },
];

/**
 * Seeds channel integrations, conversations, messages and templates.
 *
 * Idempotent: every row is keyed on something stable and looked up before it is
 * written, so running the seed twice does not double the inbox.
 */
export async function seedOmnichannel(context: SeedContext): Promise<void> {
  const { prisma, organizationId, userIds, leadsByCompany } = context;

  // --- integrations ---------------------------------------------------------
  const integrationIds = new Map<Channel, string>();

  for (const [channel, account] of Object.entries(DEMO_ACCOUNTS) as [
    Channel,
    (typeof DEMO_ACCOUNTS)[Channel],
  ][]) {
    const existing = await prisma.channelIntegration.findFirst({
      where: { channel, providerAccountId: account.id },
    });

    const integration =
      existing ??
      (await prisma.channelIntegration.create({
        data: {
          organizationId,
          channel,
          /*
           * DISCONNECTED, and with no credential.
           *
           * The row exists so conversations have something to hang off and the
           * settings screen has something to show. Marking it CONNECTED would
           * claim a provider integration that does not exist, and an owner who
           * believes their number is live stops watching their phone.
           */
          status: 'DISCONNECTED',
          enabled: true,
          providerAccountId: account.id,
          displayName: account.name,
          encryptedAccessToken: null,
        },
      }));

    integrationIds.set(channel, integration.id);
  }

  // --- conversations --------------------------------------------------------
  for (const demo of DEMO_CONVERSATIONS) {
    const integrationId = integrationIds.get(demo.channel) as string;
    const account = DEMO_ACCOUNTS[demo.channel];
    const externalConversationId = `${account.id}:${demo.customerId}`;

    const already = await prisma.conversation.findFirst({
      where: { externalConversationId, channel: demo.channel },
    });
    if (already) continue;

    // The contact, matched on the channel identity the way ingestion does.
    const contact = await prisma.contact.create({
      data: {
        organizationId,
        firstName: demo.contact.firstName,
        lastName: demo.contact.lastName,
        ...(demo.contact.mobile ? { mobile: demo.contact.mobile } : {}),
        ...(demo.contact.companyName ? { companyName: demo.contact.companyName } : {}),
      },
    });

    await prisma.contactChannelIdentity.create({
      data: {
        organizationId,
        contactId: contact.id,
        channel: demo.channel,
        externalUserId: demo.customerId,
        ...(demo.contact.mobile ? { phoneNumber: demo.contact.mobile } : {}),
        profileName: `${demo.contact.firstName} ${demo.contact.lastName}`,
      },
    });

    const leadId = demo.linkToLeadCompany
      ? (leadsByCompany.get(demo.linkToLeadCompany) ?? null)
      : null;

    const lastMessageAt = ago(
      Math.min(...demo.messages.map((message) => message.hoursAgo)) * HOUR_MS,
    );

    const conversation = await prisma.conversation.create({
      data: {
        organizationId,
        channel: demo.channel,
        integrationId,
        externalConversationId,
        contactId: contact.id,
        leadId,
        ownerId: demo.ownerEmail ? (userIds.get(demo.ownerEmail) ?? null) : null,
        ...(demo.contact.companyName ? { companyName: demo.contact.companyName } : {}),
        status: 'OPEN',
        linkState: demo.linkState,
        lastMessageAt,
      },
    });

    for (const [index, message] of demo.messages.entries()) {
      const at = ago(message.hoursAgo * HOUR_MS);
      const inbound = message.direction === 'INCOMING';

      await prisma.message.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          channel: demo.channel,
          // Inbound messages carry a provider id; outbound demo rows do not
          // need one, and a null is what an unsent row genuinely looks like.
          externalMessageId: inbound
            ? `demo-${demo.channel.toLowerCase()}-${demo.customerId}-${index}`
            : null,
          direction: message.direction,
          senderType: inbound ? 'CONTACT' : 'AGENT',
          messageType: message.messageType ?? 'TEXT',
          content: message.content,
          // Only outbound messages have a delivery status. An inbound one with
          // a status would be a state the real code cannot produce.
          ...(inbound ? {} : { deliveryStatus: message.deliveryStatus ?? 'SENT' }),
          ...(message.failureReason ? { failureReason: message.failureReason } : {}),
          ...(message.attachments ? { attachments: message.attachments as never } : {}),
          ...(message.metadata ? { metadata: message.metadata as never } : {}),
          ...(inbound
            ? { receivedAt: at }
            : {
                // A failed send never reached the customer, so it has no sentAt.
                ...(message.deliveryStatus === 'FAILED' ? {} : { sentAt: at }),
                sentById: demo.ownerEmail ? (userIds.get(demo.ownerEmail) ?? null) : null,
              }),
          createdAt: at,
        },
      });
    }
  }

  // --- WhatsApp templates ---------------------------------------------------
  const whatsappIntegrationId = integrationIds.get('WHATSAPP') as string;

  for (const template of DEMO_TEMPLATES) {
    const existing = await prisma.whatsAppTemplate.findFirst({
      where: { name: template.name, language: template.language },
    });
    if (existing) continue;

    await prisma.whatsAppTemplate.create({
      data: {
        organizationId,
        integrationId: whatsappIntegrationId,
        name: template.name,
        language: template.language,
        category: template.category,
        status: template.status,
        providerTemplateId: null,
        // The same shape a real sync writes.
        components: {
          header: null,
          body: { text: template.bodyText, parameterCount: template.bodyParameterCount },
          footer: template.footer,
          buttons: [],
        } as never,
        supported: template.supported,
        unsupportedReason: template.unsupportedReason,
        headerParameterCount: 0,
        bodyParameterCount: template.bodyParameterCount,
        syncedAt: ago(2 * DAY_MS),
      },
    });
  }
}

/** What was seeded, for the console summary. */
export const OMNICHANNEL_SUMMARY = {
  conversations: DEMO_CONVERSATIONS.length,
  messages: DEMO_CONVERSATIONS.reduce((total, c) => total + c.messages.length, 0),
  templates: DEMO_TEMPLATES.length,
  channels: Object.keys(DEMO_ACCOUNTS).length,
};
