/**
 * M-015 Project Overview / E2E read model.
 *
 * Tenant-safe Project-domain aggregate suitable for the FE-002
 * "Project Overview" read contract. Returns a server-derived projection from
 * one PostgreSQL REPEATABLE READ snapshot.
 *
 * This is a read model / projection, NOT a canonical resource.
 * No provider bindings, Task/Execution/Release are fabricated here.
 */

import {
  isUuid,
  NotFoundError,
  ProjectOverviewRepository,
  type ArtifactRelationRow,
  type ArtifactRow,
  type ProjectOverviewSnapshot,
} from "@vibeflow/persistence";
import { TenantAuthorizationService } from "@vibeflow/authorization";
import type { ProjectProfileResult } from "./profile-service.js";
import type { ProjectCapabilityProfileResult } from "./capability-profile-service.js";
import { ProjectNotFoundError, ProjectOverviewError } from "./errors.js";

export interface ProjectOverviewServiceOptions {
  overview: ProjectOverviewRepository;
  authz: TenantAuthorizationService;
}

export interface GetProjectOverviewInput {
  accountId: string;
  projectId: string;
}

export interface ImportProvenance {
  importId: string;
  archiveFormat: string;
  archiveSha256: string;
  archiveByteSize: number;
  importedAt: Date;
}

export interface CloneProvenance {
  clonePlanId: string;
  sourceProjectId: string;
  targetProjectId: string;
  clonedAt: Date;
}

export interface ProjectOverview {
  project: {
    id: string;
    organizationId: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
  };
  profile: ProjectProfileResult;
  capabilityProfile: ProjectCapabilityProfileResult;
  artifacts: ArtifactRow[];
  artifactRelations: ArtifactRelationRow[];
  importProvenance: ImportProvenance | null;
  cloneProvenance: CloneProvenance | null;
}

function requireUuid(name: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectOverviewError(name + " is required");
  }
  if (!isUuid(value)) {
    throw new ProjectOverviewError(name + " must be a UUID");
  }
  return value;
}

export class ProjectOverviewService {
  public constructor(private readonly options: ProjectOverviewServiceOptions) {}

  public async getProjectOverview(
    input: GetProjectOverviewInput,
  ): Promise<ProjectOverview> {
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
      throw new ProjectOverviewError("Project overview denied: " + decision.reason);
    }

    let snapshot: ProjectOverviewSnapshot;
    try {
      snapshot = await this.options.overview.getSnapshot(projectId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ProjectNotFoundError("Project not found: " + projectId);
      }
      // Infrastructure/query failures are not valid empty Project state.
      throw error;
    }

    const profile: ProjectProfileResult = snapshot.profile
      ? {
          projectId: snapshot.profile.projectId,
          description: snapshot.profile.description,
          coverArtifactId: snapshot.profile.coverArtifactId,
          version: snapshot.profile.version,
          createdAt: snapshot.profile.createdAt,
          updatedAt: snapshot.profile.updatedAt,
        }
      : {
          projectId,
          description: null,
          coverArtifactId: null,
          version: 0,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };

    const capabilityProfile: ProjectCapabilityProfileResult = {
      projectId,
      capabilities: snapshot.capabilities.map((row) => row.capabilityKey),
      version: snapshot.capabilityProfileVersion,
      createdAt:
        snapshot.capabilities.length > 0
          ? snapshot.capabilities[0]!.createdAt
          : null,
    };

    const importProvenance: ImportProvenance | null = snapshot.importProvenance
      ? {
          importId: snapshot.importProvenance.id,
          archiveFormat: snapshot.importProvenance.archiveFormat,
          archiveSha256: snapshot.importProvenance.archiveSha256,
          archiveByteSize: snapshot.importProvenance.archiveByteSize,
          importedAt: snapshot.importProvenance.createdAt,
        }
      : null;

    const cloneProvenance: CloneProvenance | null = snapshot.cloneProvenance
      ? {
          clonePlanId: snapshot.cloneProvenance.id,
          sourceProjectId: snapshot.cloneProvenance.sourceProjectId,
          targetProjectId: snapshot.cloneProvenance.targetProjectId,
          clonedAt: snapshot.cloneProvenance.createdAt,
        }
      : null;

    return {
      project: {
        id: snapshot.project.id,
        organizationId: snapshot.project.organizationId,
        name: snapshot.project.name,
        createdAt: snapshot.project.createdAt,
        updatedAt: snapshot.project.updatedAt,
      },
      profile,
      capabilityProfile,
      artifacts: [...snapshot.artifacts],
      artifactRelations: [...snapshot.artifactRelations],
      importProvenance,
      cloneProvenance,
    };
  }
}
