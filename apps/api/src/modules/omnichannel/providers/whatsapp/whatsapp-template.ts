/**
 * Reading and using WhatsApp message templates.
 *
 * LeadFlow does not create templates and cannot approve them. Meta is the only
 * authority on whether a template may be sent, so everything here is about
 * reading what Meta reported and being honest about which of those we can
 * actually handle.
 *
 * Pure, so the parsing and the parameter rules can be tested exhaustively
 * against real template shapes without a database or a provider.
 *
 * The supported subset is deliberately small: a TEXT header, a BODY, and text
 * parameters. Anything else is reported as unsupported WITH a reason rather
 * than hidden or, worse, sent as a guess — a template rendered wrongly reaches
 * a customer with a placeholder in it, and there is no taking that back.
 */

export type TemplateStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED';

/** One placeholder-bearing part of a template. */
export interface TemplateSection {
  /** The literal text Meta holds, placeholders included. */
  text: string;
  /** How many `{{n}}` placeholders it contains. */
  parameterCount: number;
}

export interface ParsedTemplate {
  name: string;
  language: string;
  category: string | null;
  status: TemplateStatus;
  providerTemplateId: string | null;

  /** Present only for a TEXT header. A media header makes it unsupported. */
  header: TemplateSection | null;
  /** Every sendable template has one. */
  body: TemplateSection | null;
  /** Fixed text, no parameters. Shown in the preview only. */
  footer: string | null;
  /** Labels only. Buttons are informational in this phase. */
  buttons: string[];

  /** Whether LeadFlow can send it. */
  supported: boolean;
  /** Why not. Shown to the user verbatim. */
  unsupportedReason: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const STATUSES: TemplateStatus[] = ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED'];

/**
 * Counts the distinct `{{n}}` placeholders in a template string.
 *
 * Distinct rather than total: Meta numbers its placeholders, and a body that
 * uses `{{1}}` twice still takes one parameter. Counting occurrences would ask
 * the user for a value that has nowhere to go and then fail at the provider.
 */
export function countPlaceholders(text: string): number {
  const seen = new Set<number>();

  for (const match of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index > 0) seen.add(index);
  }

  return seen.size;
}

/**
 * Turns one template, as Meta returned it, into what LeadFlow can say about it.
 *
 * Never throws. A template we cannot read is reported unsupported rather than
 * failing the whole sync — one odd template must not hide every good one.
 */
export function parseTemplate(raw: unknown): ParsedTemplate | null {
  const template = asRecord(raw);
  if (!template) return null;

  const name = asString(template['name']);
  const language = asString(template['language']);
  if (!name || !language) return null;

  const rawStatus = asString(template['status'])?.toUpperCase();
  const status = STATUSES.includes(rawStatus as TemplateStatus)
    ? (rawStatus as TemplateStatus)
    : 'DISABLED';

  let header: TemplateSection | null = null;
  let body: TemplateSection | null = null;
  let footer: string | null = null;
  const buttons: string[] = [];
  let unsupportedReason: string | null = null;

  for (const rawComponent of asArray(template['components'])) {
    const component = asRecord(rawComponent);
    if (!component) continue;

    const type = asString(component['type'])?.toUpperCase();
    const text = asString(component['text']) ?? '';

    switch (type) {
      case 'HEADER': {
        const format = asString(component['format'])?.toUpperCase() ?? 'TEXT';

        if (format !== 'TEXT') {
          /*
           * A media header needs a file uploaded to Meta before sending.
           * Phase J's upload path could carry one, but the template flow has
           * no place to choose that file, and sending a template whose header
           * is missing produces a broken message at the customer's end.
           */
          unsupportedReason = `This template needs a ${format.toLowerCase()} header, which LeadFlow cannot send yet.`;
          break;
        }

        header = { text, parameterCount: countPlaceholders(text) };
        break;
      }

      case 'BODY':
        body = { text, parameterCount: countPlaceholders(text) };
        break;

      case 'FOOTER':
        footer = text || null;
        break;

      case 'BUTTONS':
        for (const rawButton of asArray(component['buttons'])) {
          const label = asString(asRecord(rawButton)?.['text']);
          if (label) buttons.push(label);
        }
        break;

      default:
        // An unknown component type. Not fatal by itself — Meta adds them —
        // but not something to silently drop from a message either.
        unsupportedReason ??= 'This template uses a feature LeadFlow does not support yet.';
    }
  }

  if (!body) {
    unsupportedReason ??= 'This template has no message body.';
  }

  return {
    name,
    language,
    category: asString(template['category']) ?? null,
    status,
    providerTemplateId: asString(template['id']) ?? null,
    header,
    body,
    footer,
    buttons,
    supported: unsupportedReason === null,
    unsupportedReason,
  };
}

/** Every readable template in a Meta list response. */
export function parseTemplateList(payload: unknown): ParsedTemplate[] {
  const root = asRecord(payload);
  if (!root) return [];

  return asArray(root['data'])
    .map(parseTemplate)
    .filter((template): template is ParsedTemplate => template !== null);
}

// ---------------------------------------------------------------------------
// Reading a cached row back
// ---------------------------------------------------------------------------

/** The sections as stored on the cached row. */
export type StoredComponents = Pick<
  ParsedTemplate,
  'header' | 'body' | 'footer' | 'buttons'
>;

/**
 * Reads the stored component blob back into sections.
 *
 * Defensive on purpose. The column is JSON, so a row written by an older build
 * — or by a Meta response whose shape has since moved — must degrade into "no
 * sections" rather than throw halfway through a send. A template that reads
 * back as empty fails validation, which is the safe direction: nothing reaches
 * a customer with placeholders still in it.
 */
export function readStoredComponents(value: unknown): StoredComponents {
  const record = asRecord(value);
  if (!record) return { header: null, body: null, footer: null, buttons: [] };

  const section = (raw: unknown): TemplateSection | null => {
    const inner = asRecord(raw);
    const text = inner ? asString(inner['text']) : undefined;
    if (text === undefined) return null;

    /*
     * The count is RE-DERIVED from the text rather than trusted from the row.
     *
     * The two are written together and should agree, but the count is what
     * decides how many values a send must carry, and the text is what the
     * customer actually receives. If they ever disagree, the text is the one
     * that is true.
     */
    return { text, parameterCount: countPlaceholders(text) };
  };

  return {
    header: section(record['header']),
    body: section(record['body']),
    footer: asString(record['footer']) ?? null,
    buttons: asArray(record['buttons']).filter(
      (button): button is string => typeof button === 'string',
    ),
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface TemplateParameters {
  /** Values for the header's placeholders, in order. */
  header: string[];
  /** Values for the body's placeholders, in order. */
  body: string[];
}

export type TemplateValidation =
  | { ok: true; components: unknown[] }
  | { ok: false; message: string };

/** Meta's limit for a single template parameter. */
export const MAX_PARAMETER_LENGTH = 1024;

/**
 * Checks the submitted values against what the template actually needs, and
 * builds the payload Meta expects.
 *
 * Validated against the STORED definition, never against anything the browser
 * claimed. A client that says a template needs no parameters does not get to
 * send one with placeholders left in it.
 */
export function buildTemplateComponents(
  template: Pick<ParsedTemplate, 'header' | 'body' | 'supported' | 'unsupportedReason'>,
  parameters: TemplateParameters,
): TemplateValidation {
  if (!template.supported) {
    return {
      ok: false,
      message: template.unsupportedReason ?? 'This template cannot be sent from LeadFlow.',
    };
  }

  if (!template.body) {
    return { ok: false, message: 'This template has no message body.' };
  }

  const expectedHeader = template.header?.parameterCount ?? 0;
  const expectedBody = template.body.parameterCount;

  if (parameters.header.length !== expectedHeader) {
    return {
      ok: false,
      message: `This template needs ${expectedHeader} header value${expectedHeader === 1 ? '' : 's'}.`,
    };
  }

  if (parameters.body.length !== expectedBody) {
    return {
      ok: false,
      message: `This template needs ${expectedBody} value${expectedBody === 1 ? '' : 's'}.`,
    };
  }

  const all = [...parameters.header, ...parameters.body];

  if (all.some((value) => value.trim().length === 0)) {
    // An empty placeholder reaches the customer as a gap in a sentence.
    return { ok: false, message: 'Every template value must be filled in.' };
  }

  if (all.some((value) => value.length > MAX_PARAMETER_LENGTH)) {
    return {
      ok: false,
      message: `Template values are limited to ${MAX_PARAMETER_LENGTH} characters.`,
    };
  }

  if (all.some((value) => /[\n\r\t]/.test(value))) {
    // Meta rejects these outright, and finding out at the provider costs the
    // user a round trip to learn something we already knew.
    return {
      ok: false,
      message: 'Template values cannot contain line breaks or tabs.',
    };
  }

  const components: unknown[] = [];

  if (expectedHeader > 0) {
    components.push({
      type: 'header',
      parameters: parameters.header.map((text) => ({ type: 'text', text })),
    });
  }

  if (expectedBody > 0) {
    components.push({
      type: 'body',
      parameters: parameters.body.map((text) => ({ type: 'text', text })),
    });
  }

  return { ok: true, components };
}

/**
 * The template text with its values substituted, for the conversation timeline.
 *
 * What is stored as the message content, so the history shows what the customer
 * actually received rather than a template name they never saw. Any placeholder
 * without a value is left as-is — validation prevents that reaching a customer,
 * and inventing a blank would misrepresent what was sent.
 */
export function renderTemplateText(
  template: Pick<ParsedTemplate, 'header' | 'body' | 'footer'>,
  parameters: TemplateParameters,
): string {
  const substitute = (text: string, values: string[]): string =>
    text.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index: string) => {
      const value = values[Number(index) - 1];
      return value ?? match;
    });

  return [
    template.header ? substitute(template.header.text, parameters.header) : null,
    template.body ? substitute(template.body.text, parameters.body) : null,
    template.footer,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}
