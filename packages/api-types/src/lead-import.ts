/**
 * The CSV import contract, in ONE place.
 *
 * WHY THIS FILE EXISTS. The importable field list, its labels and its aliases
 * used to be declared twice — once in `apps/api/.../import/csv.ts` and again,
 * by hand, in `apps/web/.../import-leads-page.tsx`. Adding a field meant two
 * edits in two workspaces, and the two lists had already drifted: the API knew
 * ten fields, the UI knew ten different-order fields, and neither knew the
 * address existed.
 *
 * That duplication is a direct cause of the mapping defects this release fixes.
 * A field declared here is offered by the API, labelled by the UI and
 * type-checked in both, or it does not exist.
 */

// -----------------------------------------------------------------------------
// The fields
// -----------------------------------------------------------------------------

/**
 * Every lead field a CSV column may be mapped onto.
 *
 * Order is the display order in the mapping UI: who they are, how to reach
 * them, where they are, what they want, and what happens next. Grouped because
 * a flat alphabetical list of sixteen fields is how somebody picks `state` when
 * they meant `status`.
 */
export const IMPORTABLE_FIELDS = [
  // who
  'firstName',
  'lastName',
  'companyName',
  // how to reach them
  'mobile',
  'email',
  // where — all six, which is the gap this release closes
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country',
  // what they want
  'source',
  'productInterest',
  'estimatedValue',
  // what happens next
  'nextFollowUpAt',
] as const;

export type ImportableField = (typeof IMPORTABLE_FIELDS)[number];

/**
 * Without these a row cannot become a lead.
 *
 * Deliberately short. `firstName` because a lead nobody can name is not
 * actionable, and `mobile` because it is the primary duplicate key — an import
 * with no number cannot be de-duplicated against anything, which is how a file
 * imported twice doubles a pipeline.
 */
export const REQUIRED_IMPORT_FIELDS: readonly ImportableField[] = ['firstName', 'mobile'];

/** What each field is called on screen. The `*` marks a required one. */
export const IMPORT_FIELD_LABELS: Record<ImportableField, string> = {
  firstName: 'First name *',
  lastName: 'Last name',
  companyName: 'Company',
  mobile: 'Mobile *',
  email: 'Email',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  city: 'City',
  state: 'State / region',
  postalCode: 'Postal / PIN code',
  country: 'Country (2-letter code)',
  source: 'Source',
  productInterest: 'Product interest',
  estimatedValue: 'Estimated value',
  nextFollowUpAt: 'Follow-up date',
};

/**
 * The visual grouping in the mapping UI, so sixteen fields read as five short
 * lists rather than one long one.
 */
export const IMPORT_FIELD_GROUPS: readonly {
  label: string;
  fields: readonly ImportableField[];
}[] = [
  { label: 'Who they are', fields: ['firstName', 'lastName', 'companyName'] },
  { label: 'How to reach them', fields: ['mobile', 'email'] },
  {
    label: 'Where they are',
    fields: ['addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country'],
  },
  { label: 'What they want', fields: ['source', 'productInterest', 'estimatedValue'] },
  { label: 'What happens next', fields: ['nextFollowUpAt'] },
];

// -----------------------------------------------------------------------------
// Mapping
// -----------------------------------------------------------------------------

/**
 * How sure the server is about one suggested column.
 *
 * The distinction that matters is `exact` versus `fuzzy`: an exact alias hit is
 * offered pre-selected, a fuzzy one is offered but **left unselected** so a
 * person has to agree to it. Pre-selecting a guess is how a "budget" column
 * lands in "estimated value" for two thousand leads.
 */
export const MAPPING_CONFIDENCES = ['exact', 'fuzzy'] as const;
export type MappingConfidence = (typeof MAPPING_CONFIDENCES)[number];

/** One CSV column, and what the server thinks it is. */
export interface SuggestedColumn {
  /** The header exactly as it appears in the file. */
  header: string;
  /** 0-based position, so duplicate headers stay distinguishable. */
  index: number;
  /** Null when the server has no idea — which is reported, never hidden. */
  field: ImportableField | null;
  confidence: MappingConfidence | null;
  /**
   * Why this column is not being imported, in words. Present only when
   * `field` is null or the column is otherwise set aside.
   */
  note: string | null;
}

/**
 * Two columns claiming the same destination field.
 *
 * Reported rather than silently resolved: a file with both "Phone" and "Mobile"
 * columns may hold a landline and a mobile, or the same number twice, and only
 * the person who exported it knows which.
 */
export interface MappingCollision {
  field: ImportableField;
  headers: string[];
}

// -----------------------------------------------------------------------------
// Preview
// -----------------------------------------------------------------------------

/** What made a row a duplicate, and of what. */
export type ImportDuplicate =
  | { kind: 'existing'; leadNumber: string; matchedOn: 'mobile' | 'email' }
  | { kind: 'file'; line: number; matchedOn: 'mobile' | 'email' };

export interface ImportPreviewRow {
  /** 1-based and counting the header as row 1, so it matches the spreadsheet. */
  line: number;
  values: Partial<Record<ImportableField, string>>;
  errors: string[];
  duplicateOf: ImportDuplicate | null;
}

export interface ImportPreview {
  /** Every column in the file, in file order, mapped or not. */
  columns: SuggestedColumn[];
  /** Header → field, for the fields the server is confident about. */
  mapping: Record<string, ImportableField>;
  /** Headers going nowhere. Always reported; never silently dropped. */
  unmapped: string[];
  /** Columns the server guessed at but did not select. Needs a human. */
  needsConfirmation: SuggestedColumn[];
  collisions: MappingCollision[];
  missingRequired: ImportableField[];
  /** Headers appearing more than once in the file. */
  duplicateHeaders: string[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  /** Rows that would import but are worth a look. */
  reviewRows: number;
  /** A sample. The point of the preview is to eyeball the mapping. */
  rows: ImportPreviewRow[];
  /**
   * EVERY row that has an error or is a duplicate, as CSV text.
   *
   * The whole file, not the sample: a 900-row file with 40 bad rows is
   * unusable if the screen shows only the first twenty. The client offers it as
   * a download so the user can fix the source file and re-import.
   */
  errorCsv: string | null;
}

// -----------------------------------------------------------------------------
// Import
// -----------------------------------------------------------------------------

/**
 * What to do about rows that match a lead already in the CRM.
 *
 * `SKIP` is the default and the only safe one. There is deliberately NO
 * "update existing" mode: see the note on `LeadImportService.import`.
 */
export const IMPORT_DUPLICATE_MODES = ['SKIP', 'CREATE_ANYWAY'] as const;
export type ImportDuplicateMode = (typeof IMPORT_DUPLICATE_MODES)[number];

export interface ImportFailure {
  line: number;
  reason: string;
}

export interface ImportResult {
  /** The batch every created lead now carries. Null if nothing was created. */
  batchId: string | null;
  created: number;
  skipped: number;
  failed: number;
  failures: ImportFailure[];
  /** Rows that failed, as CSV text, for the same reason as in the preview. */
  errorCsv: string | null;
}

/** One past import, for the batch list. */
export interface LeadImportBatchSummary {
  id: string;
  fileName: string | null;
  totalRows: number;
  created: number;
  skipped: number;
  failed: number;
  /** How many of this batch's leads are still live right now. */
  activeLeads: number;
  /** How many have since been deactivated. */
  deactivatedLeads: number;
  startedAt: string;
  completedAt: string | null;
  importedBy: { id: string; fullName: string } | null;
  mapping: Record<string, string>;
}

export interface LeadImportMappingTemplateSummary {
  id: string;
  name: string;
  mapping: Record<string, ImportableField>;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// Lead lifecycle
// -----------------------------------------------------------------------------

/**
 * Which lifecycle states a lead list includes.
 *
 * Three values rather than a boolean, because there are three useful answers:
 * the working pipeline, the records somebody took out of service, and — for the
 * import-correction screen — everything from one batch whatever state it is in.
 */
export const LEAD_LIFECYCLE_FILTERS = ['ACTIVE', 'INACTIVE', 'ALL'] as const;
export type LeadLifecycleFilter = (typeof LEAD_LIFECYCLE_FILTERS)[number];
