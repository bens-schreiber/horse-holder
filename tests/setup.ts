/**
 * Starts a server for the conformance suite to run against.
 *
 * This is the only file that knows what is being tested. By default it launches our
 * Cloudflare implementation with `wrangler dev` and hands the tests its URL; set
 * `HH_BASE_URL` and it steps aside, leaving the same suite to run over the network against
 * any other Horse Holder server.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestProject } from "vitest/node";

/** Fixed rather than ephemeral, so a stray dev server is easy to find and kill. */
const PORT = 8799;
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

declare module "vitest" {
  interface ProvidedContext {
    baseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<(() => void) | undefined> {
  const external = process.env["HH_BASE_URL"];
  if (external !== undefined && external !== "") {
    project.provide("baseUrl", external);
    return undefined;
  }

  // Durable Object and KV writes land here. It has to sit outside the repo: `wrangler dev` keeps
  // esbuild running in watch mode over the project tree, and the write storm this suite produces
  // against the default `site/.wrangler/state` retriggers the bundler until esbuild deadlocks and
  // takes the dev server down mid-run. A fresh directory per run also guarantees the suite starts
  // from empty state instead of inheriting budgets from the last one.
  const persistTo = mkdtempSync(join(tmpdir(), "horse-holder-spec-"));

  const server = spawn(
    "pnpm",
    [
      "--filter",
      "@horse-holder/site",
      "exec",
      "wrangler",
      "dev",
      "--port",
      String(PORT),
      "--persist-to",
      persistTo,
    ],
    {
      cwd: new URL("..", import.meta.url),
      // Its own process group: `wrangler dev` runs workerd as a child, and killing the group
      // is the only way to take both down.
      detached: true,
      stdio: "ignore",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );

  const baseUrl = `http://127.0.0.1:${PORT}`;
  await waitUntilServing(baseUrl, server);
  project.provide("baseUrl", baseUrl);

  return () => {
    if (server.pid !== undefined) {
      process.kill(-server.pid, "SIGTERM");
    }
  };
}

async function waitUntilServing(baseUrl: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`wrangler dev exited with code ${server.exitCode}`);
    }
    try {
      // Any answer means the Worker is serving; an unauthenticated 401 is a fine one.
      await fetch(`${baseUrl}/v1/whoami`);
      return;
    } catch {
      await delay(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`wrangler dev was not serving within ${READY_TIMEOUT_MS}ms`);
}
