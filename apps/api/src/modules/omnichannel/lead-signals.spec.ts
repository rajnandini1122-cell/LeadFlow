import { detectBuyingSignals } from './lead-signals';

/**
 * The rules that put a conversation in the "looks like a buying enquiry" pile.
 *
 * A false positive is cheap — a person glances at it and dismisses it. A queue
 * full of false positives is not cheap, because it stops being read at all, so
 * the negative cases below matter as much as the positive ones.
 */
describe('detectBuyingSignals', () => {
  describe('messages that are not enquiries', () => {
    it.each(['Hi', 'Thanks!', 'Nice product', '👍', 'ok', 'Good morning sir'])(
      'does not flag %s',
      (text) => {
        expect(detectBuyingSignals(text).isPotentialLead).toBe(false);
      },
    );

    it.each([null, undefined, '', '   '])('handles %s without flagging', (text) => {
      expect(detectBuyingSignals(text)).toEqual({ isPotentialLead: false, signals: [] });
    });
  });

  describe('real enquiries', () => {
    it('flags a pricing request', () => {
      const match = detectBuyingSignals('Need pricing for 500 kg onion powder.');

      expect(match.isPotentialLead).toBe(true);
      expect(match.signals).toEqual(expect.arrayContaining(['pricing', 'kg']));
    });

    it('flags an MOQ question', () => {
      const match = detectBuyingSignals('What is your MOQ for garlic powder?');

      expect(match.isPotentialLead).toBe(true);
      expect(match.signals).toContain('moq');
    });

    it.each([
      'Please share your quotation',
      'We need a bulk order',
      'Do you supply wholesale?',
      'Looking for a distributor',
      'Can you send a sample',
      'Share your catalogue',
    ])('flags %s', (text) => {
      expect(detectBuyingSignals(text).isPotentialLead).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(detectBuyingSignals('QUOTATION REQUIRED').isPotentialLead).toBe(true);
    });
  });

  describe('word boundaries', () => {
    it.each([
      ['border control', 'order'],
      ['the kgb called', 'kg'],
      ['tonight works', 'ton'],
      ['a pricey mistake', 'price'],
    ])('does not flag %s on the substring %s', (text) => {
      // Substring matching turns the queue into noise, and a noisy queue is
      // the same as no queue.
      expect(detectBuyingSignals(text).isPotentialLead).toBe(false);
    });

    it('still matches a signal against punctuation', () => {
      expect(detectBuyingSignals('quantity?').isPotentialLead).toBe(true);
      expect(detectBuyingSignals('(bulk)').isPotentialLead).toBe(true);
      expect(detectBuyingSignals('500kg, please').signals).not.toContain('kg');
    });
  });

  describe('the reported signals', () => {
    it('deduplicates repeats', () => {
      const match = detectBuyingSignals('price price price');
      expect(match.signals.filter((signal) => signal === 'price')).toHaveLength(1);
    });

    it('reports every distinct signal so the suggestion can be judged', () => {
      const match = detectBuyingSignals('Bulk purchase, need a quote and a sample');

      expect(match.signals).toEqual(
        expect.arrayContaining(['bulk', 'purchase', 'quote', 'sample']),
      );
    });
  });
});
