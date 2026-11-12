import sanitizeHtml from 'sanitize-html';
import { EMAIL_MERGE_FIELDS, type EmailMergeField } from '@leadflow/api-types';

/**
 * What a campaign email may contain, and how it is filled in.
 *
 * Authors are tenant users; readers are their customers. So the HTML is
 * treated as untrusted on the way in (an allow-list, enforced here on the
 * server, whatever the editor did) and merge values — names and companies typed
 * by anyone — are escaped on the way out.
 */

const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'div',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
];

const SAFE_STYLE = {
  color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i],
  'background-color': [/^#[0-9a-f]{3,8}$/i],
  'text-align': [/^(left|right|center|justify)$/],
  'font-weight': [/^(normal|bold|[1-9]00)$/],
  'font-size': [/^\d{1,2}(px|pt|em|%)$/],
  'font-style': [/^(normal|italic)$/],
  'text-decoration': [/^(none|underline|line-through)$/],
  padding: [/^(\d{1,3}(px|em)?\s*){1,4}$/],
  margin: [/^(\d{1,3}(px|em)?\s*){1,4}$/],
  width: [/^\d{1,4}(px|%)$/],
  border: [/^\d(px)? solid #[0-9a-f]{3,8}$/i],
};

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target'],
    img: ['src', 'alt', 'width', 'height'],
    td: ['colspan', 'rowspan', 'align'],
    th: ['colspan', 'rowspan', 'align'],
    table: ['width', 'cellpadding', 'cellspacing', 'border'],
    '*': ['style'],
  },
  allowedStyles: { '*': SAFE_STYLE },
  // Links: web and mail only. Images: https only — no data: URIs (size,
  // smuggling) and no http (mixed content, tracking over cleartext).
  allowedSchemes: ['https', 'http', 'mailto'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // An image must come from an absolute https URL; anything else (relative,
  // data:, http:) is meaningless or unsafe in an email and is dropped whole.
  exclusiveFilter: (frame) =>
    frame.tag === 'img' && !/^https:\/\//i.test(frame.attribs['src'] ?? ''),
  // Script and style bodies are dropped with their tags, not left as text.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head'],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' },
    }),
  },
};

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE).trim();
}

const MERGE_FIELD = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Merge field names a template uses that LeadFlow does not offer. */
export function unknownMergeFields(...parts: string[]): string[] {
  const known = new Set<string>(EMAIL_MERGE_FIELDS);
  const unknown = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(MERGE_FIELD)) {
      const name = match[1]!.toLowerCase();
      if (!known.has(name)) unknown.add(match[1]!);
    }
  }
  return [...unknown];
}

export type MergeValues = Partial<Record<EmailMergeField, string | null>>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Replaces merge fields; missing values become empty. `html` escapes values. */
export function applyMergeFields(
  template: string,
  values: MergeValues,
  mode: 'html' | 'text',
): string {
  return template.replace(MERGE_FIELD, (_whole, rawName: string) => {
    const value = values[rawName.toLowerCase() as EmailMergeField] ?? '';
    // Header injection guard for the subject (text mode): no line breaks survive.
    const clean = value.replace(/[\r\n]+/g, ' ').trim();
    return mode === 'html' ? escapeHtml(clean) : clean;
  });
}

/** A plain-text rendering of sanitized HTML, for the text/plain part. */
export function htmlToPlainText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-4]|li|tr|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, href: string, label: string) =>
      label.trim() && label.trim() !== href ? `${label} (${href})` : href,
    );
  const text = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface FooterInput {
  organizationName: string;
  senderAddress: string;
  purpose: 'PROMOTIONAL' | 'TRANSACTIONAL';
  unsubscribeUrl: string | null;
}

/**
 * The footer LeadFlow adds to every campaign message. Promotional mail always
 * carries the unsubscribe link; it is not part of the editable body, so it
 * cannot be deleted by editing the template.
 */
export function campaignFooter(input: FooterInput): { html: string; text: string } {
  const org = escapeHtml(input.organizationName);
  const why =
    input.purpose === 'PROMOTIONAL'
      ? `You are receiving this email from ${org} because you are in contact with us.`
      : `This is a service message from ${org}.`;
  const unsubscribeHtml = input.unsubscribeUrl
    ? ` <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a> from ${org} marketing emails.`
    : '';
  const html =
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px">` +
    `<p style="font-size:12px;color:#6b7280;margin:0">${why}${unsubscribeHtml}</p>`;
  const text =
    `\n\n--\n${input.purpose === 'PROMOTIONAL' ? `You are receiving this email from ${input.organizationName} because you are in contact with us.` : `This is a service message from ${input.organizationName}.`}` +
    (input.unsubscribeUrl ? `\nUnsubscribe: ${input.unsubscribeUrl}` : '');
  return { html, text };
}

export interface RenderInput {
  subject: string;
  html: string;
  text: string;
  values: MergeValues;
  footer: FooterInput;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The message one recipient receives. The body is re-sanitized after merging. */
export function renderEmail(input: RenderInput): RenderedEmail {
  const footer = campaignFooter(input.footer);
  const body = sanitizeEmailHtml(applyMergeFields(input.html, input.values, 'html'));
  const text = applyMergeFields(
    input.text.trim() ? input.text : htmlToPlainText(input.html),
    input.values,
    'text',
  );
  return {
    subject: applyMergeFields(input.subject, input.values, 'text').slice(0, 250),
    html:
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>` +
      `<body style="margin:0;padding:24px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827">` +
      `<div style="max-width:640px;margin:0 auto">${body}${footer.html}</div></body></html>`,
    text: `${text}${footer.text}`,
  };
}

/** A normalized address, or null if it is not one LeadFlow will send to. */
export function normalizeEmailAddress(input: string | null | undefined): string | null {
  if (!input) return null;
  const email = input.trim().toLowerCase();
  if (email.length > 254 || email.length < 6) return null;
  // Deliberately strict: one @, a dotted domain, no spaces, quotes, brackets,
  // commas or semicolons — nothing an address parser could split into two.
  if (
    !/^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      email,
    )
  )
    return null;
  if (email.includes('..') || email.startsWith('.') || email.split('@')[0]!.endsWith('.'))
    return null;
  return email;
}
