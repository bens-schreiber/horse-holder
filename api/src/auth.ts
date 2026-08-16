/**
 * Authentication for all Horse Holder API requests.
 *
 * Every request carries an authorization header with a bearer token.
 * The token is a random string, and the KV store holds only its SHA-256 hash.
 *
 * Authentication resolves the token to an account ID, which is the scope of the request.
 *
 * The KV `API_KEYS` namespace holds the mapping from token hash to account ID.
 */

import { Result } from "better-result";
import { ApiError, Code, Header, type Reply } from "./schema.ts";

/** Keeps the API key cache fresh so repeat requests don't hit the database. */
const KEY_CACHE_TTL_SECONDS = 300;

/**
 * Resolves a bearer token to an account ID.
 *
 * @returns The account ID if the token is valid, or an ApiError if it is not.
 */
export async function authenticate(request: Request, env: Env): Promise<Result<string, ApiError>> {
  function unauthorized(message: string): ApiError {
    return new ApiError({ status: 401, code: Code.Unauthenticated, message });
  }

  const BEARER = "Bearer ";
  const header = request.headers.get(Header.Authorization) ?? "";
  const token = header.startsWith(BEARER) ? header.slice(BEARER.length) : "";
  if (token === "") {
    return Result.err(unauthorized("missing bearer token"));
  }

  const name = await keyName(token);
  const record = await env.API_KEYS.get<{ accountId: string }>(name, {
    type: "json",
    cacheTtl: KEY_CACHE_TTL_SECONDS,
  });

  return record === null
    ? Result.err(unauthorized("unknown or revoked API key"))
    : Result.ok(record.accountId);
}

/**
 * Issues a fresh account and its first API key.
 */
export async function issueKey(env: Env): Promise<Reply> {
  function randomToken(bytes: number): string {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return btoa(String.fromCharCode(...buffer))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  }

  // Charset `[A-Za-z0-9_]`
  const accountId = `acct_${randomToken(12).replaceAll("-", "_")}`;
  const apiKey = `hh_sk_${randomToken(32)}`;

  const name = await keyName(apiKey);
  await env.API_KEYS.put(name, JSON.stringify({ accountId, createdAt: new Date().toISOString() }));

  return { status: 201, body: { accountId, apiKey } };
}

/**
 * Generates a key name for the given token.
 *
 * @param token The token for which to generate a key name.
 * @returns The key name for the given token, which is the SHA-256 hash of the token prefixed with "k:".
 */
async function keyName(token: string): Promise<string> {
  const KEY_PREFIX = "k:";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return KEY_PREFIX + hex;
}
