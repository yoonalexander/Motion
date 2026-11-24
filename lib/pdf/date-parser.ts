import "client-only";

export interface DateParseContext {
  periodStart?: string;
  periodEnd?: string;
  periodVerified?: boolean;
  dateOrder?: "MDY" | "DMY";
}

export interface DateSpan {
  raw: string;
  start: number;
  end: number;
  hasExplicitYear: boolean;
}

export interface ParsedDate {
  isoDate: string | null;
  ambiguous: boolean;
  yearInferred: boolean;
}

const MONTHS: Record<string, number> = {
  JAN: 1,
  JANUARY: 1,
  FEB: 2,
  FEBRUARY: 2,
  MAR: 3,
  MARCH: 3,
  APR: 4,
  APRIL: 4,
  MAY: 5,
  JUN: 6,
  JUNE: 6,
  JUL: 7,
  JULY: 7,
  AUG: 8,
  AUGUST: 8,
  SEP: 9,
  SEPT: 9,
  SEPTEMBER: 9,
  OCT: 10,
  OCTOBER: 10,
  NOV: 11,
  NOVEMBER: 11,
  DEC: 12,
  DECEMBER: 12,
};

const datePattern = new RegExp(
  String.raw`(?<![\p{L}\d])(?:` +
    String.raw`\d{4}[-/]\d{1,2}[-/]\d{1,2}` + // ISO
    String.raw`|\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?` + // numeric
    String.raw`|(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\.?\s+\d{1,2}(?:,\s*\d{2,4}|\s+\d{4})?` + // OCT 01
    String.raw`|\d{1,2}\s+(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\.?(?:,\s*\d{2,4}|\s+\d{4})?` + // 01 OCT
    String.raw`)(?![\p{L}\d])`,
  "giu",
);

/** Finds non-overlapping, source-offset date spans. These offsets are safe for masking before amount discovery. */
export function findDateSpans(text: string): DateSpan[] {
  const spans: DateSpan[] = [];
  for (const match of text.matchAll(datePattern)) {
    const raw = match[0];
    const start = match.index;
    if (start === undefined) continue;
    const parsed = splitDate(raw);
    if (!parsed) continue;
    spans.push({ raw, start, end: start + raw.length, hasExplicitYear: parsed.year !== null });
  }
  return spans;
}

export function parseDate(raw: string, context: DateParseContext): ParsedDate {
  const parts = splitDate(raw.trim(), context.dateOrder);
  if (!parts) return { isoDate: null, ambiguous: true, yearInferred: false };

  const { month, day } = parts;
  let { year } = parts;
  const ambiguous = parts.ambiguous;
  let yearInferred = false;

  const period = verifiedPeriod(context);
  if (parts.alternate && period) {
    const primaryDates = resolveCalendarDates(month, day, year, period);
    const alternateDates = resolveCalendarDates(
      parts.alternate.month,
      parts.alternate.day,
      year,
      period,
    );
    const primaryInside = primaryDates.filter((date) => date >= period.start && date <= period.end);
    const alternateInside = alternateDates.filter(
      (date) => date >= period.start && date <= period.end,
    );
    if (primaryInside.length + alternateInside.length === 1) {
      const selected = primaryInside[0] ?? alternateInside[0]!;
      return { isoDate: selected, ambiguous: false, yearInferred: year === null || year < 100 };
    }
    if (
      primaryInside.length === 1 &&
      alternateInside.length === 1 &&
      primaryInside[0] === alternateInside[0]
    ) {
      return {
        isoDate: primaryInside[0]!,
        ambiguous: false,
        yearInferred: year === null || year < 100,
      };
    }
  }

  if (year !== null) {
    if (year < 100) {
      // Stable pivot avoids a hidden dependency on the machine clock.
      year = year <= 50 ? 2000 + year : 1900 + year;
      yearInferred = true;
    }
  } else {
    yearInferred = true;
    if (!period) return { isoDate: null, ambiguous: true, yearInferred };
    const matches = resolveCalendarDates(month, day, null, period).filter(
      (date) => date >= period.start && date <= period.end,
    );
    if (matches.length !== 1) return { isoDate: null, ambiguous: true, yearInferred };
    return { isoDate: matches[0]!, ambiguous, yearInferred };
  }

  const isoDate = toIso(year, month, day);
  if (!isValidCalendarDate(isoDate)) return { isoDate: null, ambiguous: true, yearInferred: false };
  return { isoDate, ambiguous, yearInferred };
}

function splitDate(
  raw: string,
  dateOrder?: "MDY" | "DMY",
): {
  month: number;
  day: number;
  year: number | null;
  ambiguous: boolean;
  alternate?: { month: number; day: number };
} | null {
  const trimmed = raw.trim().replace(/\.$/, "");
  const iso = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso)
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), ambiguous: false };

  const numeric = trimmed.match(/^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    let month: number;
    let day: number;
    let ambiguous = false;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else if (a <= 12 && b <= 12) {
      month = dateOrder === "DMY" ? b : a;
      day = dateOrder === "DMY" ? a : b;
      ambiguous = !dateOrder;
    } else return null;
    return {
      month,
      day,
      year: numeric[3] ? Number(numeric[3]) : null,
      ambiguous,
      ...(a <= 12 && b <= 12 && !dateOrder ? { alternate: { month: b, day: a } } : {}),
    };
  }

  const named = trimmed.match(
    /^(?:(\d{1,2})\s+([A-Z]+)\.?|([A-Z]+)\.?\s+(\d{1,2}))(?:,?\s+(\d{2,4}))?$/i,
  );
  if (!named) return null;
  const day = Number(named[1] ?? named[4]);
  const monthName = (named[2] ?? named[3] ?? "").toUpperCase();
  const month = MONTHS[monthName];
  if (!month) return null;
  return { month, day, year: named[5] ? Number(named[5]) : null, ambiguous: false };
}

function resolveCalendarDates(
  month: number,
  day: number,
  year: number | null,
  period: { start: string; end: string; startYear: number; endYear: number },
): string[] {
  if (year !== null) {
    const expandedYear = year < 100 ? (year <= 50 ? 2000 + year : 1900 + year) : year;
    const iso = toIso(expandedYear, month, day);
    return isValidCalendarDate(iso) ? [iso] : [];
  }
  const dates: string[] = [];
  for (let candidate = period.startYear - 1; candidate <= period.endYear + 1; candidate++) {
    const iso = toIso(candidate, month, day);
    if (isValidCalendarDate(iso)) dates.push(iso);
  }
  return dates;
}

function verifiedPeriod(
  context: DateParseContext,
): { start: string; end: string; startYear: number; endYear: number } | null {
  if (!context.periodVerified || !context.periodStart || !context.periodEnd) return null;
  if (
    !isValidCalendarDate(context.periodStart) ||
    !isValidCalendarDate(context.periodEnd) ||
    context.periodStart > context.periodEnd
  )
    return null;
  return {
    start: context.periodStart,
    end: context.periodEnd,
    startYear: Number(context.periodStart.slice(0, 4)),
    endYear: Number(context.periodEnd.slice(0, 4)),
  };
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isValidCalendarDate(iso: string): boolean {
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}
