import { useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IMPORT_FIELD_GROUPS,
  IMPORT_FIELD_LABELS,
  REQUIRED_IMPORT_FIELDS,
  type ImportDuplicateMode,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResult,
  type ImportableField,
  type LeadImportMappingTemplateSummary,
} from '@leadflow/api-types';
import { ApiError, apiGet, apiPost } from '../../lib/api-client';
import { Card, CardHeader, ErrorNotice, PageHeader } from '../../components/ui';
import { defaultNextFollowUp, Field, inputClass } from './lead-dialogs';

/*
 * The field list, its labels and its grouping come from @leadflow/api-types.
 *
 * They used to be re-declared here by hand, and the two copies had drifted: the
 * API knew ten fields, this screen knew ten in a different order, and neither
 * knew the address existed. That duplication is a direct cause of the mapping
 * defects this release fixes — a field added to the server was invisible here
 * until somebody remembered to add it twice.
 */

const MAX_BYTES = 2_000_000;

/**
 * CSV import — read the file, confirm the mapping, then commit.
 *
 * The preview step is the point of the whole screen. An import that runs
 * straight off an upload gives no chance to notice that a "budget" column
 * landed in "estimated value", and there is no undo for two thousand wrong
 * leads.
 */
export function ImportLeadsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, ImportableField | ''>>({});
  const [followUp, setFollowUp] = useState(defaultNextFollowUp(3));
  const [assignedToId, setAssignedToId] = useState('');
  const [duplicateMode, setDuplicateMode] = useState<ImportDuplicateMode>('SKIP');
  /*
   * A second, explicit acknowledgement for CREATE_ANYWAY.
   *
   * The warning alone was not enough. This mode creates a deliberate duplicate
   * for every matching row AT SCALE — forty rows means forty second leads for
   * customers somebody is already working — and a dropdown the user may have
   * changed minutes ago is a weak record of intent for that. The tick resets
   * whenever the mode changes, so it can never be left on from a previous
   * decision.
   */
  const [duplicatesAcknowledged, setDuplicatesAcknowledged] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);

  const assignable = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => apiGet<{ id: string; fullName: string }[]>('/leads/assignable-users'),
  });

  const templates = useQuery({
    queryKey: ['lead-import-mappings'],
    queryFn: () =>
      apiGet<LeadImportMappingTemplateSummary[]>('/leads/import/mappings'),
  });

  const preview = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPost<ImportPreview>('/leads/import/preview', body),
    onSuccess: (data) => {
      // Only seed the mapping from the server's suggestion the first time;
      // re-running the preview must not discard the user's own corrections.
      setMapping((current) => (Object.keys(current).length > 0 ? current : data.mapping));
    },
  });

  const runImport = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<ImportResult>('/leads/import', body),
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['lead-import-batches'] });
    },
  });

  const saveTemplate = useMutation({
    mutationFn: (body: { name: string; mapping: Record<string, string> }) =>
      apiPost<LeadImportMappingTemplateSummary>('/leads/import/mappings', body),
    onSuccess: () => {
      setTemplateName('');
      void queryClient.invalidateQueries({ queryKey: ['lead-import-mappings'] });
    },
  });

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFileError(null);
    setResult(null);
    setMapping({});

    if (file.size > MAX_BYTES) {
      setFileError(`That file is ${(file.size / 1_000_000).toFixed(1)} MB. The limit is 2 MB.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      setCsv(text);
      setFileName(file.name);
      preview.mutate({ csv: text, fileName: file.name });
    };
    reader.onerror = () => setFileError('That file could not be read.');
    // UTF-8 explicitly: the default depends on the browser's locale, and a
    // Marathi or Devanagari file read as windows-1252 arrives as mojibake that
    // imports successfully and is unreadable afterwards.
    reader.readAsText(file, 'UTF-8');
  };

  const applyMapping = (): void => {
    preview.mutate({ csv, fileName, mapping: cleanMapping(mapping) });
  };

  const commit = (): void => {
    runImport.mutate({
      csv,
      fileName,
      mapping: cleanMapping(mapping),
      defaultNextFollowUpAt: new Date(followUp).toISOString(),
      ...(assignedToId ? { assignedToId } : {}),
      duplicateMode,
    });
  };

  const data = preview.data;
  const clean = cleanMapping(mapping);
  /*
   * `cleanMapping` widens the values to `string` for the wire, so they are
   * narrowed back here. Without it `IMPORT_FIELD_LABELS[field]` is an implicit
   * any — and an implicit any is how a field name that no longer exists gets
   * rendered as "undefined" to a user.
   */
  const mapped = Object.values(clean) as ImportableField[];
  const missingRequired = REQUIRED_IMPORT_FIELDS.filter((field) => !mapped.includes(field));
  // Computed here as well as on the server, so the warning appears the moment
  // the user creates it rather than after another round trip.
  const collisions = [...new Set(mapped.filter((field, index) => mapped.indexOf(field) !== index))];

  return (
    <>
      <PageHeader
        title="Import leads"
        subtitle="Upload a CSV, check the mapping, then import"
        action={
          <span className="flex gap-2">
            <Link
              to="/leads/import/batches"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Past imports
            </Link>
            <Link
              to="/leads"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Back to leads
            </Link>
          </span>
        }
      />

      {result ? (
        <ResultCard result={result} onDone={() => navigate('/leads')} />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader title="1 · Choose a file" subtitle="CSV, up to 2 MB and 5,000 rows" />
            <div className="space-y-3 p-5">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={onFile}
                aria-label="CSV file"
                className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
              />
              {fileName && <p className="text-xs text-slate-500">Loaded {fileName}</p>}
              {fileError && <ErrorNotice message={fileError} />}
              {preview.isError && (
                <ErrorNotice
                  message={
                    preview.error instanceof ApiError
                      ? (preview.error.details?.['csv']?.[0] ??
                        preview.error.details?.['mapping']?.join(' ') ??
                        preview.error.message)
                      : 'That file could not be read.'
                  }
                />
              )}
            </div>
          </Card>

          {data && (
            <>
              <Card>
                <CardHeader
                  title="2 · Match the columns"
                  subtitle="Every column in your file is listed. Nothing is imported unless it has a field."
                  action={
                    (templates.data ?? []).length > 0 ? (
                      <select
                        aria-label="Use a saved mapping"
                        defaultValue=""
                        onChange={(event) => {
                          const chosen = (templates.data ?? []).find(
                            (template) => template.id === event.target.value,
                          );
                          if (chosen) setMapping(chosen.mapping);
                        }}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
                      >
                        <option value="">Use a saved mapping…</option>
                        {(templates.data ?? []).map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name}
                          </option>
                        ))}
                      </select>
                    ) : undefined
                  }
                />
                <div className="space-y-4 p-5">
                  {data.duplicateHeaders.length > 0 && (
                    <Warning>
                      {data.duplicateHeaders.join(', ')} appears more than once in your file. Only
                      the first column with that name is read — rename them if they hold different
                      things.
                    </Warning>
                  )}

                  {collisions.length > 0 && (
                    <Warning tone="error">
                      Two columns are mapped to{' '}
                      {collisions.map((field) => IMPORT_FIELD_LABELS[field].replace(' *', '')).join(', ')}.
                      Only one can be, so pick which column holds it.
                    </Warning>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    {data.columns.map((column) => (
                      <div key={`${column.header}-${column.index}`}>
                        <label
                          htmlFor={`map-${column.index}`}
                          className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-600"
                        >
                          <span className="truncate">{column.header || '(unnamed column)'}</span>
                          {column.confidence === 'fuzzy' && (
                            <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                              Check this
                            </span>
                          )}
                        </label>
                        <select
                          id={`map-${column.index}`}
                          value={mapping[column.header] ?? ''}
                          onChange={(event) =>
                            setMapping((current) => ({
                              ...current,
                              [column.header]: event.target.value as ImportableField | '',
                            }))
                          }
                          className={inputClass}
                        >
                          <option value="">Do not import this column</option>
                          {/* Grouped, because a flat list of sixteen fields is
                              how somebody picks "state" when they meant
                              "status". */}
                          {IMPORT_FIELD_GROUPS.map((group) => (
                            <optgroup key={group.label} label={group.label}>
                              {group.fields.map((field) => (
                                <option key={field} value={field}>
                                  {IMPORT_FIELD_LABELS[field]}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        {/* The note is the fix for "the column vanished and
                            nobody said anything". */}
                        {column.note && !mapping[column.header] && (
                          <p className="mt-1 text-[11px] text-slate-500">{column.note}</p>
                        )}
                      </div>
                    ))}
                  </div>

                  {missingRequired.length > 0 && (
                    <p role="alert" className="text-xs text-red-600">
                      Map a column to{' '}
                      {missingRequired
                        .map((field) => IMPORT_FIELD_LABELS[field].replace(' *', ''))
                        .join(' and ')}{' '}
                      before importing.
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={applyMapping}
                      disabled={preview.isPending}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      {preview.isPending ? 'Checking…' : 'Re-check with this mapping'}
                    </button>

                    <span className="flex gap-2">
                      <input
                        aria-label="Name for this mapping"
                        placeholder="Save this mapping as…"
                        value={templateName}
                        onChange={(event) => setTemplateName(event.target.value)}
                        className="w-48 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        disabled={!templateName.trim() || saveTemplate.isPending}
                        onClick={() =>
                          saveTemplate.mutate({ name: templateName.trim(), mapping: clean })
                        }
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                      >
                        Save
                      </button>
                    </span>
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="3 · Preview"
                  subtitle={`${data.totalRows} rows · ${data.validRows} ready · ${data.duplicateRows} duplicates · ${data.invalidRows} with problems`}
                  action={
                    data.errorCsv ? (
                      <DownloadErrors
                        csv={data.errorCsv}
                        fileName={`${fileName.replace(/\.csv$/i, '') || 'import'}-problems.csv`}
                      />
                    ) : undefined
                  }
                />
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 font-medium">Row</th>
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Mobile</th>
                        <th className="px-3 py-2 font-medium">Company</th>
                        {/* The address is in the preview because its absence
                            was the defect: a user has to be able to SEE that
                            it arrived in the right place. */}
                        <th className="px-3 py-2 font-medium">Address</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.rows.map((row) => (
                        <tr key={row.line}>
                          <td className="px-3 py-2 text-slate-400 tabular-nums">{row.line}</td>
                          <td className="px-3 py-2 text-slate-900">
                            {[row.values.firstName, row.values.lastName]
                              .filter(Boolean)
                              .join(' ') || '—'}
                          </td>
                          <td className="px-3 py-2 text-slate-600">{row.values.mobile ?? '—'}</td>
                          <td className="px-3 py-2 text-slate-600">
                            {row.values.companyName ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-slate-600">{addressOf(row) || '—'}</td>
                          <td className="px-3 py-2">
                            <RowStatus row={row} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.totalRows > data.rows.length && (
                  <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
                    Showing the first {data.rows.length} rows. All {data.totalRows} are checked —
                    the counts above cover the whole file, and the download has every problem row.
                  </p>
                )}
              </Card>

              <Card>
                <CardHeader title="4 · Import" />
                <div className="space-y-4 p-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Follow-up date for every imported lead"
                      htmlFor="import-followup"
                      required
                      hint="Every active lead must have a next action, so imported rows without their own date use this one."
                    >
                      <input
                        id="import-followup"
                        type="datetime-local"
                        value={followUp}
                        onChange={(event) => setFollowUp(event.target.value)}
                        className={inputClass}
                      />
                    </Field>

                    <Field
                      label="Assign to"
                      htmlFor="import-owner"
                      hint="Leave blank to import unassigned."
                    >
                      <select
                        id="import-owner"
                        value={assignedToId}
                        onChange={(event) => setAssignedToId(event.target.value)}
                        className={inputClass}
                      >
                        <option value="">Unassigned</option>
                        {(assignable.data ?? []).map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.fullName}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>

                  <Field
                    label="Rows that match a lead you already have"
                    htmlFor="import-duplicates"
                    hint="A row repeated inside this file is always skipped, whichever you choose."
                  >
                    <select
                      id="import-duplicates"
                      value={duplicateMode}
                      onChange={(event) => {
                        setDuplicateMode(event.target.value as ImportDuplicateMode);
                        // Reset on every change, so a tick from an earlier
                        // decision cannot carry over into a new one.
                        setDuplicatesAcknowledged(false);
                      }}
                      className={inputClass}
                    >
                      <option value="SKIP">Skip them (recommended)</option>
                      <option value="CREATE_ANYWAY">
                        Create a second lead for them anyway
                      </option>
                    </select>
                  </Field>

                  {duplicateMode === 'CREATE_ANYWAY' && (
                    <div className="space-y-2">
                      <Warning>
                        {data.duplicateRows > 0
                          ? `${data.duplicateRows} ${
                              data.duplicateRows === 1 ? 'row' : 'rows'
                            } in this file match a lead you already have. Each becomes a second
                             live lead for a customer somebody is already working.`
                          : `Any row matching a lead you already have becomes a second live lead
                             for a customer somebody is already working.`}{' '}
                        Nothing on the existing lead is changed — not its owner, its stage, its
                        value or its history.
                      </Warning>

                      <label className="flex items-start gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={duplicatesAcknowledged}
                          onChange={(event) => setDuplicatesAcknowledged(event.target.checked)}
                          className="mt-1"
                        />
                        <span>
                          I have checked these and want the second leads created
                          <span className="block text-xs text-slate-500">
                            Each new lead records on its timeline which existing lead it
                            duplicates, and the import is recorded against your account.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}

                  {runImport.isError && (
                    <ErrorNotice
                      message={
                        runImport.error instanceof ApiError
                          ? [
                              runImport.error.message,
                              ...(runImport.error.details?.['mapping'] ?? []),
                            ].join(' ')
                          : 'The import could not be started.'
                      }
                    />
                  )}

                  <button
                    type="button"
                    onClick={commit}
                    disabled={
                      runImport.isPending ||
                      missingRequired.length > 0 ||
                      collisions.length > 0 ||
                      // Deliberate duplicates need the explicit tick, not just
                      // the dropdown.
                      (duplicateMode === 'CREATE_ANYWAY' && !duplicatesAcknowledged) ||
                      !followUp
                    }
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
                  >
                    {runImport.isPending
                      ? 'Importing…'
                      : `Import ${data.validRows} ${data.validRows === 1 ? 'lead' : 'leads'}`}
                  </button>
                </div>
              </Card>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** The address as one line, for the preview column. */
function addressOf(row: ImportPreviewRow): string {
  return [
    row.values.addressLine1,
    row.values.addressLine2,
    row.values.city,
    row.values.state,
    row.values.postalCode,
    row.values.country,
  ]
    .filter(Boolean)
    .join(', ');
}

function Warning({
  children,
  tone = 'warn',
}: {
  children: React.ReactNode;
  tone?: 'warn' | 'error';
}): React.JSX.Element {
  const styles =
    tone === 'error'
      ? 'bg-red-50 text-red-800'
      : 'bg-amber-50 text-amber-800';

  return <p className={`rounded-lg px-3 py-2 text-xs ${styles}`}>{children}</p>;
}

/**
 * The problem rows, as a file.
 *
 * A download rather than a longer table, because the point is to FIX the source
 * file: this CSV carries each bad row's own values back, so the user can
 * correct them and re-import without cross-referencing line numbers by hand.
 * That is what made the old on-screen list of a hundred failures unusable on a
 * nine-hundred-row file.
 *
 * Built with a Blob rather than a `data:` URL, which some browsers refuse to
 * download from a top-level navigation.
 */
function DownloadErrors({ csv, fileName }: { csv: string; fileName: string }): React.JSX.Element {
  const download = (): void => {
    // The BOM makes Excel open a UTF-8 CSV correctly. Without it a file
    // containing Marathi names opens as mojibake, and the user concludes the
    // import corrupted their data.
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      type="button"
      onClick={download}
      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
    >
      Download problem rows
    </button>
  );
}

function RowStatus({ row }: { row: ImportPreviewRow }): React.JSX.Element {
  if (row.errors.length > 0) {
    return <span className="text-red-600">{row.errors.join(' ')}</span>;
  }

  if (row.duplicateOf) {
    return (
      <span className="text-amber-700">
        {row.duplicateOf.kind === 'existing'
          ? `Same ${row.duplicateOf.matchedOn} as ${row.duplicateOf.leadNumber}`
          : `Same ${row.duplicateOf.matchedOn} as row ${row.duplicateOf.line}`}
      </span>
    );
  }

  return <span className="text-emerald-700">Ready</span>;
}

function ResultCard({
  result,
  onDone,
}: {
  result: ImportResult;
  onDone: () => void;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader
        title="Import finished"
        action={
          result.errorCsv ? (
            <DownloadErrors csv={result.errorCsv} fileName="import-problems.csv" />
          ) : undefined
        }
      />
      <div className="space-y-4 p-5">
        <dl className="grid grid-cols-3 gap-4">
          <Stat label="Created" value={result.created} tone="text-emerald-700" />
          <Stat label="Skipped" value={result.skipped} tone="text-amber-700" />
          <Stat label="Failed" value={result.failed} tone="text-red-700" />
        </dl>

        {result.failures.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-slate-700">Rows that did not import:</p>
            <ul className="max-h-60 space-y-1 overflow-y-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              {result.failures.map((failure) => (
                <li key={failure.line}>
                  Row {failure.line}: {failure.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onDone}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            View leads
          </button>
          {result.batchId && (
            <Link
              to={`/leads?importBatchId=${result.batchId}`}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              See just these leads
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}

/** Drops "do not import this column" entries before sending the mapping. */
function cleanMapping(mapping: Record<string, ImportableField | ''>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapping).filter((entry): entry is [string, ImportableField] => entry[1] !== ''),
  );
}
