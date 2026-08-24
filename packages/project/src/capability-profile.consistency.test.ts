import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { TenantAuthorizationService } from "@vibeflow/authorization";
import type {
  ProjectCapabilityRepository,
  ProjectCapabilityRow,
} from "@vibeflow/persistence";

import { ProjectCapabilityProfileService } from "./capability-profile-service.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";

function capabilityRow(key: string, version: number): ProjectCapabilityRow {
  return {
    id: randomUUID(),
    projectId: PROJECT_ID,
    capabilityKey: key,
    version,
    createdAt: new Date("2026-08-21T00:00:00Z"),
  };
}

const allowAuthz = {
  authorize: async () => ({ allowed: true as const }),
} as unknown as TenantAuthorizationService;

describe("M-015 ProjectCapabilityProfile coherent response semantics", () => {
  it("retries a read when the durable version changes around the row query", async () => {
    const versions = [1, 2, 2, 2];
    let rowReads = 0;
    const repository = {
      getVersionByProjectId: async () => {
        const next = versions.shift();
        if (next === undefined) {
          throw new Error("unexpected version read");
        }
        return next;
      },
      getCapabilitiesByProjectId: async () => {
        rowReads += 1;
        return rowReads === 1
          ? [capabilityRow("runtime/old", 1)]
          : [capabilityRow("runtime/new", 2)];
      },
    } as unknown as ProjectCapabilityRepository;

    const service = new ProjectCapabilityProfileService({
      capabilities: repository,
      authz: allowAuthz,
    });

    const result = await service.getProjectCapabilityProfile({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
    });

    expect(rowReads).toBe(2);
    expect(result.version).toBe(2);
    expect(result.capabilities).toEqual(["runtime/new"]);
  });

  it("returns the CAS version committed by this writer without a post-commit reread", async () => {
    const repository = {
      replaceCapabilities: async () => [capabilityRow("runtime/node", 4)],
      getVersionByProjectId: async () => {
        throw new Error("write response must not reread mutable version state");
      },
    } as unknown as ProjectCapabilityRepository;

    const service = new ProjectCapabilityProfileService({
      capabilities: repository,
      authz: allowAuthz,
    });

    const result = await service.replaceProjectCapabilityProfile({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      expectedVersion: 3,
      capabilities: ["runtime/node"],
    });

    expect(result.version).toBe(4);
    expect(result.capabilities).toEqual(["runtime/node"]);
  });
});
