/**
 * M-015 Project Profile authority service.
 *
 * Subordinate Project-domain state: optional description and optional cover
 * Artifact reference. The cover Artifact MUST belong to the same canonical
 * Project, enforced at the database level by a composite FK.
 */

import {
  isUuid,
  NotFoundError,
  type ArtifactRepository,
  type ArtifactRow,
  ProjectProfileRepository,
  StaleVersionError,
  UniqueConstraintError,
} from "@vibeflow/persistence";
import { TenantAuthorizationService } from "@vibeflow/authorization";

import { ProjectInputError, ProjectNotFoundError, ProjectProfileError } from "./errors.js";

export interface ProjectProfileServiceOptions {
  profiles: ProjectProfileRepository;
  artifacts: ArtifactRepository;
  authz: TenantAuthorizationService;
}

export interface GetProjectProfileInput {
  accountId: string;
  projectId: string;
}

export interface UpdateProjectProfileInput {
  accountId: string;
  projectId: string;
  expectedVersion: number;
  description?: string | null;
  coverArtifactId?: string | null;
}

export interface ProjectProfileResult {
  projectId: string;
  description: string | null;
  coverArtifactId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

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

function requireDescription(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ProjectInputError("description must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length > 5000) {
    throw new ProjectInputError("description must be 5000 characters or fewer");
  }
  return trimmed.length > 0 ? trimmed : null;
}

export class ProjectProfileService {
  public constructor(private readonly options: ProjectProfileServiceOptions) {}

  public async getProjectProfile(input: GetProjectProfileInput): Promise<ProjectProfileResult> {
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
      throw new ProjectProfileError("Project profile read denied: " + decision.reason);
    }

    const profile = await this.options.profiles.getProfileByProjectId(projectId);

    if (!profile) {
      return {
        projectId,
        description: null,
        coverArtifactId: null,
        version: 0,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    }

    return {
      projectId: profile.projectId,
      description: profile.description,
      coverArtifactId: profile.coverArtifactId,
      version: profile.version,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  public async updateProjectProfile(input: UpdateProjectProfileInput): Promise<ProjectProfileResult> {
    const accountId = requireUuid("accountId", input.accountId);
    const projectId = requireUuid("projectId", input.projectId);
    const expectedVersion = requireVersion("expectedVersion", input.expectedVersion);

    const decision = await this.options.authz.authorize({
      accountId,
      action: "update",
      resource: { type: "project", id: projectId },
    });

    if (!decision.allowed) {
      if (decision.reason === "unknown_resource") {
        throw new ProjectNotFoundError("Project not found: " + projectId);
      }
      throw new ProjectProfileError("Project profile update denied: " + decision.reason);
    }

    const existing = await this.options.profiles.getProfileByProjectId(projectId);

    let effectiveDescription: string | null;
    if (input.description === undefined) {
      effectiveDescription = existing ? existing.description : null;
    } else {
      effectiveDescription = requireDescription(input.description);
    }

    let effectiveCoverArtifactId: string | null;
    if (input.coverArtifactId === undefined) {
      effectiveCoverArtifactId = existing ? existing.coverArtifactId : null;
    } else if (input.coverArtifactId === null) {
      effectiveCoverArtifactId = null;
    } else {
      effectiveCoverArtifactId = requireUuid("coverArtifactId", input.coverArtifactId);
    }

    if (effectiveCoverArtifactId !== null) {
      const artifactDecision = await this.options.authz.authorize({
        accountId,
        action: "read",
        resource: { type: "artifact", id: effectiveCoverArtifactId },
      });

      if (!artifactDecision.allowed) {
        if (artifactDecision.reason === "unknown_resource") {
          throw new ProjectNotFoundError("Artifact not found: " + effectiveCoverArtifactId);
        }
        throw new ProjectProfileError("Cover artifact access denied: " + artifactDecision.reason);
      }

      let coverArtifact: ArtifactRow;
      try {
        coverArtifact = await this.options.artifacts.getArtifactById(effectiveCoverArtifactId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new ProjectNotFoundError("Cover artifact not found: " + effectiveCoverArtifactId);
        }
        throw error;
      }

      if (coverArtifact.projectId !== projectId) {
        throw new ProjectProfileError("Cover artifact must belong to the same canonical Project");
      }
    }

    try {
      const profile = await this.options.profiles.upsertProfile({
        projectId,
        expectedVersion,
        description: effectiveDescription,
        coverArtifactId: effectiveCoverArtifactId,
      });

      return {
        projectId: profile.projectId,
        description: profile.description,
        coverArtifactId: profile.coverArtifactId,
        version: profile.version,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      };
    } catch (error) {
      if (error instanceof StaleVersionError || error instanceof UniqueConstraintError) {
        throw new ProjectProfileError("Project profile update failed: version conflict");
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
