import { describe, expect, it } from "vitest";

import { InMemoryArchiveStaging } from "./staging.js";

describe("M-014 archive staging claim lifecycle", () => {
  it("keeps shared content until the final claim is released", async () => {
    const staging = new InMemoryArchiveStaging();
    const bytes = Buffer.from("shared archive bytes");

    const first = await staging.put(bytes);
    const second = await staging.put(bytes);

    expect(second).toBe(first);
    expect(staging.size).toBe(1);
    expect(staging.claimCount(first)).toBe(2);

    await staging.release(first);
    expect(staging.claimCount(first)).toBe(1);
    expect(await staging.get(first)).toEqual(bytes);

    await staging.release(first);
    expect(staging.claimCount(first)).toBe(0);
    expect(staging.size).toBe(0);
    expect(await staging.get(first)).toBeUndefined();
  });

  it("force delete clears content and claims", async () => {
    const staging = new InMemoryArchiveStaging();
    const ref = await staging.put(Buffer.from("temporary"));

    await staging.delete(ref);

    expect(staging.claimCount(ref)).toBe(0);
    expect(await staging.get(ref)).toBeUndefined();
  });
});
