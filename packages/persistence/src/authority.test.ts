import { describe, expect, it } from "vitest";

import {
  DuplicateMembershipError,
  ForeignKeyViolationError,
  PersistenceError,
  PersistenceInputError,
  ProviderAuthorityRejectedError,
  mapDatabaseError,
  rejectProviderAuthority,
} from "./errors.js";
import { requireId } from "./ids.js";
import { ORGANIZATION_KINDS, TENANT_TABLES } from "./schema.js";

describe("M-008 persistence authority boundary", () => {
  it("does not store provider or client identity columns", () => {
    const columnNames = [
      ...Object.keys(TENANT_TABLES.accounts),
      ...Object.keys(TENANT_TABLES.organizations),
      ...Object.keys(TENANT_TABLES.organizationMemberships),
    ].join(" ");
    expect(columnNames).not.toMatch(/provider/i);
    expect(columnNames).not.toMatch(/external_id/i);
    expect(columnNames).not.toMatch(/clientTenant/i);
    expect(columnNames).not.toMatch(/role/i);
    expect(columnNames).not.toMatch(/password/i);
    expect(columnNames).not.toMatch(/session/i);
  });

  it("rejects client/provider IDs as authority", () => {
    expect(() => rejectProviderAuthority({ providerId: "prov_1" })).toThrow(
      ProviderAuthorityRejectedError,
    );
    expect(() => rejectProviderAuthority({ external_id: "ext-9" })).toThrow(
      ProviderAuthorityRejectedError,
    );
    expect(() => rejectProviderAuthority({ displayName: "Ada" })).not.toThrow();
  });

  it("requires canonical UUID identifiers at the repository boundary", () => {
    expect(() => requireId("organizationId", "")).toThrow(PersistenceInputError);
    expect(() => requireId("organizationId", "not-a-uuid")).toThrow(PersistenceInputError);
    expect(() => requireId("organizationId", "org-from-client")).toThrow(PersistenceInputError);
    expect(requireId("organizationId", "11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("treats personal as an organization kind, not a separate authority", () => {
    expect(ORGANIZATION_KINDS).toEqual(["personal", "standard"]);
  });

  it("maps PostgreSQL unique/FK codes through drizzle-wrapped causes", () => {
    const unique = Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint: "organization_memberships_org_account_uidx",
      }),
    });
    expect(() => mapDatabaseError(unique)).toThrow(DuplicateMembershipError);

    const missing = Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("fk"), { code: "23503" }),
    });
    expect(() => mapDatabaseError(missing)).toThrow(ForeignKeyViolationError);

    expect(() => mapDatabaseError(new Error("connection refused"))).toThrow(PersistenceError);
  });
});
