/** Warning thresholds and the per-period high-water mark. */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

const WARNINGS = [0.5, 0.8, 0.95];

async function charge(
  group: string,
  amount: number,
  options: { limit?: number; warnings?: number[]; renewal?: Record<string, unknown> } = {},
): Promise<number[]> {
  const res = await post(
    harness,
    auth,
    "/v1/charge",
    {
      budgets: [
        entry(
          "b",
          amount,
          definition(options.limit ?? 100, {
            warnings: options.warnings ?? WARNINGS,
            ...(options.renewal === undefined ? {} : { renewal: options.renewal }),
          }),
        ),
      ],
    },
    { group, key: freshKey() },
  );
  const body = await readJson<{ budgets: { warningsCrossed: number[] }[] }>(res);
  return body.budgets[0]!.warningsCrossed;
}

describe("warnings", () => {
  it("is present and empty on every successful response", async () => {
    expect(await charge(freshGroup(), 10)).toEqual([]);
  });

  it("fires a threshold when usage reaches it", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    expect(await charge(group, 49), "49% is below the 0.5 threshold").toEqual([]);
    expect(await charge(group, 1), "reaching exactly 0.5 must fire it").toEqual([0.5]);
  });

  it("reports every threshold crossed by one draw, ascending", async () => {
    // Arrange
    const group = freshGroup();
    await charge(group, 40);

    // Assert
    expect(await charge(group, 50), "a jump from 40% to 90% crosses both 0.5 and 0.8").toEqual([
      0.5, 0.8,
    ]);
  });

  it("does not re-fire a threshold already crossed", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    expect(await charge(group, 60)).toEqual([0.5]);
    expect(await charge(group, 5), "0.5 fired a second time within one period").toEqual([]);
  });

  it("does not lower the high-water mark on a release", async () => {
    // Arrange
    const group = freshGroup();
    const reserved = await post(
      harness,
      auth,
      "/v1/reserve",
      {
        budgets: [entry("b", 60, definition(100, { warnings: WARNINGS }))],
      },
      { group, key: freshKey() },
    );
    const { reservationId } = await readJson<{ reservationId: string }>(reserved);

    // Act
    await post(harness, auth, "/v1/release", undefined, {
      group,
      headers: { "hh-reservation-id": reservationId },
    });

    // Assert
    expect(await charge(group, 60), "the mark fell back with usage, so 0.5 fired twice").toEqual(
      [],
    );
  });

  it("does not lower the high-water mark on a downward commit", async () => {
    // Arrange
    const group = freshGroup();
    const reserved = await post(
      harness,
      auth,
      "/v1/reserve",
      {
        budgets: [entry("b", 90, definition(100, { warnings: WARNINGS }))],
      },
      { group, key: freshKey() },
    );
    const { reservationId } = await readJson<{ reservationId: string }>(reserved);

    // Act
    await post(
      harness,
      auth,
      "/v1/commit",
      { budgets: [{ id: "b", amount: 10 }] },
      {
        group,
        headers: { "hh-reservation-id": reservationId },
      },
    );

    // Assert
    expect(
      await charge(group, 50),
      "the mark fell back to the committed amount, so 0.5 fired twice",
    ).toEqual([]);
  });

  it("resets the mark on renewal", async () => {
    // Arrange
    const group = freshGroup();
    const renewal = { type: "interval", seconds: 1 };
    expect(await charge(group, 60, { renewal })).toEqual([0.5]);

    // Act
    await new Promise((r) => setTimeout(r, 1100));

    // Assert
    expect(
      await charge(group, 60, { renewal }),
      "a threshold not yet seen in the new period stayed suppressed",
    ).toEqual([0.5]);
  });

  it("resets the mark on a limit change", async () => {
    // Arrange
    const group = freshGroup();
    expect(await charge(group, 60)).toEqual([0.5]);

    // Assert
    expect(await charge(group, 0, { limit: 200 }), "30% of the new limit is below 0.5").toEqual([]);
    expect(
      await charge(group, 100, { limit: 200 }),
      "thresholds are fractions of the limit, so a limit change must re-arm them",
    ).toEqual([0.5, 0.8]);
  });

  it("does not reset the mark on a warnings-only change", async () => {
    // Arrange
    const group = freshGroup();
    const warnings = [0.5, 0.55, 0.9];
    expect(await charge(group, 60)).toEqual([0.5]);

    // Assert
    expect(
      await charge(group, 0, { warnings }),
      "0.5 still means the same usage and must stay suppressed",
    ).toEqual([]);
    expect(await charge(group, 0, { warnings })).toEqual([]);
  });

  it("applies a newly added threshold below the mark only once it is re-crossed", async () => {
    // Arrange
    const group = freshGroup();
    await charge(group, 60, { warnings: [0.5] });

    // Assert
    expect(
      await charge(group, 30, { warnings: [0.5, 0.9] }),
      "0.9 sits above the mark of 0.6 and must fire when usage reaches it",
    ).toEqual([0.9]);
  });

  it("rejects thresholds outside the open interval (0, 1)", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const w of [0, 1, 1.5, -0.5]) {
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("b", 1, definition(100, { warnings: [w] }))],
        },
        { group, key: freshKey() },
      );
      expect(res.status, `threshold ${w}`).toBe(400);
    }
  });

  it("omits warningsCrossed from a 402", async () => {
    // Arrange
    const group = freshGroup();
    await charge(group, 100);

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 50, definition(100, { warnings: WARNINGS }))],
      },
      { group, key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(402);
    const body = await readJson<{ budgets: { warningsCrossed: number[] }[] }>(res);
    expect(
      body.budgets[0]!.warningsCrossed,
      "a denied draw crossed nothing and must report nothing",
    ).toEqual([]);
  });
});
