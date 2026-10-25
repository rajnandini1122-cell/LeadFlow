/**
 * What a lead attachment IS, decided from its bytes.
 *
 * The declared MIME type and the filename are both supplied by the client and
 * neither decides anything. Accepted: PDF, JPEG, PNG, WebP, Excel (.xlsx),
 * Word (.docx), and plain text / CSV. Everything is served back as a download
 * with `nosniff`, so even a mislabelled file cannot be rendered as a page.
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Per lead — enough for a long negotiation, small enough to bound the table. */
export const MAX_ATTACHMENTS_PER_LEAD = 50;

export const ATTACHMENT_KINDS = [
  'QUOTATION',
  'INVOICE',
  'PROFORMA',
  'PURCHASE_ORDER',
  'PRODUCT_PHOTO',
  'SAMPLE_PHOTO',
  'DOCUMENT',
  'OTHER',
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export interface DetectedType {
  mimeType: string;
  /** The extension a download is given, regardless of what was uploaded. */
  extension: string;
}

const OOXML = {
  xlsx: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' },
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' },
} as const;

export function detectAttachmentType(buffer: Buffer, declaredName = ''): DetectedType | null {
  if (buffer.length < 4) return null;
  const startsWith = (...bytes: number[]): boolean => bytes.every((byte, i) => buffer[i] === byte);

  if (startsWith(0x25, 0x50, 0x44, 0x46)) return { mimeType: 'application/pdf', extension: 'pdf' };
  if (startsWith(0xff, 0xd8, 0xff)) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mimeType: 'image/png', extension: 'png' };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }

  /*
   * Office Open XML is a ZIP. A ZIP alone proves nothing, so it is accepted
   * only when the archive contains the package's own parts: the content-types
   * manifest AND the workbook or document folder. An arbitrary archive has
   * neither and is refused.
   */
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) {
    const directory = buffer.toString('latin1');
    if (!directory.includes('[Content_Types].xml')) return null;
    if (directory.includes('xl/workbook.xml') || directory.includes('xl/')) return OOXML.xlsx;
    if (directory.includes('word/document.xml') || directory.includes('word/')) return OOXML.docx;
    return null;
  }

  /*
   * Text has no signature. Accepted only for a .csv/.txt name, and only if the
   * content really is text: valid UTF-8 and no NUL bytes.
   */
  const lower = declaredName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    if (buffer.includes(0)) return null;
    const text = buffer.toString('utf8');
    if (text.includes('�')) return null;
    return lower.endsWith('.csv')
      ? { mimeType: 'text/csv', extension: 'csv' }
      : { mimeType: 'text/plain', extension: 'txt' };
  }

  return null;
}

/** Safe to show and to send back: no path, no control characters, bounded. */
export function sanitizeFileName(name: string, extension: string): string {
  const base = [...(name.split(/[\\/]/).pop() ?? '')]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f && !'"<>|:*?'.includes(char);
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const stem = base.replace(/\.[^.]*$/, '') || 'attachment';
  return `${stem}.${extension}`;
}
