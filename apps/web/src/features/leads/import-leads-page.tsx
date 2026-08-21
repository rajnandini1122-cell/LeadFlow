import { useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost } from '../../lib/api-client';
import { Card, CardHeader, ErrorNotice, PageHeader } from '../../components/ui';
import { defaultNextFollowUp, Field, inputClass } from './lead-dialogs';

const IMPORTABLE_FIELDS = [
  'firstName',
  'lastName',
  'mobile',
  'email',
  'companyName',
  'city',
  'source',
  'productInterest',
  'estimatedValue',
  'nextFollowUpAt',
] as const;

type ImportableField = (typeof IMPORTABLE_FIELDS)[number];

const FIELD_LABELS: Record<ImportableField, string> = {
  firstName: 'First name *',
  lastName: 'Last name',
  mobile: 'Mobile *',
  email: 'Email',
  companyName: 'Company',
  city: 'City',
  source: 'Source',
  productInterest: 'Product interest',
  estimatedValue: 'Estimated value',
  nextFollowUpAt: 'Follow-up date',
};

interface PreviewRow {
  line: number;
  values: Partial<Record<ImportableField, string>>;
  errors: string[];
  duplicateOf: { leadNumber: string; kind: 'existing' } | { line: number; kind: 'file' } | null;
}

interface ImportPreview {
  headers: string[];
  mapping: Record<string, ImportableField>;
  unmapped: string[];
  missingRequired: ImportableField[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  rows: PreviewRow[];
}

interface ImportResult {
  created: number;
  skipped: number;
  failed: number;
  failures: { line: number; reason: string }[];
}

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
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [result, setResult] = useState<ImportResult | null>(null);

  const assignable = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => apiGet<{ id: string; fullName: string }[]>('/leads/assignable-users'),
  });

  const preview = useMutation({
    mutationFn: (body: { csv: string; mapping?: Record<string, string> }) =>
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
      preview.mutate({ csv: text });
    };
    reader.onerror = () => setFileError('That file could not be read.');
    reader.readAsText(file);
  };

  const applyMapping = (): void => {
    preview.mutate({ csv, mapping: cleanMapping(mapping) });
  };

  const commit = (): void => {
    runImport.mutate({
      csv,
      mapping: cleanMapping(mapping),
      defaultNextFollowUpAt: new Date(followUp).toISOString(),
      ...(assignedToId ? { assignedToId } : {}),
      skipDuplicates,
    });
  };

  const data = preview.data;
  const mapped = new Set(Object.values(cleanMapping(mapping)));
  const missingRequired = (['firstName', 'mobile'] as ImportableField[]).filter(
    (field) => !mapped.has(field),
  );

  return (
    <>
      <PageHeader
        title="Import leads"
        subtitle="Upload a CSV, check the mapping, then import"
        action={
          <Link
            to="/leads"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Back to leads
          </Link>
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
                className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
              />
              {fileName && <p className="text-xs text-slate-500">Loaded {fileName}</p>}
              {fileError && <ErrorNotice message={fileError} />}
              {preview.isError && (
                <ErrorNotice
                  message={
                    preview.error instanceof ApiError
                      ? (preview.error.details?.['csv']?.[0] ?? preview.error.message)
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
                  subtitle="Checked against your file's header row. Correct anything that looks wrong."
                />
                <div className="space-y-3 p-5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {data.headers.map((header) => (
                      <div key={header}>
                        <label
                          htmlFor={`map-${header}`}
                          className="mb-1 block truncate text-xs font-medium text-slate-600"
                        >
                          {header}
                        </label>
                        <select
                          id={`map-${header}`}
                          value={mapping[header] ?? ''}
                          onChange={(event) =>
                            setMapping((current) => ({
                              ...current,
                              [header]: event.target.value as ImportableField | '',
                            }))
                          }
                          className={inputClass}
                        >
                          <option value="">Ignore this column</option>
                          {IMPORTABLE_FIELDS.map((field) => (
                            <option key={field} value={field}>
                              {FIELD_LABELS[field]}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  {missingRequired.length > 0 && (
                    <p role="alert" className="text-xs text-red-600">
                      Map a column to {missingRequired.join(' and ')} before importing.
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={applyMapping}
                    disabled={preview.isPending}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                  >
                    {preview.isPending ? 'Checking…' : 'Re-check with this mapping'}
                  </button>
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="3 · Preview"
                  subtitle={`${data.totalRows} rows · ${data.validRows} ready · ${data.duplicateRows} duplicates · ${data.invalidRows} with problems`}
                />
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 font-medium">Row</th>
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Mobile</th>
                        <th className="px-3 py-2 font-medium">Company</th>
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
                    the counts above cover the whole file.
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

                    <Field label="Assign to" htmlFor="import-owner" hint="Leave blank to import unassigned.">
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

                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={skipDuplicates}
                      onChange={(event) => setSkipDuplicates(event.target.checked)}
                      className="mt-1"
                    />
                    <span>
                      Skip rows whose mobile already belongs to an active lead
                      <span className="block text-xs text-slate-500">
                        Recommended. Otherwise a file that overlaps your pipeline doubles the
                        leads you are already working.
                      </span>
                    </span>
                  </label>

                  {runImport.isError && (
                    <ErrorNotice
                      message={
                        runImport.error instanceof ApiError
                          ? runImport.error.message
                          : 'The import could not be started.'
                      }
                    />
                  )}

                  <button
                    type="button"
                    onClick={commit}
                    disabled={runImport.isPending || missingRequired.length > 0 || !followUp}
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

function RowStatus({ row }: { row: PreviewRow }): React.JSX.Element {
  if (row.errors.length > 0) {
    return <span className="text-red-600">{row.errors.join('; ')}</span>;
  }

  if (row.duplicateOf) {
    return (
      <span className="text-amber-700">
        {row.duplicateOf.kind === 'existing'
          ? `Duplicate of ${row.duplicateOf.leadNumber}`
          : `Duplicate of row ${row.duplicateOf.line}`}
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
      <CardHeader title="Import finished" />
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

        <button
          type="button"
          onClick={onDone}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          View leads
        </button>
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

/** Drops "ignore this column" entries before sending the mapping. */
function cleanMapping(mapping: Record<string, ImportableField | ''>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapping).filter((entry): entry is [string, ImportableField] => entry[1] !== ''),
  );
}
