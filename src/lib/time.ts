/**
 * Week arithmetic, in UTC throughout.
 *
 * Cloudflare cron triggers are UTC-only, D1 stores timestamps as ISO-8601
 * TEXT so lexical sort equals chronological sort, and the Hugging Face API
 * reports `createdAt` in UTC. Introducing a local timezone anywhere in the
 * pipeline would only create an off-by-one at the week boundary, so every
 * helper here is deliberately UTC.
 */

const DAY_MS = 86_400_000;

/** ISO-8601 calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

/** Formats a Date as `YYYY-MM-DD` in UTC. */
export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** Formats a Date as a full ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. */
export function toIsoTimestamp(date: Date): string {
  return date.toISOString();
}

/**
 * The Monday 00:00:00 UTC at or before `date`.
 *
 * ISO-8601 weeks start on Monday, which is also what the cron schedule
 * (`30 0 * * 1`) fires on, so a run always lands exactly on a week start.
 */
export function weekStart(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay(): Sunday = 0. Remap so Monday = 0 ... Sunday = 6.
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d;
}

/** The Monday at or before `date`, as `YYYY-MM-DD`. */
export function weekStartIso(date: Date): IsoDate {
  return toIsoDate(weekStart(date));
}

/** Shifts a date by whole weeks. Negative values go backwards. */
export function addWeeks(date: Date, weeks: number): Date {
  return new Date(date.getTime() + weeks * 7 * DAY_MS);
}

/**
 * The `YYYY-Www` ISO week label used for snapshot filenames, e.g. `2026-W33`.
 *
 * The ISO week-numbering year is not always the calendar year: 2027-01-01 is
 * a Friday and belongs to 2026-W53, so the year is taken from the week's
 * Thursday rather than from the input date.
 */
export function isoWeekLabel(date: Date): string {
  // Thursday of this week decides both the week number and the ISO year.
  const thursday = new Date(weekStart(date).getTime() + 3 * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / (7 * DAY_MS)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * The half-open window `[start, end)` covering `weeks` whole weeks ending at
 * the week containing `reference` — inclusive of that week.
 *
 * Half-open is deliberate: a record created at exactly the boundary instant
 * belongs to precisely one week, so consecutive windows can never
 * double-count or drop a record.
 */
export function trailingWeekWindow(reference: Date, weeks: number): { start: Date; end: Date } {
  if (!Number.isInteger(weeks) || weeks < 1) {
    throw new RangeError(`weeks must be a positive integer, got ${weeks}`);
  }
  const end = addWeeks(weekStart(reference), 1);
  return { start: addWeeks(end, -weeks), end };
}
