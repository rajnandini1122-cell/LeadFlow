import type { ChannelType, MessageType } from '../../generated/prisma/enums';

/**
 * Media on a message.
 *
 * Stored in the existing `messages.attachments` JSON column rather than a table
 * of its own, and that is a decision rather than a shortcut. An attachment is
 * never queried independently, its authorization is entirely derived from the
 * message that owns it, and its lifecycle is identical to that message's. A
 * separate table would add a join, a cascade and a second tenant boundary to
 * keep in step, in exchange for nothing any caller needs.
 *
 * The one thing a table would have bought — a stable id — is provided by the
 * attachment's index within its message. That is message-scoped, so it cannot
 * be walked across tenants the way a global id could.
 */

/** What a provider told us about one piece of media. */
export interface MessageAttachment {
  /**
   * The provider's own media id, where it issues one.
   *
   * WhatsApp does; Messenger and Instagram do not. This is what makes a
   * WhatsApp attachment retrievable long after the webhook arrived.
   */
  providerMediaId: string | null;
  /**
   * A provider URL, where one was given.
   *
   * NEVER treated as permanent and NEVER sent to the browser. Meta's
   * attachment URLs are unguessable capability links that expire — handing one
   * to a client would both leak access and hand over something that stops
   * working. See MediaService for how these are used.
   */
  providerUrl: string | null;
  type: MessageType;
  /** Only when the provider stated it. Never inferred from a filename. */
  mimeType: string | null;
  /** Only when the provider stated it. WhatsApp documents carry one. */
  filename: string | null;
  /** Only when the provider stated it. None of the three currently do. */
  sizeBytes: number | null;
}

/**
 * The safe shape for a browser.
 *
 * Deliberately omits `providerMediaId` and `providerUrl`. Both are credentials
 * in effect: one is usable with our access token, the other is usable by
 * anybody holding the link. The client gets an index and asks the API for the
 * bytes.
 */
export interface MessageAttachmentView {
  index: number;
  type: MessageType;
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number | null;
  /** Whether the bytes can actually be fetched back. */
  retrievable: boolean;
}

export function toAttachmentViews(value: unknown): MessageAttachmentView[] {
  return parseAttachments(value).map((attachment, index) => ({
    index,
    type: attachment.type,
    mimeType: attachment.mimeType,
    filename: attachment.filename,
    sizeBytes: attachment.sizeBytes,
    // Something to fetch WITH. Without either reference the row is a record
    // that media arrived, and honest about not being able to show it.
    retrievable: attachment.providerMediaId !== null || attachment.providerUrl !== null,
  }));
}

/** Reads the stored JSON back, tolerating anything that is not what we wrote. */
export function parseAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;

    const type = record['type'];
    if (typeof type !== 'string') return [];

    return [
      {
        providerMediaId: asStringOrNull(record['providerMediaId']),
        providerUrl: asStringOrNull(record['providerUrl']),
        type: type as MessageType,
        mimeType: asStringOrNull(record['mimeType']),
        filename: asStringOrNull(record['filename']),
        sizeBytes: typeof record['sizeBytes'] === 'number' ? record['sizeBytes'] : null,
      },
    ];
  });
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Outbound validation
// ---------------------------------------------------------------------------

/**
 * What each channel will actually carry.
 *
 * Taken from Meta's documented limits per channel, not averaged into one
 * number. Sending a 90MB document to Instagram would be refused by the
 * provider after a long upload; refusing it here costs the user a second.
 *
 * Deliberately conservative on video and document: the request body passes
 * through application memory on its way to Meta, so the limit protects the API
 * as well as the user.
 */
export interface MediaRule {
  /** MIME types this channel accepts for this kind of media. */
  mimeTypes: readonly string[];
  maxBytes: number;
}

const IMAGE_MIMES = ['image/jpeg', 'image/png'] as const;
const VIDEO_MIMES = ['video/mp4', 'video/3gpp'] as const;
const AUDIO_MIMES = ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/ogg'] as const;
const DOCUMENT_MIMES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
] as const;

const MB = 1024 * 1024;

/**
 * Per-channel media policy.
 *
 * WhatsApp publishes limits per media kind. Messenger and Instagram publish one
 * attachment limit (25MB), and Instagram does not accept arbitrary documents
 * through the messaging API at all — so it is absent here rather than declared
 * and then refused by Meta.
 */
export const MEDIA_RULES: Record<string, Partial<Record<MessageType, MediaRule>>> = {
  WHATSAPP: {
    IMAGE: { mimeTypes: IMAGE_MIMES, maxBytes: 5 * MB },
    VIDEO: { mimeTypes: VIDEO_MIMES, maxBytes: 16 * MB },
    AUDIO: { mimeTypes: AUDIO_MIMES, maxBytes: 16 * MB },
    DOCUMENT: { mimeTypes: DOCUMENT_MIMES, maxBytes: 16 * MB },
  },
  FACEBOOK: {
    IMAGE: { mimeTypes: IMAGE_MIMES, maxBytes: 16 * MB },
    VIDEO: { mimeTypes: VIDEO_MIMES, maxBytes: 16 * MB },
    AUDIO: { mimeTypes: AUDIO_MIMES, maxBytes: 16 * MB },
    DOCUMENT: { mimeTypes: DOCUMENT_MIMES, maxBytes: 16 * MB },
  },
  INSTAGRAM: {
    IMAGE: { mimeTypes: IMAGE_MIMES, maxBytes: 8 * MB },
    VIDEO: { mimeTypes: VIDEO_MIMES, maxBytes: 16 * MB },
    AUDIO: { mimeTypes: AUDIO_MIMES, maxBytes: 16 * MB },
    // Instagram messaging does not accept documents. Saying so here is better
    // than letting Meta refuse it after the upload.
  },
};

/**
 * One uploaded file, as the multipart parser hands it over.
 *
 * Declared here rather than pulling in @types/multer for a global augmentation
 * we would use in exactly one place. Only the fields actually read are named,
 * which also makes it obvious that `mimetype` and `originalname` are inputs
 * from the browser and therefore not to be trusted.
 */
export interface UploadedMedia {
  buffer: Buffer;
  size: number;
  /** What the BROWSER claimed. Never used to decide what a file is. */
  mimetype: string;
  /** What the browser claimed. Used only as a display hint. */
  originalname: string;
}

/** The largest body any channel accepts. A cheap first reject. */
export const MAX_UPLOAD_BYTES = 16 * MB;

export type MediaValidation =
  | { ok: true; type: MessageType; rule: MediaRule }
  | { ok: false; message: string };

/**
 * Whether a channel will carry this file.
 *
 * Decided from the DETECTED mime type, never from the filename. A browser will
 * happily label an executable `image/png`, and an extension is a suggestion
 * from whoever named the file.
 */
export function validateMedia(
  channel: ChannelType,
  detectedMime: string | null,
  sizeBytes: number,
): MediaValidation {
  const rules = MEDIA_RULES[channel];
  if (!rules) {
    return { ok: false, message: 'Sending attachments is not available for this channel.' };
  }

  if (!detectedMime) {
    return {
      ok: false,
      message: 'That file type could not be identified, so it was not sent.',
    };
  }

  const match = (Object.entries(rules) as [MessageType, MediaRule][]).find(([, rule]) =>
    rule.mimeTypes.includes(detectedMime),
  );

  if (!match) {
    return {
      ok: false,
      message: 'That file type cannot be sent on this channel.',
    };
  }

  const [type, rule] = match;

  if (sizeBytes <= 0) {
    return { ok: false, message: 'That file is empty.' };
  }

  if (sizeBytes > rule.maxBytes) {
    const limitMb = Math.floor(rule.maxBytes / MB);
    return {
      ok: false,
      message: `${type.toLowerCase()} attachments on this channel are limited to ${limitMb}MB.`,
    };
  }

  return { ok: true, type, rule };
}

/**
 * The real type of a file, read from its leading bytes.
 *
 * Magic numbers rather than the browser's declared Content-Type, which is
 * attacker-controlled and the single most common way an upload filter is
 * bypassed. Only the formats this feature accepts are recognised; anything
 * else returns null and is refused, which is the correct direction to fail.
 */
export function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  const startsWith = (...bytes: number[]): boolean =>
    bytes.every((byte, index) => buffer[index] === byte);

  // Images.
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';

  // PDF: "%PDF".
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';

  // ISO base media (MP4 / 3GP): "ftyp" at offset 4.
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand.startsWith('3g')) return 'video/3gpp';
    // M4A is audio in the same container, and the brand is how they differ.
    if (brand.startsWith('M4A')) return 'audio/mp4';
    return 'video/mp4';
  }

  // Ogg: "OggS".
  if (startsWith(0x4f, 0x67, 0x67, 0x53)) return 'audio/ogg';
  // MP3: an ID3 tag, or a frame sync.
  if (startsWith(0x49, 0x44, 0x33)) return 'audio/mpeg';
  if (buffer[0] === 0xff && ((buffer[1] as number) & 0xe0) === 0xe0) return 'audio/mpeg';

  /*
   * OOXML and legacy Office are deliberately NOT sniffed further.
   *
   * A .docx is a ZIP, and telling a Word document from an arbitrary archive
   * means reading the archive directory. Recognising "this is a ZIP" and
   * calling it a Word document would let anything zipped through, so these are
   * simply not accepted by content detection.
   */
  return null;
}
