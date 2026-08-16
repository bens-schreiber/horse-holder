/**
 * Authentication for all Horse Holder API requests.
 *
 * Every request carries an authorization header with a bearer token. The token is a random
 * string, and the KV store holds only its SHA-256 hash, so a dump of the namespace yields
 * nothing anyone can authenticate with.
 *
 * Authentication resolves a token to an account ID, which is the scope of the request.
 */

import { Result } from "better-result";
import { ApiError, Code, Header, type Reply } from "./schema.ts";

/** Keeps the API key cache fresh so repeat requests don't hit the database. */
const KEY_CACHE_TTL_SECONDS = 300;

const BEARER = "Bearer ";
const KEY_PREFIX = "k:";
const ENCODER = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/** Resolves a bearer token to the account ID it was issued for. */
export async function authenticate(request: Request, env: Env): Promise<Result<string, ApiError>> {
  const header = request.headers.get(Header.Authorization) ?? "";
  const token = header.startsWith(BEARER) ? header.slice(BEARER.length) : "";
  if (token === "") {
    return Result.err(unauthorized("missing bearer token"));
  }

  const record = await env.API_KEYS.get<{ accountId: string }>(await keyName(token), {
    type: "json",
    cacheTtl: KEY_CACHE_TTL_SECONDS,
  });

  return record === null
    ? Result.err(unauthorized("unknown or revoked API key"))
    : Result.ok(record.accountId);
}

/** Issues a fresh account and its first API key. */
export async function issueKey(env: Env): Promise<Reply> {
  // Charset `[A-Za-z0-9_]`, so an account ID is itself a legal identifier.
  const accountId = `acct_${randomToken(12).replaceAll("-", "_")}`;
  const apiKey = `hh_sk_${randomToken(32)}`;

  await env.API_KEYS.put(
    await keyName(apiKey),
    JSON.stringify({ accountId, createdAt: new Date().toISOString() }),
  );

  return { status: 201, body: { accountId, apiKey } };
}

function unauthorized(message: string): ApiError {
  return ApiError.error(401, Code.Unauthenticated, message);
}

/** Where a token's record lives: its SHA-256, hex encoded, under the key prefix. */
async function keyName(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(token));
  let hex = KEY_PREFIX;
  for (const byte of new Uint8Array(digest)) {
    hex += HEX[byte];
  }
  return hex;
}

function randomToken(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return btoa(String.fromCharCode(...buffer))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
