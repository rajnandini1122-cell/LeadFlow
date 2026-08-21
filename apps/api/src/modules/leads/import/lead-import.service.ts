import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../../common/errors/app.exception';
import { AuditRepository } from '../../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { PhoneParseError, toE164 } from '../../../common/utils/phone';
import { ContactsRepository } from '../../contacts/contacts.repository';
import { LeadsRepository } from '../leads.repository';
import type { ImportLeadsDto, PreviewImportDto } from '../dto/import-leads.dto';
import {
  CsvParseError,
  IMPORTABLE_FIELDS,
  REQUIRED_FIELDS,
  parseCsv,
  suggestMapping,
  type ImportableField,
} from './csv';

export interface PreviewRow {
  /** 1-based, counting the header as row 1, so it matches the spreadsheet. */
  line: number;
  values: Partial<Record<ImportableField, string>>;
  errors: string[];
  /** Matches an existing active lead, or an earlier row in this same file. */
  duplicateOf: { leadNumber: string; kind: 'existing' } | { line: number; kind: 'file' } | null;
}

export interface ImportPreview {
  headers: string[];
  mapping: Record<string, ImportableField>;
  unmapped: string[];
  missingRequired: ImportableField[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  /** A sample, not the whole file — the point is to eyeball the mapping. */
  rows: PreviewRow[];
}

export interface ImportResult {
  created: number;
  skipped: number;
  failed: number;
  failures: { line: number; reason: string }[];
}

const PREVIEW_ROWS = 20;

/**
 * CSV lead import.
 *
 * Two steps on purpose: preview, then import. An import that runs straight off
 * an uploaded file gives the user no chance to notice that "budget" landed in
 * "estimated value", and there is no undo for two thousand wrong leads.
 */
@Injectable()
export class LeadImportService {
  private readonly logger = new Logger(LeadImportService.name);

  constructor(
    private readonly leads: LeadsRepository,
    private readonly contacts: ContactsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async preview(dto: PreviewImportDto): Promise<ImportPreview> {
    const { headers, rows } = this.parse(dto.csv);
    const mapping = (dto.mapping as Record<string, ImportableField>) ?? suggestMapping(headers);
    const country = await this.contacts.organizationCountry();

    const mapped = new Set(Object.values(mapping));
    const missingRequired = REQUIRED_FIELDS.filter((field) => !mapped.has(field));

    const seenMobiles = new Map<string, number>();
    const preview: PreviewRow[] = [];
    let valid = 0;
    let invalid = 0;
    let duplicates = 0;

    for (const [index, row] of rows.entries()) {
      const line = index + 2;
      const values = readRow(headers, row, mapping);
      const errors = validate(values, missingRequired, country, dto.defaultNextFollowUpAt);

      let duplicateOf: PreviewRow['duplicateOf'] = null;
      const mobile = safeE164(values.mobile, country);

      if (mobile) {
        const earlier = seenMobiles.get(mobile);
        if (earlier !== undefined) {
          duplicateOf = { line: earlier, kind: 'file' };
        } else {
          seenMobiles.set(mobile, line);
          const existing = await this.leads.findActiveByMobile(mobile);
          if (existing) duplicateOf = { leadNumber: existing.leadNumber, kind: 'existing' };
        }
      }

      if (errors.length > 0) invalid += 1;
      else if (duplicateOf) duplicates += 1;
      else valid += 1;

      if (preview.length < PREVIEW_ROWS) {
        preview.push({ line, values, errors, duplicateOf });
      }
    }

    return {
      headers,
      mapping,
      unmapped: headers.filter((header) => !mapping[header]),
      missingRequired,
      totalRows: rows.length,
      validRows: valid,
      invalidRows: invalid,
      duplicateRows: duplicates,
      rows: preview,
    };
  }

  /**
   * Imports the file.
   *
   * Rows are written one at a time rather than in a single transaction: a
   * multi-thousand-row transaction holds locks on a live tenant's leads table
   * for the whole run, and one bad row would roll back every good one. The
   * caller gets a per-row report instead, so a partial import is legible rather
   * than mysterious.
   */
  async import(dto: ImportLeadsDto, principal: TenantPrincipal): Promise<ImportResult> {
    const { headers, rows } = this.parse(dto.csv);
    const mapping = (dto.mapping as Record<string, ImportableField>) ?? suggestMapping(headers);
    const country = await this.contacts.organizationCountry();

    const mapped = new Set(Object.values(mapping));
    const missingRequired = REQUIRED_FIELDS.filter((field) => !mapped.has(field));
    if (missingRequired.length > 0) {
      throw AppException.validation('The column mapping is incomplete.', {
        mapping: [`missing required field(s): ${missingRequired.join(', ')}`],
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

    const result: ImportResult = { created: 0, skipped: 0, failed: 0, failures: [] };
    const seenMobiles = new Set<string>();

    for (const [index, row] of rows.entries()) {
      const line = index + 2;
      const values = readRow(headers, row, mapping);
      const errors = validate(values, [], country, dto.defaultNextFollowUpAt);

      if (errors.length > 0) {
        result.failed += 1;
        if (result.failures.length < 100) {
          result.failures.push({ line, reason: errors.join('; ') });
        }
        continue;
      }

      const mobile = toE164(values.mobile as string, country);

      if (seenMobiles.has(mobile)) {
        result.skipped += 1;
        continue;
      }
      seenMobiles.add(mobile);

      if (dto.skipDuplicates !== false) {
        const existing = await this.leads.findActiveByMobile(mobile);
        if (existing) {
          result.skipped += 1;
          continue;
        }
      }

      try {
        await this.createOne(values, mobile, dto, principal);
        result.created += 1;
      } catch (error) {
        result.failed += 1;
        const reason =
          (error as { code?: string }).code === 'P2002'
            ? 'A lead with this mobile already exists.'
            : 'Could not be saved.';

        // The row's own data is deliberately not logged: an import file is
        // customer PII and log aggregators are not the place for it.
        this.logger.warn({ line, err: error }, 'Import row failed');
        if (result.failures.length < 100) result.failures.push({ line, reason });
      }
    }

    await this.audit.record({
      action: 'lead.imported',
      entityType: 'lead',
      after: {
        totalRows: rows.length,
        created: result.created,
        skipped: result.skipped,
        failed: result.failed,
        assignedToId: dto.assignedToId ?? null,
      },
    });

    return result;
  }

  private async createOne(
    values: Partial<Record<ImportableField, string>>,
    mobile: string,
    dto: ImportLeadsDto,
    principal: TenantPrincipal,
  ): Promise<void> {
    const contact = await this.contacts.findOrCreateByMobile({
      mobile,
      firstName: values.firstName,
      lastName: values.lastName,
      email: values.email,
      companyName: values.companyName,
      city: values.city,
      actorId: principal.userId,
    });

    const nextFollowUpAt = new Date(
      (values.nextFollowUpAt as string | undefined) ?? dto.defaultNextFollowUpAt,
    );

    await this.leads.createWithActivity({
      leadNumber: await this.leads.nextLeadNumber(),
      firstName: values.firstName as string,
      lastName: values.lastName,
      mobile,
      email: values.email,
      companyName: values.companyName,
      city: values.city,
      // Recorded even when the file did not say, so imported leads stay
      // distinguishable from ones a salesperson actually spoke to.
      source: values.source ?? 'CSV import',
      productInterest: values.productInterest,
      estimatedValue: values.estimatedValue ? Number(values.estimatedValue) : undefined,
      status: 'NEW',
      priority: 'MEDIUM',
      assignedToId: dto.assignedToId,
      nextFollowUpAt,
      contactId: contact.id,
      actorId: principal.userId,
    });
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

function readRow(
  headers: string[],
  row: string[],
  mapping: Record<string, ImportableField>,
): Partial<Record<ImportableField, string>> {
  const values: Partial<Record<ImportableField, string>> = {};

  for (const [index, header] of headers.entries()) {
    const field = mapping[header];
    if (!field || !IMPORTABLE_FIELDS.includes(field)) continue;

    const raw = (row[index] ?? '').trim();
    if (raw !== '') values[field] = raw;
  }

  return values;
}

function validate(
  values: Partial<Record<ImportableField, string>>,
  missingRequired: ImportableField[],
  country: string,
  defaultNextFollowUpAt: string | undefined,
): string[] {
  const errors: string[] = [];

  for (const field of missingRequired) {
    errors.push(`no column mapped to ${field}`);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!missingRequired.includes(field) && !values[field]) {
      errors.push(`${field} is empty`);
    }
  }

  if (values.mobile && !safeE164(values.mobile, country)) {
    errors.push('mobile is not a valid phone number');
  }

  if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
    errors.push('email is not valid');
  }

  if (values.estimatedValue && Number.isNaN(Number(values.estimatedValue))) {
    errors.push('estimated value is not a number');
  }

  // "No lead left behind" is a database CHECK constraint: an active lead with
  // no next action cannot be stored at all. Catching it here turns a 500 from
  // Postgres into a row the user can fix.
  const followUp = values.nextFollowUpAt ?? defaultNextFollowUpAt;
  if (!followUp) {
    errors.push('no follow-up date, and no default was given');
  } else if (Number.isNaN(new Date(followUp).getTime())) {
    errors.push('follow-up date is not a valid date');
  }

  return errors;
}

function safeE164(input: string | undefined, country: string): string | null {
  if (!input) return null;
  try {
    return toE164(input, country);
  } catch (error) {
    if (error instanceof PhoneParseError) return null;
    throw error;
  }
}
