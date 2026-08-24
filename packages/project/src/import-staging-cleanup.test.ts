import { describe, expect, it } from "vitest";

import type { TenantAuthorizationService } from "@vibeflow/authorization";
import type { ProjectLifecycleRepository } from "@vibeflow/persistence";

import { InMemoryArchiveStaging } from "./archive/staging.js";
import { validZipFixture } from "./archive/test-fixtures.js";
import { ProjectImportService } from "./import-service.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000021";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000022";

const allowAuthz = {
  authorize: async () => ({ allowed: true as const }),
} as unknown as TenantAuthorizationService;

function failingLifecycle(): ProjectLifecycleRepository {
  return {
    findArchiveImportByIdempotencyKey: async () => undefined,
    applyArchiveImport: async () => {
      throw new Error("database write failed");
    },
  } as unknown as ProjectLifecycleRepository;
}

describe("M-014 archive staging cleanup", () => {
  it("releases the attempt's staged claim when durable import creation fails", async () => {
    const staging = new InMemoryArchiveStaging();
    const service = new ProjectImportService({
      lifecycle: failingLifecycle(),
      authz: allowAuthz,
      staging,
    });

    await expect(
      service.importProjectArchive({
        accountId: ACCOUNT_ID,
        organizationId: ORGANIZATION_ID,
        projectName: "Failed Import",
        archive: validZipFixture(),
        format: "zip",
        idempotencyKey: "failed-import",
      }),
    ).rejects.toThrow("database write failed");

    expect(staging.size).toBe(0);
  });

  it("does not delete a shared content-addressed blob retained by another claim", async () => {
    const staging = new InMemoryArchiveStaging();
    const archive = validZipFixture();
    const retainedRef = await staging.put(archive);

    const service = new ProjectImportService({
      lifecycle: failingLifecycle(),
      authz: allowAuthz,
      staging,
    });

    await expect(
      service.importProjectArchive({
        accountId: ACCOUNT_ID,
        organizationId: ORGANIZATION_ID,
        projectName: "Shared Failed Import",
        archive,
        format: "zip",
        idempotencyKey: "shared-failed-import",
      }),
    ).rejects.toThrow("database write failed");

    expect(staging.size).toBe(1);
    expect(staging.claimCount(retainedRef)).toBe(1);
    expect(await staging.get(retainedRef)).toEqual(archive);
  });
});
