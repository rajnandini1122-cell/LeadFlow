import {
  buildTemplateComponents,
  countPlaceholders,
  parseTemplate,
  parseTemplateList,
  readStoredComponents,
  renderTemplateText,
  MAX_PARAMETER_LENGTH,
} from './whatsapp-template';

/**
 * Reading and sending WhatsApp templates.
 *
 * The valuable cases here are the refusals. A template sent with the wrong
 * number of values reaches a real customer with `{{2}}` in the middle of a
 * sentence, and unlike a bad status or a stale count there is no correcting it
 * afterwards.
 */

function template(components: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: '1234567890',
    name: 'order_ready',
    language: 'en_US',
    category: 'UTILITY',
    status: 'APPROVED',
    components,
    ...overrides,
  };
}

const BODY = { type: 'BODY', text: 'Hi {{1}}, your order {{2}} is ready.' };

describe('countPlaceholders', () => {
  it('counts each placeholder once', () => {
    expect(countPlaceholders('Hi {{1}}, your order {{2}} is ready.')).toBe(2);
  });

  it('counts a repeated placeholder ONCE', () => {
    // Meta numbers its placeholders, so {{1}} twice still takes one value.
    // Counting occurrences would ask for a value with nowhere to go.
    expect(countPlaceholders('Hi {{1}}, we will call you {{1}} back.')).toBe(1);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(countPlaceholders('Hi {{ 1 }} and {{2}}')).toBe(2);
  });

  it('finds none in plain text', () => {
    expect(countPlaceholders('Thanks for getting in touch.')).toBe(0);
  });

  it('ignores things that only look like placeholders', () => {
    expect(countPlaceholders('Use {{one}} or {0} or {{-1}}')).toBe(0);
  });
});

describe('parseTemplate', () => {
  it('reads a body-only template', () => {
    const parsed = parseTemplate(template([BODY]));

    expect(parsed).toMatchObject({
      name: 'order_ready',
      language: 'en_US',
      category: 'UTILITY',
      status: 'APPROVED',
      supported: true,
      unsupportedReason: null,
    });
    expect(parsed?.body?.parameterCount).toBe(2);
  });

  it('reads a text header, a footer and button labels', () => {
    const parsed = parseTemplate(
      template([
        { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' },
        BODY,
        { type: 'FOOTER', text: 'Reply STOP to opt out' },
        { type: 'BUTTONS', buttons: [{ text: 'Track order' }, { text: 'Call us' }] },
      ]),
    );

    expect(parsed?.header?.parameterCount).toBe(1);
    expect(parsed?.footer).toBe('Reply STOP to opt out');
    expect(parsed?.buttons).toEqual(['Track order', 'Call us']);
    // Buttons are informational in this phase, not a reason to refuse.
    expect(parsed?.supported).toBe(true);
  });

  describe('what cannot be sent', () => {
    it.each(['IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'])(
      'refuses a %s header, with a reason',
      (format) => {
        const parsed = parseTemplate(
          template([{ type: 'HEADER', format, text: '' }, BODY]),
        );

        // Sending it without the header produces a broken message at the
        // customer's end, which is worse than not offering it.
        expect(parsed?.supported).toBe(false);
        expect(parsed?.unsupportedReason).toMatch(new RegExp(format, 'i'));
      },
    );

    it('refuses a template with no body', () => {
      const parsed = parseTemplate(template([{ type: 'FOOTER', text: 'bye' }]));

      expect(parsed?.supported).toBe(false);
      expect(parsed?.unsupportedReason).toMatch(/no message body/i);
    });

    it('refuses a component type it does not recognise', () => {
      const parsed = parseTemplate(template([BODY, { type: 'CAROUSEL' }]));

      // Silently dropping it would send a customer half a message.
      expect(parsed?.supported).toBe(false);
      expect(parsed?.unsupportedReason).toMatch(/does not support/i);
    });
  });

  describe('status', () => {
    it.each(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED'])(
      'reads %s as Meta reported it',
      (status) => {
        expect(parseTemplate(template([BODY], { status }))?.status).toBe(status);
      },
    );

    it('treats an unrecognised status as DISABLED, not approved', () => {
      // Failing closed. An unknown status must never become permission to send.
      expect(parseTemplate(template([BODY], { status: 'SOMETHING_NEW' }))?.status).toBe(
        'DISABLED',
      );
    });

    it('treats a missing status as DISABLED', () => {
      expect(parseTemplate(template([BODY], { status: undefined }))?.status).toBe('DISABLED');
    });
  });

  describe('malformed input', () => {
    it.each([null, undefined, 'a string', 42, []])('returns null for %p', (raw) => {
      expect(parseTemplate(raw)).toBeNull();
    });

    it('returns null without a name or a language', () => {
      expect(parseTemplate(template([BODY], { name: undefined }))).toBeNull();
      expect(parseTemplate(template([BODY], { language: undefined }))).toBeNull();
    });

    it('never throws on odd components', () => {
      expect(() => parseTemplate(template(['x', null, 42, {}]))).not.toThrow();
    });
  });
});

describe('parseTemplateList', () => {
  it('reads every template in a Meta response', () => {
    const parsed = parseTemplateList({
      data: [template([BODY]), template([BODY], { name: 'second' })],
    });

    expect(parsed.map((t) => t.name)).toEqual(['order_ready', 'second']);
  });

  it('keeps the readable templates when one is not', () => {
    // One odd template must not hide every good one.
    const parsed = parseTemplateList({ data: [template([BODY]), 'garbage', null] });
    expect(parsed).toHaveLength(1);
  });

  it.each([null, undefined, {}, { data: 'x' }])('survives %p', (payload) => {
    expect(parseTemplateList(payload)).toEqual([]);
  });
});

describe('readStoredComponents', () => {
  it('round-trips a parsed template through the stored shape', () => {
    const parsed = parseTemplate(
      template([
        { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' },
        BODY,
        { type: 'FOOTER', text: 'Reply STOP to opt out' },
        { type: 'BUTTONS', buttons: [{ text: 'Track order' }] },
      ]),
    )!;

    // What the repository writes to the JSON column.
    const stored = JSON.parse(
      JSON.stringify({
        header: parsed.header,
        body: parsed.body,
        footer: parsed.footer,
        buttons: parsed.buttons,
      }),
    ) as unknown;

    expect(readStoredComponents(stored)).toEqual({
      header: { text: 'Order {{1}}', parameterCount: 1 },
      body: { text: 'Hi {{1}}, your order {{2}} is ready.', parameterCount: 2 },
      footer: 'Reply STOP to opt out',
      buttons: ['Track order'],
    });
  });

  it('re-derives the parameter count from the text, not the stored number', () => {
    /*
     * The two are written together and should agree. If they ever do not, the
     * text is the one that is true: it is what the customer receives, and it
     * decides how many blanks there are to fill.
     */
    const result = readStoredComponents({
      body: { text: 'Hi {{1}}, order {{2}}.', parameterCount: 99 },
    });

    expect(result.body?.parameterCount).toBe(2);
  });

  it.each([null, undefined, 'a string', 42, [], {}])('degrades to empty for %p', (stored) => {
    // Empty means validation refuses the send, which is the safe direction: a
    // row that cannot be read must not become a message with {{1}} in it.
    expect(readStoredComponents(stored)).toEqual({
      header: null,
      body: null,
      footer: null,
      buttons: [],
    });
  });

  it('never throws on a malformed row', () => {
    expect(() =>
      readStoredComponents({ header: 'x', body: 42, footer: [], buttons: 'nope' }),
    ).not.toThrow();
  });

  it('drops non-string button labels rather than rendering them', () => {
    expect(readStoredComponents({ buttons: ['Track', 7, null] }).buttons).toEqual(['Track']);
  });
});

describe('buildTemplateComponents', () => {
  const parsed = parseTemplate(
    template([{ type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' }, BODY]),
  )!;

  it('builds the payload Meta expects', () => {
    const result = buildTemplateComponents(parsed, {
      header: ['A-1024'],
      body: ['Rahul', 'A-1024'],
    });

    expect(result).toEqual({
      ok: true,
      components: [
        { type: 'header', parameters: [{ type: 'text', text: 'A-1024' }] },
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Rahul' },
            { type: 'text', text: 'A-1024' },
          ],
        },
      ],
    });
  });

  it('omits a section that takes no parameters', () => {
    const bodyOnly = parseTemplate(template([{ type: 'BODY', text: 'Your order is ready.' }]))!;
    const result = buildTemplateComponents(bodyOnly, { header: [], body: [] });

    expect(result).toEqual({ ok: true, components: [] });
  });

  describe('parameter counts', () => {
    it('refuses too few body values', () => {
      const result = buildTemplateComponents(parsed, { header: ['A-1'], body: ['Rahul'] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/needs 2 values/i);
    });

    it('refuses too many body values', () => {
      const result = buildTemplateComponents(parsed, {
        header: ['A-1'],
        body: ['Rahul', 'A-1', 'extra'],
      });

      expect(result.ok).toBe(false);
    });

    it('refuses the wrong number of header values', () => {
      const result = buildTemplateComponents(parsed, { header: [], body: ['Rahul', 'A-1'] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/header value/i);
    });
  });

  describe('parameter contents', () => {
    it.each(['', '   '])('refuses the blank value %p', (value) => {
      // An empty placeholder reaches the customer as a gap in a sentence.
      const result = buildTemplateComponents(parsed, {
        header: ['A-1'],
        body: [value, 'A-1'],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/must be filled in/i);
    });

    it.each(['line\nbreak', 'tab\there', 'carriage\rreturn'])(
      'refuses %p, which Meta rejects anyway',
      (value) => {
        const result = buildTemplateComponents(parsed, {
          header: ['A-1'],
          body: [value, 'A-1'],
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toMatch(/line breaks/i);
      },
    );

    it('refuses a value over the provider limit', () => {
      const result = buildTemplateComponents(parsed, {
        header: ['A-1'],
        body: ['x'.repeat(MAX_PARAMETER_LENGTH + 1), 'A-1'],
      });

      expect(result.ok).toBe(false);
    });
  });

  it('refuses an unsupported template outright', () => {
    const unsupported = parseTemplate(
      template([{ type: 'HEADER', format: 'IMAGE' }, BODY]),
    )!;

    const result = buildTemplateComponents(unsupported, { header: [], body: ['a', 'b'] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/image header/i);
  });
});

describe('renderTemplateText', () => {
  it('substitutes the values a customer will actually see', () => {
    const parsed = parseTemplate(
      template([
        { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' },
        BODY,
        { type: 'FOOTER', text: 'Reply STOP to opt out' },
      ]),
    )!;

    const rendered = renderTemplateText(parsed, {
      header: ['A-1024'],
      body: ['Rahul', 'A-1024'],
    });

    // The timeline shows what the customer received, not a template name they
    // never saw.
    expect(rendered).toBe(
      'Order A-1024\n\nHi Rahul, your order A-1024 is ready.\n\nReply STOP to opt out',
    );
  });

  it('reuses one value for a repeated placeholder', () => {
    const parsed = parseTemplate(
      template([{ type: 'BODY', text: 'Hi {{1}}, thanks {{1}}.' }]),
    )!;

    expect(renderTemplateText(parsed, { header: [], body: ['Rahul'] })).toBe(
      'Hi Rahul, thanks Rahul.',
    );
  });

  it('leaves a placeholder with no value visible rather than blanking it', () => {
    const parsed = parseTemplate(template([BODY]))!;

    // Validation stops this reaching a customer. If it somehow did, an obvious
    // placeholder is more diagnosable than a silent gap.
    expect(renderTemplateText(parsed, { header: [], body: ['Rahul'] })).toContain('{{2}}');
  });
});
