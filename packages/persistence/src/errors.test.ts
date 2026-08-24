import { describe, expect, it } from "vitest";

import {
  DuplicateMembershipError,
  mapDatabaseError,
  UniqueConstraintError,
} from "./errors.js";

describe("persistence PostgreSQL uniqueness mapping", () => {
  it("maps only the membership unique constraint to DuplicateMembershipError", () => {
    expect(() =>
      mapDatabaseError({
        code: "23505",
        constraint: "organization_memberships_org_account_uidx",
      }),
    ).toThrow(DuplicateMembershipError);
  });

  it("preserves non-membership uniqueness as a generic constraint error", () => {
    let caught: unknown;
    try {
      mapDatabaseError({ code: "23505", constraint: "project_profiles_pkey" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UniqueConstraintError);
    expect((caught as UniqueConstraintError).constraint).toBe("project_profiles_pkey");
  });
});
