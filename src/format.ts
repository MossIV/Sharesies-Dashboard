/**
 * Formatting shared by the CLI scripts and the notification channels.
 *
 * The web app has its own copy in `web/src/api.ts`; the two packages build
 * independently, so this is deliberate duplication rather than a shared package.
 */

export function nzd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return new Intl.NumberFormat("en-NZ", {
    style: "currency",
    currency: "NZD",
    negativeBrackets: true,
  } as Intl.NumberFormatOptions).format(value);
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return `${value.toFixed(digits)}%`;
}

/** "2026-08-14" or an ISO timestamp to "14 Aug 2026". */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "–";
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
