/**
 * Security headers on every response, and the origin check for the one browser form.
 */

import { defineMiddleware } from "astro:middleware";

const CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

const HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "geolocation=(), camera=(), microphone=()",
};

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Astro's global origin check is off, because `/v1/*` serves API clients that legitimately
  // POST from anywhere and authenticate with a bearer token. `/keys` is the one form a browser
  // submits, so it gets the check here instead.
  //
  // `sec-fetch-site` rather than `origin`: a form navigation sends `origin: null` in a
  // non-secure context, which is indistinguishable from a stripped one, while this header is
  // set by the browser itself and cannot be forged by a page. Requests without it are not
  // browsers, and they are refused here regardless.
  if (context.request.method === "POST" && !pathname.startsWith("/v1/")) {
    const site = context.request.headers.get("sec-fetch-site");
    if (site !== "same-origin" && site !== "none") {
      return new Response("cross-origin form submission refused", { status: 403 });
    }
  }

  const response = await next();

  for (const [name, value] of Object.entries(HEADERS)) {
    response.headers.set(name, value);
  }

  return response;
});
