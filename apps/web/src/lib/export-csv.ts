/**
 * CSV export, done in the browser.
 *
 * No server round trip and no new endpoint: the rows are already loaded for the
 * table the user is looking at, and "export what I can see" is the behaviour
 * people expect from a filtered list. A server-side export endpoint becomes
 * worthwhile once the dataset outgrows one page — that belongs with the
 * reporting APIs in Phase 4.
 */

/** RFC 4180 escaping: quote if the value contains a comma, quote or newline. */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;

  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Excel guesses the separator from the first line unless told otherwise, and on
 * many Indian/European locale installs it guesses semicolon and puts the whole
 * row in one cell. The `sep=,` hint prevents that.
 *
 * The BOM makes Excel read the file as UTF-8, without which the rupee sign and
 * Indian names render as mojibake.
 */
export function toCsv<T>(
  rows: T[],
  columns: { header: string; value: (row: T) => unknown }[],
): string {
  const header = columns.map((column) => escapeCell(column.header)).join(',');
  const body = rows.map((row) =>
    columns.map((column) => escapeCell(column.value(row))).join(','),
  );

  return `sep=,\r\n${[header, ...body].join('\r\n')}`;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Release the blob once the download has been handed to the browser.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** e.g. idea001-leads-cravion-2026-08-20.csv */
export function exportFilename(prefix: string, slug: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `idea001-${prefix}-${slug}-${today}.csv`;
}
