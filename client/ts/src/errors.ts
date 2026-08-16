/**
 * The one error type, and the codes servers use to name what went wrong.
 */

/**
 * The error codes every server is expected to use.
 *
 * A server may define codes beyond these, which is why {@link HorseHolderError.code} is a
 * plain `string`. Use this when you want the standard ones spelled out:
 *
 * ```ts
 * if (isHorseHolderError(error) && error.code === "unauthenticated") {
 *   await refreshCredentials();
 * }
 * ```
 */
export type ErrorCode =
  | "budget_exceeded"
  | "forbidden"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "internal_error"
  | "invalid_request"
  | "method_not_allowed"
  | "not_found"
  | "reservation_not_found"
  | "reservation_settled"
  | "unauthenticated";

/**
 * Something went wrong: bad credentials, a malformed request, a server on fire, a network that
 * dropped.
 *
 * Notably *not* thrown when you run out of budget. Being told "no, you cannot afford that" is
 * the client working correctly and the reason you called in the first place, so it comes back
 * as a value you check.
 *
 * There is one error class rather than a family of subclasses, because servers can define
 * their own codes and a fixed set of subclasses would have nowhere to put those. Branch on
 * {@link HorseHolderError.code} instead:
 *
 * ```ts
 * try {
 *   await lease.commit();
 * } catch (error) {
 *   if (isHorseHolderError(error) && error.code === "reservation_not_found") {
 *     // the hold already expired, so nothing is being held for us anymore
 *   }
 *   throw error;
 * }
 * ```
 */
export class HorseHolderError extends Error {
  /** The HTTP status, or `null` if we never got a response at all. */
  readonly status: number | null;

  /**
   * A short machine-readable string naming what went wrong, like `"unauthenticated"`.
   *
   * Typed as `string` rather than {@link ErrorCode} because servers may define their own. When
   * the request never made it out, this is `"network_error"` or `"timeout"`.
   */
  readonly code: string;

  /** The response body, if there was one. Handy when a server includes extra detail. */
  readonly body: unknown;

  constructor(options: {
    status: number | null;
    code: string;
    message: string;
    body?: unknown;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "HorseHolderError";
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
  }
}

/**
 * Checks whether a caught value came from this client.
 *
 * Use this rather than `instanceof`, which quietly stops working if two copies of the package
 * end up installed together.
 *
 * ```ts
 * catch (error) {
 *   if (isHorseHolderError(error)) {
 *     console.error(error.status, error.code);
 *   }
 * }
 * ```
 */
export function isHorseHolderError(value: unknown): value is HorseHolderError {
  return value instanceof Error && value.name === "HorseHolderError";
}

/** Everything this client rejects before a request goes out reports it the same way. */
export function invalid(message: string): never {
  throw new HorseHolderError({ status: null, code: "invalid_request", message });
}
