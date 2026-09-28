/**
 * CSV writing, the mirror of `src/import/csv.ts`.
 *
 * Quoting is not optional: a note containing a comma or a newline would otherwise
 * shift every following column, and the export is meant to be re-importable.
 */

/** Quote a field only when it needs it, doubling any embedded quotes. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  if (text === "") return "";
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  // Trailing newline: a file that does not end in one trips some parsers.
  return `${lines.join("\r\n")}\r\n`;
}
