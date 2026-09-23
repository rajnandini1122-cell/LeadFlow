import {
  detectMimeType,
  parseAttachments,
  toAttachmentViews,
  validateMedia,
  MAX_UPLOAD_BYTES,
} from './message-attachment';

/**
 * Attachment handling.
 *
 * Two things here are security controls rather than conveniences: the view
 * mapper, which decides what a browser is allowed to learn about a customer's
 * media, and the type detection, which decides what may be uploaded at all.
 * The negative cases are the valuable ones in both.
 */

const MB = 1024 * 1024;

function jpeg(sizeBytes = 1024): Buffer {
  const buffer = Buffer.alloc(sizeBytes);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  return buffer;
}

describe('toAttachmentViews', () => {
  const stored = [
    {
      providerMediaId: 'wamid-media-123',
      providerUrl: 'https://lookaside.fbsbx.com/signed-capability-url',
      type: 'IMAGE',
      mimeType: 'image/jpeg',
      filename: 'quote.jpg',
      sizeBytes: 2048,
    },
  ];

  it('NEVER exposes the provider media id or url', () => {
    const [view] = toAttachmentViews(stored);
    const serialised = JSON.stringify(view);

    /*
     * The whole point of the view. Both fields are credentials in effect —
     * one works with our access token, the other works for anyone holding the
     * link — so handing either to a browser would give away access to a
     * customer's media.
     */
    expect(serialised).not.toContain('wamid-media-123');
    expect(serialised).not.toContain('lookaside');
    expect(view).not.toHaveProperty('providerMediaId');
    expect(view).not.toHaveProperty('providerUrl');
  });

  it('exposes only what a client needs to render a row', () => {
    expect(toAttachmentViews(stored)[0]).toEqual({
      index: 0,
      type: 'IMAGE',
      mimeType: 'image/jpeg',
      filename: 'quote.jpg',
      sizeBytes: 2048,
      retrievable: true,
    });
  });

  it('indexes attachments by position, which cannot be walked across tenants', () => {
    const views = toAttachmentViews([stored[0], { ...stored[0], type: 'DOCUMENT' }]);
    expect(views.map((v) => v.index)).toEqual([0, 1]);
  });

  it('reports an attachment with no reference as not retrievable', () => {
    // A record that media arrived, honest about not being able to show it.
    const views = toAttachmentViews([
      { ...stored[0], providerMediaId: null, providerUrl: null },
    ]);
    expect(views[0]?.retrievable).toBe(false);
  });

  it.each([null, undefined, 'a string', 42, {}])('survives stored value %p', (value) => {
    expect(toAttachmentViews(value)).toEqual([]);
  });

  it('drops entries that are not attachments rather than guessing', () => {
    expect(toAttachmentViews([stored[0], null, 'x', { noType: true }])).toHaveLength(1);
  });
});

describe('parseAttachments', () => {
  it('leaves a field the provider never gave as null', () => {
    const [parsed] = parseAttachments([{ type: 'IMAGE' }]);

    // Never invented. An empty filename is a lie about what arrived.
    expect(parsed).toMatchObject({
      providerMediaId: null,
      providerUrl: null,
      mimeType: null,
      filename: null,
      sizeBytes: null,
    });
  });
});

describe('detectMimeType', () => {
  it.each([
    ['JPEG', [0xff, 0xd8, 0xff], 'image/jpeg'],
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
    ['PDF', [0x25, 0x50, 0x44, 0x46], 'application/pdf'],
    ['Ogg', [0x4f, 0x67, 0x67, 0x53], 'audio/ogg'],
    ['MP3 with ID3', [0x49, 0x44, 0x33], 'audio/mpeg'],
  ])('recognises %s from its leading bytes', (_label, bytes, expected) => {
    const buffer = Buffer.alloc(32);
    bytes.forEach((byte, index) => {
      buffer[index] = byte;
    });

    expect(detectMimeType(buffer)).toBe(expected);
  });

  it('tells MP4 video from M4A audio by its brand', () => {
    const make = (brand: string): Buffer => {
      const buffer = Buffer.alloc(32);
      buffer.write('ftyp', 4, 'ascii');
      buffer.write(brand, 8, 'ascii');
      return buffer;
    };

    expect(detectMimeType(make('isom'))).toBe('video/mp4');
    expect(detectMimeType(make('M4A '))).toBe('audio/mp4');
    expect(detectMimeType(make('3gp4'))).toBe('video/3gpp');
  });

  it('refuses a file whose bytes it does not recognise', () => {
    // Failing closed is the correct direction: an unrecognised file is not
    // sent, rather than being sent as whatever the browser claimed.
    expect(detectMimeType(Buffer.from('MZ\x90\x00 an executable, actually'))).toBeNull();
  });

  it('refuses a ZIP even though .docx is one', () => {
    const zip = Buffer.alloc(32);
    zip.write('PK', 0, 'binary');

    // Recognising "this is a ZIP" and calling it a Word document would let
    // anything zipped through.
    expect(detectMimeType(zip)).toBeNull();
  });

  it('refuses a file too short to identify', () => {
    expect(detectMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

describe('validateMedia', () => {
  it('accepts a JPEG on every channel that carries images', () => {
    for (const channel of ['WHATSAPP', 'FACEBOOK', 'INSTAGRAM'] as const) {
      const result = validateMedia(channel, 'image/jpeg', 1024);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.type).toBe('IMAGE');
    }
  });

  it('refuses a document on Instagram, which does not carry them', () => {
    // Declaring support and letting Meta refuse after the upload wastes the
    // user's time and their bandwidth.
    const result = validateMedia('INSTAGRAM', 'application/pdf', 1024);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/cannot be sent on this channel/i);
  });

  it('accepts a document on WhatsApp', () => {
    expect(validateMedia('WHATSAPP', 'application/pdf', 1024).ok).toBe(true);
  });

  it('enforces the per-kind limit, not one number for everything', () => {
    // WhatsApp images stop at 5MB where its video goes to 16MB.
    expect(validateMedia('WHATSAPP', 'image/jpeg', 6 * MB).ok).toBe(false);
    expect(validateMedia('WHATSAPP', 'video/mp4', 6 * MB).ok).toBe(true);
  });

  it('names the limit it enforced', () => {
    const result = validateMedia('WHATSAPP', 'image/jpeg', 6 * MB);

    if (result.ok) throw new Error('expected a refusal');
    expect(result.message).toMatch(/5MB/);
  });

  it('refuses an empty file', () => {
    expect(validateMedia('WHATSAPP', 'image/jpeg', 0).ok).toBe(false);
  });

  it('refuses a file whose type could not be detected', () => {
    const result = validateMedia('WHATSAPP', null, 1024);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/could not be identified/i);
  });

  it('refuses an executable dressed as an image', () => {
    // The browser said image/png; the bytes said otherwise, and detection is
    // what validateMedia is given.
    const detected = detectMimeType(Buffer.from('MZ\x90\x00 windows executable'));
    expect(validateMedia('WHATSAPP', detected, 1024).ok).toBe(false);
  });

  it('refuses a channel with no media policy at all', () => {
    const result = validateMedia('TELEGRAM' as never, 'image/jpeg', 1024);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not available for this channel/i);
  });

  it('keeps every per-kind limit within the upload ceiling', () => {
    // The ceiling is what the request parser enforces; a rule above it could
    // never be reached and would be a lie in the documentation.
    for (const rules of Object.values(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('./message-attachment') as typeof import('./message-attachment')).MEDIA_RULES,
    )) {
      for (const rule of Object.values(rules)) {
        expect(rule!.maxBytes).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
      }
    }
  });

  it('validates the type from bytes, so a JPEG buffer round-trips', () => {
    const buffer = jpeg(2048);
    const detected = detectMimeType(buffer);

    expect(detected).toBe('image/jpeg');
    expect(validateMedia('WHATSAPP', detected, buffer.length).ok).toBe(true);
  });
});
