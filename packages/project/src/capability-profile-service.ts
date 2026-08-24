/**
 * M-015 ProjectCapabilityProfile authority service.
 *
 * VibeFlow-owned, provider-neutral Project state representing the Project's
 * normalized capability/trait manifest. NOT a ProviderCapability, provider
 * capability discovery, binding health, workspace capability negotiation,
 * provider advertisement, or credential/configuration surface.
 */

import {
  isCapabilityKeyToken,
  isUuid,
  CAPABILITY_KEY_MAX_LENGTH,
  ProjectCapabilityRepository,
  StaleVersionError,
} from "@vibeflow/persistence";
import { TenantAuthorizationService } from "@vibeflow/authorization";

import { ProjectInputError, ProjectNotFoundError, ProjectCapabilityProfileError } from "./errors.js";

export interface ProjectCapabilityProfileServiceOptions {
  capabilities: ProjectCapabilityRepository;
  authz: TenantAuthorizationService;
}

export interface GetProjectCapabilityProfileInput {
  accountId: string;
  projectId: string;
}

export interface ReplaceProjectCapabilityProfileInput {
  accountId: string;
  projectId: string;
  expectedVersion: number;
  capabilities: readonly string[];
}

export interface ProjectCapabilityProfileResult {
  projectId: string;
  capabilities: readonly string[];
  version: number;
  createdAt: Date | null;
}

const STABLE_READ_MAX_ATTEMPTS = 8;

function requireUuid(name: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectInputError(name + " is required");
  }
  if (!isUuid(value)) {
    throw new ProjectInputError(name + " must be a UUID");
  }
  return value;
}

function requireVersion(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ProjectInputError(name + " must be a non-negative integer");
  }
  return value;
}

function requireCapabilityTokens(capabilities: readonly string[]): string[] {
  if (!Array.isArray(capabilities)) {
    throw new ProjectInputError("capabilities must be an array");
  }
  const valid: string[] = [];
  for (const raw of capabilities) {
    if (typeof raw !== "string") {
      throw new ProjectInputError("each capability must be a string");
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new ProjectInputError("capability key must not be empty");
    }
    if (trimmed.length > CAPABILITY_KEY_MAX_LENGTH) {
      throw new ProjectInputError("capability key must be " + CAPABILITY_KEY_MAX_LENGTH + " characters or fewer");
    }
    if (!isCapabilityKeyToken(trimmed)) {
      throw new ProjectInputError("capability key must be two or more lower-case '/' separated segments");
    }
    valid.push(trimmed);
  }
  return valid;
}

export class ProjectCapabilityProfileService {
  public constructor(private readonly options: ProjectCapabilityProfileServiceOptions) {}

  /**
   * Read one logically coherent capability profile without requiring a wider
   * repository transaction API. The durable capability-profile version is
   * monotonic, so version -> rows -> version is a seqlock: if both version
   * reads agree, no replacement committed while the rows were being observed.
   */
  private async readStableProfile(projectId: string): Promise<ProjectCapabilityProfileResult> {
    for (let attempt = 0; attempt < STABLE_READ_MAX_ATTEMPTS; attempt += 1) {
      const versionBefore = await this.options.capabilities.getVersionByProjectId(projectId);
      const rows = await this.options.capabilities.getCapabilitiesByProjectId(projectId);
      const versionAfter = await this.options.capabilities.getVersionByProjectId(projectId);

      if (versionBefore === versionAfter) {
        return {
          projectId,
          capabilities: rows.map((row) => row.capabilityKey),
          version: versionAfter,
          createdAt: rows.length > 0 ? rows[0]!.createdAt : null,
        };
      }
    }

    throw new ProjectCapabilityProfileError(
      "Capability profile changed continuously during read; retry the request",
    );
  }

  public async getProjectCapabilityProfile(
    input: GetProjectCapabilityProfileInput,
  ): Promise<ProjectCapabilityProfileResult> {
    const accountId = requireUuid("accountId", input.accountId);
    const projectId = requireUuid("projectId", input.projectId);

    const decision = await this.options.authz.authorize({
      accountId,
      action: "read",
      resource: { type: "project", id: projectId },
    });

    if (!decision.allowed) {
      if (decision.reason === "unknown_resource") {
        throw new ProjectNotFoundError("Project not found: " + projectId);
      }
      throw new ProjectCapabilityProfileError("Capability profile read denied: " + decision.reason);
    }

    return this.readStableProfile(projectId);
  }

  public async replaceProjectCapabilityProfile(
    input: ReplaceProjectCapabilityProfileInput,
  ): Promise<ProjectCapabilityProfileResult> {
    const accountId = requireUuid("accountId", input.accountId);
    const projectId = requireUuid("projectId", input.projectId);
    const expectedVersion = requireVersion("expectedVersion", input.expectedVersion);
    const capabilities = requireCapabilityTokens(input.capabilities);

    const decision = await this.options.authz.authorize({
      accountId,
      action: "update",
      resource: { type: "project", id: projectId },
    });

    if (!decision.allowed) {
      if (decision.reason === "unknown_resource") {
        throw new ProjectNotFoundError("Project not found: " + projectId);
      }
      throw new ProjectCapabilityProfileError("Capability profile update denied: " + decision.reason);
    }

    try {
      const rows = await this.options.capabilities.replaceCapabilities({
        projectId,
        expectedVersion,
        capabilities,
      });

      // replaceCapabilities commits exactly one CAS transition from
      // expectedVersion to expectedVersion + 1. Do not reread the durable
      // version after commit: another writer may already have advanced it,
      // which would pair this writer's rows with a different writer's token.
      return {
        projectId,
        capabilities: rows.map((row) => row.capabilityKey),
        version: expectedVersion + 1,
        createdAt: rows.length > 0 ? rows[0]!.createdAt : null,
      };
    } catch (error) {
      if (error instanceof StaleVersionError) {
        throw new ProjectCapabilityProfileError("Capability profile replace failed: " + error.message);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
