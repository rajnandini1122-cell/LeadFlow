import { RECIPIENT_LIST_LIMIT } from '@leadflow/api-types';
import { listRecipients, type AudienceMember } from './audience';

/** n people a0000@x.example … (sorted by address = creation order). */
const members = (n: number, from = 0): AudienceMember[] =>
  Array.from({ length: n }, (_, i) => ({
    email: `a${String(from + i).padStart(4, '0')}@x.example`,
    leadId: null,
    contactId: null,
    displayName: null,
    merge: {},
  }));

describe('recipient listing at the 1,000-address boundary', () => {
  it('uses a 1,000 limit', () => expect(RECIPIENT_LIST_LIMIT).toBe(1000));

  it.each([
    [999, 999, false, 0],
    [1000, 1000, false, 0],
    [1001, 1000, true, 1],
    [1500, 1000, true, 500],
  ])(
    '%i eligible → %i displayed, truncated=%s, %i undisplayed still receive it',
    (n, displayed, truncated, undisplayed) => {
      const out = listRecipients({ eligible: members(n), handExcluded: [] }, true, 1000);
      expect(out.recipients).toHaveLength(displayed);
      expect(out.recipientsTruncated).toBe(truncated);
      expect(out.recipientsTotal).toBe(n);
      expect(out.undisplayedEligible).toBe(undisplayed);
      expect(out.recipientsListed).toBe(true);
    },
  );

  it('"Deselect all displayed" with 1,500 matching: the 500 undisplayed are still eligible and counted', () => {
    // Every displayed address taken out by hand; the rest untouched.
    const all = members(1500);
    const out = listRecipients(
      { eligible: all.slice(1000), handExcluded: all.slice(0, 1000) },
      true,
      1000,
    );
    expect(out.recipients).toHaveLength(1000);
    expect(out.recipients.every((r) => r.excluded)).toBe(true);
    expect(out.recipientsTotal).toBe(1500);
    expect(out.undisplayedEligible).toBe(500);
  });

  it('a hand-excluded address outside the displayed range is not counted as receiving it', () => {
    const all = members(1200);
    const out = listRecipients(
      { eligible: [...all.slice(0, 1100)], handExcluded: all.slice(1100) },
      true,
      1000,
    );
    expect(out.undisplayedEligible).toBe(100);
  });

  it('without permission to list addresses: no list, and everyone counts as undisplayed', () => {
    const out = listRecipients({ eligible: members(10), handExcluded: [] }, false, 1000);
    expect(out).toMatchObject({
      recipients: [],
      recipientsListed: false,
      recipientsTotal: 10,
      undisplayedEligible: 10,
    });
  });
});
