/**
 * The seam between the conformance suite and a particular server.
 *
 * Every test file speaks plain HTTP through this object and knows nothing else about who is
 * answering, so any conforming Horse Holder implementation can be tested by pointing
 * `HH_BASE_URL` at it. `setup.ts` starts ours when that variable is absent.
 *
 * The one implementation-defined thing the suite needs is a fresh scope, since the protocol
 * leaves authentication open. Ours mints one through the `/v1/keys` extension; another server
 * substitutes its own equivalent here.
 */

import { inject } from "vitest";

export interface Harness {
  /** Headers granting access to a fresh, empty, isolated scope. */
  newScope(): Promise<Record<string, string>>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

const baseUrl = inject("baseUrl");

export const harness = {
  async newScope() {
    const res = await harness.fetch("/v1/keys", { method: "POST" });
    if (res.status !== 201) {
      throw new Error(`key issuance failed: ${res.status}`);
    }
    const { apiKey } = (await res.json()) as { apiKey: string };
    return { authorization: `Bearer ${apiKey}` };
  },

  fetch(path, init) {
    return fetch(new URL(path, baseUrl), init);
  },
} satisfies Harness;
