/**
 * When a budget's usage resets back to zero.
 *
 * These are plain objects, so a shape the {@link renewal} helpers do not cover can be written
 * out longhand.
 */

/** A budget that never resets. Usage piles up forever and `renewsAt` is always `null`. */
export interface NeverRenewal {
  readonly type: "never";
}

/** A budget that resets every N seconds, counting from `anchor`. */
export interface IntervalRenewal {
  readonly type: "interval";
  /** Window length in seconds. Must be a positive whole number. */
  readonly seconds: number;
  /** When to start counting windows from. Defaults to when the budget was first created. */
  readonly anchor?: string | undefined;
}

/** The calendar units a budget can line up with. */
export type CalendarUnit = "day" | "week" | "month" | "year";

/** A budget that resets on calendar boundaries: every day, week, month, or year. */
export interface CalendarRenewal {
  readonly type: "calendar";
  readonly unit: CalendarUnit;
  /** How many units per period. `unit: "week", interval: 2` means every two weeks. */
  readonly interval?: number | undefined;
  /** Which timezone's calendar to use. Defaults to UTC. */
  readonly timezone?: string | undefined;
  /** Shifts the cycle: which day of the month, which weekday, which month of the year. */
  readonly anchor?: string | undefined;
}

/**
 * When a budget's usage resets.
 *
 * ```ts
 * renewal.monthly({ timezone: "America/Chicago" })
 * // is just
 * { type: "calendar", unit: "month", timezone: "America/Chicago" }
 * ```
 */
export type Renewal = NeverRenewal | IntervalRenewal | CalendarRenewal;

/** Options shared by the calendar helpers. */
export interface CalendarOptions {
  /**
   * Which timezone's calendar to use. Defaults to UTC.
   *
   * Worth setting whenever a person is going to look at this budget and have an opinion about
   * when it reset. A "daily" budget on a UTC server resets at 6pm for a customer in Chicago,
   * which they will experience as their quota mysteriously vanishing in the evening.
   */
  readonly timezone?: string | undefined;
  /** How many units per period. `2` with `renewal.weekly` means fortnightly. */
  readonly interval?: number | undefined;
  /** Shifts the cycle. Defaults to the natural start: the 1st, Monday, January. */
  readonly anchor?: string | undefined;
}

/**
 * Shorthand for the ways a budget can reset.
 *
 * ```ts
 * renewal.never()                                   // a lifetime cap
 * renewal.seconds(3600)                             // resets every hour on the hour
 * renewal.daily({ timezone: "America/Chicago" })    // resets at Chicago midnight
 * renewal.monthly({ timezone: "America/Chicago" })  // resets on the 1st, Chicago time
 * renewal.weekly({ interval: 2 })                   // resets every other Monday, UTC
 * ```
 */
export const renewal = {
  /**
   * Never resets. Good for a trial allotment or a lifetime cap.
   *
   * ```ts
   * { limit: 100, renewal: renewal.never() }  // 100 total, ever
   * ```
   */
  never(): NeverRenewal {
    return { type: "never" };
  },

  /**
   * Resets every `seconds` seconds.
   *
   * These are fixed windows, not rolling ones. At each boundary usage drops straight back to
   * zero, so a 60 second budget of 10 allows 10 in the first minute and another 10 in the
   * next, even if they all land within a few seconds of each other across the boundary. If you
   * want smoother behavior, declare a short budget and a long one in the same group and draw
   * them together:
   *
   * ```ts
   * budgets: {
   *   "per-minute": { limit: 100, renewal: renewal.seconds(60) },
   *   "per-day": { limit: 10_000, renewal: renewal.daily() },
   * }
   * ```
   */
  seconds(seconds: number, options: { anchor?: string | undefined } = {}): IntervalRenewal {
    return { type: "interval", seconds, anchor: options.anchor };
  },

  /** Resets at midnight. Pass a timezone, since UTC midnight is rarely the one you mean. */
  daily(options: CalendarOptions = {}): CalendarRenewal {
    return { type: "calendar", unit: "day", ...options };
  },

  /** Resets weekly, on Monday unless you pass an `anchor` on some other weekday. */
  weekly(options: CalendarOptions = {}): CalendarRenewal {
    return { type: "calendar", unit: "week", ...options };
  },

  /**
   * Resets monthly, on the 1st unless you pass an `anchor` on some other day.
   *
   * Anchoring to the 31st does the sensible thing in short months: it uses the last day
   * available, then goes back to the 31st afterward rather than permanently sliding to the
   * 28th.
   */
  monthly(options: CalendarOptions = {}): CalendarRenewal {
    return { type: "calendar", unit: "month", ...options };
  },

  /** Resets yearly, on January 1st unless you pass an `anchor` in some other month. */
  yearly(options: CalendarOptions = {}): CalendarRenewal {
    return { type: "calendar", unit: "year", ...options };
  },
} as const;
