/**
 * Renewal rules and their boundary math.
 *
 * The math is pure and clock-injected: every function takes the current instant as an
 * argument and reads no ambient clock.
 */

import { z } from "zod";

const Timestamp = z.iso.datetime({ offset: true });

export const Renewal = z.discriminatedUnion("type", [
  /** a lifetime cap. Usage accumulates indefinitely. */
  z.strictObject({ type: z.literal("never") }),

  /** fixed-duration windows tiled forward from `anchor`. */
  z.strictObject({
    type: z.literal("interval"),
    seconds: z.int().positive(),
    anchor: Timestamp.optional(),
  }),

  /** boundaries aligned to civil calendar units. */
  z.strictObject({
    type: z.literal("calendar"),
    unit: z.enum(["day", "week", "month", "year"]),
    interval: z.int().positive().optional(),
    timezone: z.string().refine(isValidTimezone, "must be an IANA timezone name").optional(),
    anchor: Timestamp.optional(),
  }),
]);

export type Renewal = z.infer<typeof Renewal>;
type Unit = Extract<Renewal, { type: "calendar" }>["unit"];

/**
 * A rule's identity, for telling whether a submitted definition changed the one on record.
 *
 * Reconciliation asks that question for every budget on every draw, so it is worth not
 * serializing two objects to answer it. The field order is fixed here rather than left to
 * whatever order the two objects happen to carry.
 */
export function renewalKey(rule: Renewal): string {
  switch (rule.type) {
    case "never":
      return "never";
    case "interval":
      return `interval:${rule.seconds}:${rule.anchor ?? ""}`;
    case "calendar":
      return `calendar:${rule.unit}:${rule.interval ?? 1}:${rule.timezone ?? "UTC"}:${rule.anchor ?? ""}`;
  }
}

/** A civil (wall-clock) date-time in some timezone, with no offset attached. */
interface Civil {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

const MS_PER_DAY = 86_400_000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Formats a date in the given timezone.
 * Utilizes a memoized cache of Intl.DateTimeFormat objects for performance.
 */
function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timezone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timezone, cached);
  }
  return cached;
}

/** True if `timezone` is an IANA name this runtime understands. */
export function isValidTimezone(timezone: string): boolean {
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/** Decomposes an instant into civil time in `timezone`. */
function civilFromInstant(ms: number, timezone: string): Civil {
  const parts = formatter(timezone).formatToParts(new Date(ms));
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The same civil fields read as if they were UTC: the basis for offset arithmetic. */
function civilAsUtc(c: Civil): number {
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
}

/**
 * Resolves a civil time in `timezone` to an instant.
 */
function instantFromCivil(c: Civil, timezone: string): number {
  const naive = civilAsUtc(c);
  // The offset in force at instant `t`, as (UTC - local).
  const offsetAt = (t: number): number => t - civilAsUtc(civilFromInstant(t, timezone));

  const guess = naive + offsetAt(naive);
  const candidate = naive + offsetAt(guess);

  const roundTrips = (t: number): boolean => civilAsUtc(civilFromInstant(t, timezone)) === naive;
  const validGuess = roundTrips(guess);
  const validCandidate = roundTrips(candidate);

  // Overlap (fall-back): the civil time happened twice, so take the first occurrence.
  if (validGuess && validCandidate) {
    return Math.min(guess, candidate);
  }
  if (validCandidate) {
    return candidate;
  }
  if (validGuess) {
    return guess;
  }

  // Gap (spring-forward): the civil time never happened. Both candidates land outside it, on
  // either side of the transition, and the first valid instant after the gap is the
  // transition itself. Binary-search it to the second; the gap is at most a few hours.
  let low = Math.min(guess, candidate);
  let high = Math.max(guess, candidate);
  while (high - low > 1000) {
    const mid = low + Math.floor((high - low) / 2);
    if (civilAsUtc(civilFromInstant(mid, timezone)) < naive) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return high;
}

/** Civil midnight on a given calendar day. */
function midnight(year: number, month: number, day: number): Civil {
  return { year, month, day, hour: 0, minute: 0, second: 0 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Start of the calendar period containing index `i`, counted from the anchor's phase.
 *
 * Month-end clamping happens here and only here: the anchor's day-of-month is carried
 * unchanged and clamped per target month at construction time, never written back, so an
 * anchor on the 31st yields Feb 28 and then Mar 31 without drift.
 */
function periodStart(index: number, unit: Unit, anchor: Civil, timezone: string): number {
  switch (unit) {
    case "month": {
      const months = anchor.year * 12 + (anchor.month - 1) + index;
      const year = Math.floor(months / 12);
      const month = (months % 12) + 1;
      return instantFromCivil(
        midnight(year, month, Math.min(anchor.day, daysInMonth(year, month))),
        timezone,
      );
    }
    case "year": {
      const year = anchor.year + index;
      return instantFromCivil(
        midnight(year, anchor.month, Math.min(anchor.day, daysInMonth(year, anchor.month))),
        timezone,
      );
    }
    case "day":
    case "week": {
      // Day and week boundaries are a whole number of civil days from the anchor day, so
      // stepping in UTC days and re-resolving at civil midnight keeps them DST-correct.
      const step = unit === "week" ? 7 : 1;
      const base = Date.UTC(anchor.year, anchor.month - 1, anchor.day);
      const d = new Date(base + index * step * MS_PER_DAY);
      return instantFromCivil(
        midnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
        timezone,
      );
    }
  }
}

/** How many whole `unit`s separate the anchor from `from`. An estimate, refined below. */
function estimateIndex(unit: Unit, anchor: Civil, from: Civil): number {
  switch (unit) {
    case "month":
      return (from.year - anchor.year) * 12 + (from.month - anchor.month);
    case "year":
      return from.year - anchor.year;
    case "day":
    case "week": {
      const days = Math.floor(
        (Date.UTC(from.year, from.month - 1, from.day) -
          Date.UTC(anchor.year, anchor.month - 1, anchor.day)) /
          MS_PER_DAY,
      );
      return Math.floor(days / (unit === "week" ? 7 : 1));
    }
  }
}

/**
 * The default anchor for a calendar rule: the natural start of the unit.
 * For calendar units, this is the 1st of the month, Monday, January 1
 * phased off the budget's creation instant.
 */
function defaultAnchor(unit: Unit, createdAt: number, timezone: string): Civil {
  const c = civilFromInstant(createdAt, timezone);
  switch (unit) {
    case "day":
      return midnight(c.year, c.month, c.day);
    case "week": {
      // Step back to the Monday on or before the creation day.
      const utcDay = new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay();
      const d = new Date(Date.UTC(c.year, c.month - 1, c.day) - ((utcDay + 6) % 7) * MS_PER_DAY);
      return midnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    case "month":
      return midnight(c.year, c.month, 1);
    case "year":
      return midnight(c.year, 1, 1);
  }
}

/**
 * The next renewal boundary strictly after `from`, or `null` for a `never` budget.
 */
export function nextBoundary(rule: Renewal, from: number, createdAt: number): number | null {
  if (rule.type === "never") {
    return null;
  }

  if (rule.type === "interval") {
    // Tumbling: tile fixed-length windows forward from the anchor and take the next edge.
    const period = rule.seconds * 1000;
    const anchor = rule.anchor === undefined ? createdAt : Date.parse(rule.anchor);
    return anchor + (Math.floor((from - anchor) / period) + 1) * period;
  }

  const timezone = rule.timezone ?? "UTC";
  const interval = rule.interval ?? 1;
  const anchor =
    rule.anchor === undefined
      ? defaultAnchor(rule.unit, createdAt, timezone)
      : startOfDay(civilFromInstant(Date.parse(rule.anchor), timezone));

  // Snap an arithmetic estimate onto the interval lattice, then walk the few neighbours
  // around it. That gets us within one step regardless of how far back the anchor sits, so a
  // 20-month-old anchor costs the same as a 1-month-old one.
  const estimate = estimateIndex(rule.unit, anchor, civilFromInstant(from, timezone));
  const snapped = Math.floor(estimate / interval) * interval;
  for (let index = snapped - 2 * interval; index <= snapped + 3 * interval; index += interval) {
    const start = periodStart(index, rule.unit, anchor, timezone);
    if (start > from) {
      return start;
    }
  }
  return periodStart(snapped + 4 * interval, rule.unit, anchor, timezone);
}

function startOfDay(c: Civil): Civil {
  return midnight(c.year, c.month, c.day);
}
