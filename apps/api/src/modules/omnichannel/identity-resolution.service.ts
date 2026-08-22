import { Injectable, Logger } from '@nestjs/common';
import { toE164 } from '../../common/utils/phone';
import { OmnichannelRepository } from './omnichannel.repository';
import type { ContactResolution, NormalizedChannelEvent } from './channel-event';

/**
 * Working out which existing person an incoming message is from.
 *
 * The governing rule is that being wrong is worse than being unsure. Attaching
 * a stranger's message to an existing customer merges two people's histories,
 * and there is no undo for that — the conversation, the activities and whatever
 * the rep then says are all filed under the wrong human being.
 *
 * So there is no fuzzy matching here at all. No name similarity, no company-name
 * matching, no email guessing. Two exact keys resolve a person, and anything
 * else returns UNRESOLVED and waits for someone to decide.
 */
@Injectable()
export class IdentityResolutionService {
  private readonly logger = new Logger(IdentityResolutionService.name);

  constructor(private readonly repository: OmnichannelRepository) {}

  async resolve(event: NormalizedChannelEvent): Promise<ContactResolution> {
    /*
     * Key 1: an identity we have already recorded.
     *
     * Exact, and the only key that works on Instagram and Messenger, where the
     * provider never discloses a phone number. Checked first because it is also
     * the cheapest and because it is what makes redelivery a no-op.
     */
    const identity = await this.repository.findIdentity(event.channel, event.externalUserId);
    if (identity) {
      return { outcome: 'MATCHED', contactId: identity.contactId, createdIdentity: false };
    }

    /*
     * Key 2: a phone number, on channels that expose one.
     *
     * Canonicalised to E.164 against the ORGANIZATION's country before
     * comparing, because "+91 98200 11001" and "09820011001" are the same
     * customer and a string comparison says they are not.
     *
     * A mobile is a strong identifier: it is how the existing duplicate
     * detection already decides two leads are the same person, so matching on
     * it here is consistent with what the product already treats as identity
     * rather than a new and looser standard.
     */
    const mobile = await this.canonicalMobile(event.senderPhone);
    if (mobile) {
      const contact = await this.repository.findLiveContactByMobile(mobile);
      if (contact) {
        // Found by phone but not yet known on this channel — record the
        // mapping so the next message resolves on key 1 without re-deriving it.
        await this.repository.upsertIdentity({
          contactId: contact.id,
          channel: event.channel,
          externalUserId: event.externalUserId,
          username: event.senderUsername,
          phoneNumber: mobile,
          profileName: event.senderName,
        });

        return { outcome: 'MATCHED', contactId: contact.id, createdIdentity: true };
      }
    }

    /*
     * Nobody we can name with confidence.
     *
     * Deliberately not an error, and deliberately not a new Contact. The
     * message is still stored against a conversation, so nothing is lost; what
     * is withheld is the claim to know who sent it. Creating a contact here
     * would quietly fill the address book with one entry per stranger who ever
     * said "hi", and the review queue exists precisely so a person can make
     * this call.
     */
    return {
      outcome: 'UNRESOLVED',
      reason: mobile
        ? 'No contact matches this phone number, and this channel identity is unknown.'
        : 'This channel identity is unknown and the channel discloses no phone number.',
    };
  }

  /**
   * E.164, or undefined when the input cannot be canonicalised.
   *
   * Failure is non-fatal on purpose: an unparseable number means we cannot use
   * that key, not that the message should be rejected.
   */
  private async canonicalMobile(raw: string | undefined): Promise<string | undefined> {
    if (!raw) return undefined;

    try {
      const country = await this.repository.organizationCountry();
      return toE164(raw, country);
    } catch {
      this.logger.debug('Incoming sender phone could not be canonicalised; skipping phone match.');
      return undefined;
    }
  }
}
