import { Injectable, Logger } from '@nestjs/common';
import {
  IMPORT_FIELD_LABELS,
  REQUIRED_IMPORT_FIELDS,
  type ImportDuplicate,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResult,
  type ImportableField,
  type LeadImportBatchSummary,
  type LeadImportMappingTemplateSummary,
} from '@leadflow/api-types';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { AuditRepository } from '../../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { ContactsRepository } from '../../contacts/contacts.repository';
import { LeadsRepository } from '../leads.repository';
import type {
  ImportLeadsDto,
  PreviewImportDto,
  SaveMappingTemplateDto,
} from '../dto/import-leads.dto';
import { LeadImportRepository } from './lead-import.repository';
import { suggestMapping, validateMapping } from './column-mapping';
import { CsvParseError, parseCsv, toCsv } from './csv';
import {
  parseAmount,
  parseDate,
  readRow,
  safeE164,
  validateRow,
  type RowValues,
} from './row-mapping';

/** Shown on screen. The error CSV always carries every affected row. */
const PREVIEW_ROWS = 20;

/** Beyond this the response would be larger than the file. */
const MAX_REPORTED_FAILURES = 500;

/**
 * CSV lead import.
 *
 * Two steps on purpose: preview, then import. An import that runs straight off
 * an uploaded file gives the user no chance to notice that "budget" landed in
 * "estimated value", and there is no undo for two thousand wrong leads.
 *
 * WHAT THIS RELEASE CHANGED, and why each was a defect rather than a missing
 * nicety:
 *
 *   * THE ADDRESS HAD NOWHERE TO GO. `leads` held only `city`, so an address
 *     column was dropped. Six columns now exist and are mapped.
 *   * PREVIEW AND IMPORT DISAGREED. Both called one `validate()` with different
 *     arguments, so a row missing a required mapping was counted valid by the
 *     preview and rejected by the import. They now share one call.
 *   * ERRORS WERE NOT ACTIONABLE. The preview showed twenty rows and the import
 *     reported a hundred failures with no way to see the rest. Both now return
 *     the complete set as downloadable CSV.
 *   * DUPLICATES WERE MOBILE-ONLY. A file where the same customer appeared once
 *     with a number and once with only an email imported them twice. Both keys
 *     are now checked, matching the database indexes.
 *   * AN IMPORT LEFT NO TRACE. Every created lead now carries a batch id.
 */
@Injectable()
export class LeadImportService {
  private readonly logger = new Logger(LeadImportService.name);

  constructor(
    private readonly leads: LeadsRepository,
    private readonly contacts: ContactsRepository,
    private readonly batches: LeadImportRepository,
    private readonly audit: AuditRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // Preview — reads only. Writes NOTHING.
  // ---------------------------------------------------------------------------

  async preview(dto: PreviewImportDto): Promise<ImportPreview> {
    const { headers, rows } = this.parse(dto.csv);
    const suggestion = suggestMapping(headers);

    /*
     * The caller's mapping wins when it sends one, and is CHECKED first.
     *
     * An unknown field name in the mapping used to be filtered out silently by
     * the row reader, so a client sending `"Address": "address"` — a plausible
     * guess at the field name — had its address column quietly ignored and saw
     * a successful import with no addresses in it.
     */
    const mapping = dto.mapping ? this.useCallerMapping(dto.mapping, headers) : suggestion.mapping;

    const country = await this.contacts.organizationCountry();
    const missingRequired = REQUIRED_IMPORT_FIELDS.filter(
      (field) => !Object.values(mapping).includes(field),
    );

    const seen = { mobiles: new Map<string, number>(), emails: new Map<string, number>() };
    const preview: ImportPreviewRow[] = [];
    const errorRows: (string | number)[][] = [];
    let valid = 0;
    let invalid = 0;
    let duplicates = 0;
    let review = 0;

    for (const [index, row] of rows.entries()) {
      const line = index + 2;
      const values = readRow(headers, row, mapping);
      const errors = validateRow(values, {
        country,
        defaultNextFollowUpAt: dto.defaultNextFollowUpAt,
        missingRequired,
        headerCount: headers.length,
        columnCount: row.length,
      });

      const duplicateOf = await this.findDuplicate(values, country, seen, line);

      if (errors.length > 0) invalid += 1;
      else if (duplicateOf) duplicates += 1;
      else valid += 1;

      // A row that will import but is worth a look: a fuzzy-mapped column
      // carries a value, or the file told us nothing we could place.
      if (errors.length === 0 && !duplicateOf && this.needsReview(values, suggestion)) {
        review += 1;
      }

      if (preview.length < PREVIEW_ROWS) {
        preview.push({ line, values, errors, duplicateOf });
      }

      if (errors.length > 0 || duplicateOf) {
        errorRows.push(this.errorRow(line, values, errors, duplicateOf));
      }
    }

    return {
      columns: suggestion.columns,
      mapping,
      unmapped: headers.filter((header) => !mapping[header]),
      needsConfirmation: suggestion.needsConfirmation,
      collisions: validateMapping(mapping, headers).collisions,
      missingRequired,
      duplicateHeaders: suggestion.duplicateHeaders,
      totalRows: rows.length,
      validRows: valid,
      invalidRows: invalid,
      duplicateRows: duplicates,
      reviewRows: review,
      rows: preview,
      errorCsv: errorRows.length > 0 ? toCsv(ERROR_CSV_HEADERS, errorRows) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  /**
   * Imports the file.
   *
   * ROWS ARE WRITTEN ONE AT A TIME, not in one transaction. A multi-thousand-row
   * transaction holds locks on a live tenant's leads table for the whole run,
   * and one bad row would roll back every good one. The caller gets a per-row
   * report instead, so a partial import is legible rather than mysterious — and
   * the batch id makes the partial result correctable.
   *
   * THERE IS DELIBERATELY NO "UPDATE EXISTING LEADS" MODE, and that is a
   * decision rather than an omission. A safe update needs per-field
   * authorisation that does not exist in this product yet, and the fields worth
   * updating are mostly the ones that must never be overwritten by a CSV cell:
   * the owner, the status, the commercial values, the account link and the audit
   * history. What would be left is the name and the address — too little to
   * justify a mode that looks like it does more. `CREATE_ANYWAY` covers the
   * legitimate case of knowingly importing a second lead for the same customer.
   */
  async import(dto: ImportLeadsDto, principal: TenantPrincipal): Promise<ImportResult> {
    const { headers, rows } = this.parse(dto.csv);
    const mapping = dto.mapping
      ? this.useCallerMapping(dto.mapping, headers)
      : suggestMapping(headers).mapping;

    const missingRequired = REQUIRED_IMPORT_FIELDS.filter(
      (field) => !Object.values(mapping).includes(field),
    );

    if (missingRequired.length > 0) {
      throw AppException.validation('The column mapping is incomplete.', {
        mapping: missingRequired.map(
          (field) => `no column is mapped to ${IMPORT_FIELD_LABELS[field].replace(' *', '')}`,
        ),
      });
    }

    /*
     * A collision is refused here rather than resolved.
     *
     * The preview reports it and the user is expected to fix it. Letting the
     * import proceed would mean one of two columns silently losing — exactly
     * the class of defect this release exists to remove.
     */
    const collisions = validateMapping(mapping, headers).collisions;
    if (collisions.length > 0) {
      throw AppException.validation('Two columns are mapped to the same field.', {
        mapping: collisions.map(
          (collision) => `${collision.headers.join(' and ')} both map to ${collision.field}`,
        ),
      });
    }

    if (dto.assignedToId) {
      // leads.assigned_to references the GLOBAL users table, so a foreign id
      // would otherwise be accepted for every row in the file.
      const isMember = await this.leads.isActiveMember(dto.assignedToId);
      if (!isMember) {
        throw AppException.validation('Cannot assign these leads.', {
          assignedToId: ['must be an active member of your organization'],
        });
      }
    }

    const country = await this.contacts.organizationCountry();

    /*
     * The batch row is written BEFORE the first lead.
     *
     * So that a run which crashes halfway still leaves its rows attributable:
     * a batch with `completed_at` null and twelve leads pointing at it is a
     * legible, correctable state. Creating it afterwards would leave an
     * interrupted import's leads with no provenance at all, which is the
     * situation this feature exists to prevent.
     */
    const batchId = await this.batches.start({
      fileName: dto.fileName ?? null,
      mapping,
      totalRows: rows.length,
      importedBy: principal.userId,
    });

    const result: ImportResult = {
      batchId,
      created: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      errorCsv: null,
    };
    const errorRows: (string | number)[][] = [];
    const seen = { mobiles: new Map<string, number>(), emails: new Map<string, number>() };

    for (const [index, row] of rows.entries()) {
      const line = index + 2;
      const values = readRow(headers, row, mapping);
      const errors = validateRow(values, {
        country,
        defaultNextFollowUpAt: dto.defaultNextFollowUpAt,
        // Empty, because the check above already refused an incomplete
        // mapping. Passing `missingRequired` here would double-report it.
        missingRequired: [],
        headerCount: headers.length,
        columnCount: row.length,
      });

      if (errors.length > 0) {
        result.failed += 1;
        this.record(result, errorRows, line, values, errors, null);
        continue;
      }

      const duplicateOf = await this.findDuplicate(values, country, seen, line);

      /*
       * A duplicate WITHIN THE FILE is always skipped, whatever the mode.
       *
       * `CREATE_ANYWAY` means "I know this customer is already in the CRM and I
       * want a second lead" — a deliberate choice about one existing record. It
       * does not mean "import the same row of this file twice", which is never
       * what anybody wants and is what a file with a repeated row would
       * otherwise produce.
       */
      if (duplicateOf && (duplicateOf.kind === 'file' || dto.duplicateMode !== 'CREATE_ANYWAY')) {
        result.skipped += 1;
        this.record(result, errorRows, line, values, [], duplicateOf);
        continue;
      }

      try {
        /*
         * `duplicateOf` is passed on, and it is load-bearing rather than
         * informational.
         *
         * A row that knowingly duplicates an existing lead has to be marked
         * `duplicateAcknowledgedAt`, because both partial unique indexes
         * exclude acknowledged rows — without the mark the insert is refused by
         * the database and CREATE_ANYWAY silently creates nothing. This was
         * caught by its own test: the mode reported "0 created" with a
         * constraint error in the log.
         *
         * Marked per ROW, not per run. Setting it on every row of a
         * CREATE_ANYWAY import would take the whole file out of the duplicate
         * index, weakening the guarantee for rows that were never duplicates.
         */
        await this.createOne(values, country, dto, principal, batchId, duplicateOf);
        result.created += 1;
      } catch (error) {
        result.failed += 1;
        const reason = isUniqueViolation(error)
          ? 'Another lead with this mobile or email was created while this file was importing.'
          : 'This row could not be saved.';

        // The row's own data is deliberately not logged: an import file is
        // customer PII and log aggregators are not the place for it.
        this.logger.warn({ line, batchId, err: error }, 'Import row failed');
        this.record(result, errorRows, line, values, [reason], null);
      }
    }

    await this.batches.complete(batchId, {
      created: result.created,
      skipped: result.skipped,
      failed: result.failed,
    });

    result.errorCsv = errorRows.length > 0 ? toCsv(ERROR_CSV_HEADERS, errorRows) : null;

    await this.audit.record({
      action: 'lead.imported',
      entityType: 'lead_import_batch',
      entityId: batchId,
      after: {
        totalRows: rows.length,
        created: result.created,
        skipped: result.skipped,
        failed: result.failed,
        duplicateMode: dto.duplicateMode ?? 'SKIP',
        assignedToId: dto.assignedToId ?? null,
        // The mapping, because "how did the address end up in the wrong
        // field" is the question an audit trail should be able to answer.
        mapping,
      },
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Batches
  // ---------------------------------------------------------------------------

  async listBatches(limit?: number): Promise<LeadImportBatchSummary[]> {
    return this.batches.list(limit ?? 25);
  }

  async findBatch(id: string): Promise<LeadImportBatchSummary> {
    const batch = await this.batches.findById(id);
    if (!batch) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Import batch not found.');

    return batch;
  }

  // ---------------------------------------------------------------------------
  // Mapping templates
  // ---------------------------------------------------------------------------

  async listTemplates(): Promise<LeadImportMappingTemplateSummary[]> {
    return this.batches.listTemplates();
  }

  async saveTemplate(
    dto: SaveMappingTemplateDto,
    principal: TenantPrincipal,
  ): Promise<LeadImportMappingTemplateSummary> {
    const unknown = Object.values(dto.mapping).filter(
      (field) => !Object.keys(IMPORT_FIELD_LABELS).includes(field),
    );

    if (unknown.length > 0) {
      throw AppException.validation('That mapping refers to fields that do not exist.', {
        mapping: unknown.map((field) => `unknown field: ${field}`),
      });
    }

    return this.batches.saveTemplate({
      name: dto.name,
      mapping: dto.mapping as Record<string, ImportableField>,
      createdBy: principal.userId,
    });
  }

  async deleteTemplate(id: string): Promise<void> {
    const deleted = await this.batches.deleteTemplate(id);
    if (!deleted) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Mapping template not found.');
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Duplicate detection, against both keys the database enforces.
   *
   * Checked in the same order and on the same terms as
   * `leads_org_mobile_uniq` and `leads_org_email_uniq`, so the preview's answer
   * and the database's answer agree. Mobile first because it is the stronger
   * identity.
   *
   * Within-file duplicates are tracked in the two maps, so a file containing
   * the same customer twice reports the SECOND occurrence against the first
   * rather than both against the database.
   */
  private async findDuplicate(
    values: RowValues,
    country: string,
    seen: { mobiles: Map<string, number>; emails: Map<string, number> },
    line: number,
  ): Promise<ImportDuplicate | null> {
    const mobile = safeE164(values.mobile, country);

    if (mobile) {
      const earlier = seen.mobiles.get(mobile);
      if (earlier !== undefined) return { kind: 'file', line: earlier, matchedOn: 'mobile' };
      seen.mobiles.set(mobile, line);

      const existing = await this.leads.findActiveByMobile(mobile);
      if (existing) {
        return { kind: 'existing', leadNumber: existing.leadNumber, matchedOn: 'mobile' };
      }
    }

    // Normalised to lower case, matching `lower(email)` in the index — without
    // it, `Dana@x.test` and `dana@x.test` read as two customers here and as one
    // to the database, and the import would fail on a row the preview passed.
    const email = values.email?.toLowerCase();

    if (email) {
      const earlier = seen.emails.get(email);
      if (earlier !== undefined) return { kind: 'file', line: earlier, matchedOn: 'email' };
      seen.emails.set(email, line);

      const existing = await this.leads.findActiveByEmail(email);
      if (existing) {
        return { kind: 'existing', leadNumber: existing.leadNumber, matchedOn: 'email' };
      }
    }

    return null;
  }

  private needsReview(
    values: RowValues,
    suggestion: ReturnType<typeof suggestMapping>,
  ): boolean {
    return suggestion.needsConfirmation.some((column) => {
      const field = column.field;
      return field !== null && values[field] !== undefined;
    });
  }

  private async createOne(
    values: RowValues,
    country: string,
    dto: ImportLeadsDto,
    principal: TenantPrincipal,
    batchId: string,
    duplicateOf: ImportDuplicate | null,
  ): Promise<void> {
    const mobile = safeE164(values.mobile, country);

    const contact = await this.contacts.findOrCreateByMobile({
      mobile,
      firstName: values.firstName,
      lastName: values.lastName,
      email: values.email,
      companyName: values.companyName,
      city: values.city,
      actorId: principal.userId,
    });

    const followUp = parseDate(values.nextFollowUpAt ?? dto.defaultNextFollowUpAt);
    const amount = values.estimatedValue ? parseAmount(values.estimatedValue) : null;

    await this.leads.createWithActivity({
      firstName: values.firstName as string,
      lastName: values.lastName,
      mobile,
      // Stored lower case, matching the manual create path and the index.
      email: values.email?.toLowerCase(),
      companyName: values.companyName,
      // --- the address, which previously had nowhere to go ------------------
      addressLine1: values.addressLine1,
      addressLine2: values.addressLine2,
      city: values.city,
      state: values.state,
      postalCode: values.postalCode,
      // Upper-cased, so a file writing "in" and one writing "IN" are one
      // country rather than two.
      country: values.country?.toUpperCase(),
      // Recorded even when the file did not say, so imported leads stay
      // distinguishable from ones a salesperson actually spoke to.
      source: values.source ?? 'CSV import',
      productInterest: values.productInterest,
      ...(amount !== null ? { estimatedValue: amount } : {}),
      status: 'NEW',
      priority: 'MEDIUM',
      assignedToId: dto.assignedToId,
      nextFollowUpAt: followUp,
      contactId: contact.id,
      importBatchId: batchId,
      /*
       * Only for a row that is KNOWINGLY a duplicate.
       *
       * Both partial unique indexes exclude acknowledged rows, so a
       * CREATE_ANYWAY row needs this to be insertable at all. A row that
       * matched nothing stays inside the index, where it belongs.
       */
      duplicateAcknowledged: duplicateOf?.kind === 'existing',
      actorId: principal.userId,
    });
  }

  private record(
    result: ImportResult,
    errorRows: (string | number)[][],
    line: number,
    values: RowValues,
    errors: string[],
    duplicateOf: ImportDuplicate | null,
  ): void {
    if (result.failures.length < MAX_REPORTED_FAILURES && errors.length > 0) {
      result.failures.push({ line, reason: errors.join(' ') });
    }

    errorRows.push(this.errorRow(line, values, errors, duplicateOf));
  }

  /**
   * One row of the downloadable error file.
   *
   * Carries the original values back so the user can fix the file from this
   * download alone rather than cross-referencing line numbers by hand — which
   * is what made the old hundred-failure list unusable on a large import.
   */
  private errorRow(
    line: number,
    values: RowValues,
    errors: string[],
    duplicateOf: ImportDuplicate | null,
  ): (string | number)[] {
    return [
      line,
      errors.length > 0 ? 'Not imported' : 'Skipped as duplicate',
      errors.join(' ') || describeDuplicate(duplicateOf),
      values.firstName ?? '',
      values.lastName ?? '',
      values.companyName ?? '',
      values.mobile ?? '',
      values.email ?? '',
      values.addressLine1 ?? '',
      values.addressLine2 ?? '',
      values.city ?? '',
      values.state ?? '',
      values.postalCode ?? '',
      values.country ?? '',
      values.source ?? '',
      values.productInterest ?? '',
      values.estimatedValue ?? '',
      values.nextFollowUpAt ?? '',
    ];
  }

  /**
   * The caller's mapping, refused rather than silently filtered.
   *
   * A field name that is not importable, or a header that is not in the file,
   * used to be dropped by the row reader with no comment — so a client sending
   * one wrong field name saw a successful import missing that column's data.
   */
  private useCallerMapping(
    mapping: Record<string, string>,
    headers: string[],
  ): Record<string, ImportableField> {
    const { unknownFields, unknownHeaders } = validateMapping(mapping, headers);

    if (unknownFields.length > 0 || unknownHeaders.length > 0) {
      throw AppException.validation('That column mapping does not match this file.', {
        mapping: [
          ...unknownFields.map((field) => `"${field}" is not a lead field`),
          ...unknownHeaders.map((header) => `"${header}" is not a column in this file`),
        ],
      });
    }

    return mapping as Record<string, ImportableField>;
  }

  private parse(csv: string) {
    try {
      return parseCsv(csv);
    } catch (error) {
      if (error instanceof CsvParseError) {
        throw AppException.validation('Could not read the file.', { csv: [error.message] });
      }
      throw error;
    }
  }
}

const ERROR_CSV_HEADERS = [
  'Row',
  'Outcome',
  'Reason',
  'First name',
  'Last name',
  'Company',
  'Mobile',
  'Email',
  'Address line 1',
  'Address line 2',
  'City',
  'State',
  'Postal code',
  'Country',
  'Source',
  'Product interest',
  'Estimated value',
  'Follow-up date',
];

function describeDuplicate(duplicateOf: ImportDuplicate | null): string {
  if (!duplicateOf) return '';

  return duplicateOf.kind === 'existing'
    ? `The same ${duplicateOf.matchedOn} is already on active lead ${duplicateOf.leadNumber}.`
    : `The same ${duplicateOf.matchedOn} appears on row ${duplicateOf.line} of this file.`;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === 'P2002';
}
