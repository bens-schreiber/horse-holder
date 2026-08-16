import { Result, TaggedError } from "better-result";
import { z } from "zod";

import { Renewal } from "./renewal.ts";

/**
 * All HTTP headers used by the Horse Holder API.
 */
export const Header = {
  Authorization: "authorization",
  ContentType: "content-type",
  IdempotencyKey: "idempotency-key",
  Tenant: "hh-tenant",
  Group: "hh-group",
  ReservationId: "hh-reservation-id",
  TtlSeconds: "hh-ttl-seconds",
  RetryAfter: "retry-after",
} as const;

export type HeaderName = (typeof Header)[keyof typeof Header];

/**
 * Every API endpoint we serve, and the single method each accepts.
 */
export const Path = {
  // Horse Holder spec
  Charge: "/v1/charge",
  Reserve: "/v1/reserve",
  Commit: "/v1/commit",
  Release: "/v1/release",
  Budget: "/v1/budget",

  // Custom endpoints for account management and testing
  Keys: "/v1/keys",
  Whoami: "/v1/whoami",
} as const;

/** Every error code used by the Horse Holder API. */
export const Code = {
  InvalidRequest: "invalid_request",
  Unauthenticated: "unauthenticated",
  ReservationNotFound: "reservation_not_found",
  BudgetExceeded: "budget_exceeded",
  IdempotencyConflict: "idempotency_conflict",
  ReservationSettled: "reservation_settled",
  InternalError: "internal_error",
  MethodNotAllowed: "method_not_allowed",
  NotFound: "not_found",
} as const;

/**
 * identifier charset shared by
 * - budget IDs
 * - tenants
 * - groups.
 */
export const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** The maximum amount of budgets allowed in a single request body. */
export const REQUEST_MAX_BUDGETS = 16;

/**
 * The amount of time an idempotency key is retained (24 hours)
 */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

const Id = z.string().regex(ID_PATTERN, "must match [A-Za-z0-9_.-]{1,128}");
const Amount = z.number().min(0).max(Number.MAX_SAFE_INTEGER);

export const GroupHeader = Id;

/** A tenant MAY additionally be the empty string. */
export const TenantHeader = z.union([z.literal(""), Id]);

export const RequiredHeader = z.string().min(1);
export const IdempotencyKeyHeader = z.string().min(1).max(255);

export const RESERVATION_DEFAULT_TTL_SECONDS = 300;
export const RESERVATION_MAX_TTL_SECONDS = 86_400;

/** optional, and absent means our documented default. */
export const ReservationTtlSecondsHeader = z
  .union([z.null(), z.coerce.number().int().min(1).max(RESERVATION_MAX_TTL_SECONDS)])
  .transform((seconds) => seconds ?? RESERVATION_DEFAULT_TTL_SECONDS);

const Definition = z.strictObject({
  // A zero limit is rejected (division by zero is undefined)
  limit: z.number().positive().max(Number.MAX_SAFE_INTEGER),

  // thresholds are fractions strictly between zero and one, reported
  // in ascending order.
  warnings: z
    .array(z.number().gt(0).lt(1))
    .default([])
    .transform((warnings) => [...warnings].sort((a, b) => a - b)),
  renewal: Renewal,
});

function distinctIds(entries: { id: string }[]): boolean {
  return new Set(entries.map((e) => e.id)).size === entries.length;
}

export const DrawBody = z.strictObject({
  budgets: z
    .array(z.strictObject({ id: Id, amount: Amount, definition: Definition }))
    .min(1)
    .max(REQUEST_MAX_BUDGETS)
    .refine(distinctIds, "duplicate budget id"),
});

/**
 * Optional body for `/v1/commit`.
 * If omitted, every reserved amount is committed.
 */
export const CommitBody = z.strictObject({
  budgets: z
    .array(z.strictObject({ id: Id, amount: Amount }))
    .max(REQUEST_MAX_BUDGETS)
    .refine(distinctIds, "duplicate budget id")
    .prefault([]),
});

export type DrawEntry = z.infer<typeof DrawBody>["budgets"][number];
export type Definition = DrawEntry["definition"];
export type CommitEntry = z.infer<typeof CommitBody>["budgets"][number];

/**
 * A validated `/v1/charge` or `/v1/reserve`.
 *
 * IR for the Budget Durable Object.
 */
export interface Draw {
  key: string;
  entries: DrawEntry[];
}

/** What every `budgets` entry reports about a budget's state. */
export interface BudgetView {
  id: string;
  limit: number;
  used: number;
  remaining: number;
  renewsAt: string | null;
}

/**
 * A `budgets` entry on a draw or a settlement, which additionally reports the outcome.
 */
export interface DrawnBudgetView extends BudgetView {
  requested: number;
  exceeded: boolean;
  warningsCrossed: number[];
}

/** What one request did to one budget: the fields a `DrawnBudgetView` adds to a `BudgetView`. */
export type Outcome = Pick<DrawnBudgetView, "requested" | "exceeded" | "warningsCrossed">;

export type ErrorCode = (typeof Code)[keyof typeof Code];

/** Any error that this API can produce. */
export class ApiError extends TaggedError("ApiError")<{
  status: number;
  code: ErrorCode;
  message: string;
}> {
  static error(status: number, code: ErrorCode, message: string): ApiError {
    return new ApiError({ status, code, message });
  }

  /** 400 bad request */
  static invalid(message: string): ApiError {
    return ApiError.error(400, Code.InvalidRequest, message);
  }

  /**
   * Renders the error message as a Reply, suitable for sending to the client.
   */
  reply(extra?: Record<string, unknown>, headers?: Record<string, string>): Reply {
    return {
      status: this.status,
      body: { error: { code: this.code, message: this.message }, ...extra },
      ...(headers === undefined ? {} : { headers }),
    };
  }
}

/**
 * Validates `value` against `schema`, reporting any violation as a `ApiError.invalid`.
 */
export function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  subject: string,
): Result<T, ApiError> {
  const result = schema.safeParse(value);
  if (result.success) {
    return Result.ok(result.data);
  }
  const detail = result.error.issues
    .map((issue) => [issue.path.join("."), issue.message].filter((part) => part !== "").join(" "))
    .join("; ");
  return Result.err(ApiError.invalid(`${subject}: ${detail}`));
}

/** Validates one request header, naming it in any resulting error message. */
export function parseHeader<T>(
  request: Request,
  name: HeaderName,
  schema: z.ZodType<T>,
): Result<T, ApiError> {
  return parse(schema, request.headers.get(name), name);
}

/**
 * A response as plain data.
 */
export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Collapses a request's outcome into the response it describes. */
export function toResponse(result: Result<Reply, ApiError>): Response {
  const reply = result.match({ ok: (value) => value, err: (error) => error.reply() });
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { [Header.ContentType]: "application/json; charset=utf-8", ...reply.headers },
  });
}
