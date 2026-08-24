import { describe, expect, it } from "vitest";

import type { TenantAuthorizationService } from "@vibeflow/authorization";
import {
  UniqueConstraintError,
  type ArtifactRepository,
  type ProjectProfileRepository,
} from "@vibeflow/persistence";

import { ProjectProfileError } from "./errors.js";
import { ProjectProfileService } from "./profile-service.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000011";
const PROJECT_ID = "00000000-0000-4000-8000-000000000012";

const allowAuthz = {
  authorize: async () => ({ allowed: true as const }),
} as unknown as TenantAuthorizationService;

describe("M-015 ProjectProfile initial CAS conflict", () => {
  it("normalizes a concurrent first-insert uniqueness race to ProjectProfileError", async () => {
    const profiles = {
      getProfileByProjectId: async () => undefined,
      upsertProfile: async () => {
        throw new UniqueConstraintError("unique constraint violated", "project_profiles_pkey");
      },
    } as unknown as ProjectProfileRepository;

    const artifacts = {} as ArtifactRepository;
    const service = new ProjectProfileService({
      profiles,
      artifacts,
      authz: allowAuthz,
    });

    await expect(
      service.updateProjectProfile({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        expectedVersion: 0,
        description: "first writer",
      }),
    ).rejects.toBeInstanceOf(ProjectProfileError);
  });
});
