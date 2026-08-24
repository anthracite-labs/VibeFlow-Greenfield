/**
 * M-012 Project authority service.
 *
 * VibeFlow owns Project identity, Organization ownership, timestamps and
 * security context. A client/provider cannot lie about any of that.
 *
 * Authority invariants:
 * - Project id is server-generated UUID.
 * - Organization ownership is canonical Organization row resolved from
 *   persistence, never a client claim.
 * - Timestamps are server-controlled.
 * - Authorization resolves canonical membership on every decision.
 * - Cross-tenant access fails closed.
 * - Revoked/stale membership fails closed.
 * - Forged organization id fails closed.
 */

import {
  isUuid,
  NotFoundError,
  type ProjectRow,
  type ProjectRepository,
  type TenantRepository,
} from "@vibeflow/persistence";
import { TenantAuthorizationService } from "@vibeflow/authorization";

import {
  ProjectAuthorizationError,
  ProjectInputError,
  ProjectNotFoundError,
} from "./errors.js";

export interface ProjectServiceOptions {
  tenants: TenantRepository;
  projects: ProjectRepository;
  authz: TenantAuthorizationService;
}

export interface CreateProjectInput {
  accountId: string;
  organizationId: string;
  name: string;
}

export interface GetProjectInput {
  accountId: string;
  projectId: string;
}

export interface ListProjectsInput {
  accountId: string;
  organizationId: string;
}

export interface UpdateProjectInput {
  accountId: string;
  projectId: string;
  name: string;
}

function requireUuid(name: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectInputError(`${name} is required`);
  }
  if (!isUuid(value)) {
    throw new ProjectInputError(`${name} must be a UUID`);
  }
  return value;
}

function requireNonEmpty(name: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectInputError(`${name} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ProjectInputError(`${name} is required`);
  }
  if (trimmed.length > 200) {
    throw new ProjectInputError(`${name} must be 200 characters or fewer`);
  }
  return trimmed;
}

export class ProjectService {
  public constructor(private readonly options: ProjectServiceOptions) {}

  /**
   * Create a canonical Project under a canonical Organization.
   * The caller must be a current member of the Organization.
   * Server generates id and timestamps; organizationId is resolved as
   * canonical tenant, never trusted from client claim alone.
   */
  public async createProject(input: CreateProjectInput): Promise<ProjectRow> {
    const accountId = requireUuid("accountId", input.accountId);
    const organizationId = requireUuid("organizationId", input.organizationId);
    const name = requireNonEmpty("name", input.name);

    const decision = await this.options.authz.authorize({
      accountId,
      action: "create",
      resource: { type: "organization", id: organizationId },
    });

    if (!decision.allowed) {
      throw new ProjectAuthorizationError(
        `Project creation denied: ${decision.reason}`,
        decision.reason,
      );
    }

    try {
      await this.options.tenants.getOrganizationById(organizationId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ProjectNotFoundError(`Organization not found: ${organizationId}`);
      }
      throw error;
    }

    return this.options.projects.createProject({ organizationId, name });
  }

  public async getProject(input: GetProjectInput): Promise<ProjectRow> {
    const accountId = requireUuid("accountId", input.accountId);
    const projectId = requireUuid("projectId", input.projectId);

    const decision = await this.options.authz.authorize({
      accountId,
      action: "read",
      resource: { type: "project", id: projectId },
    });

    if (!decision.allowed) {
      if (decision.reason === "unknown_resource") {
        throw new ProjectNotFoundError(`Project not found: ${projectId}`);
      }
      throw new ProjectAuthorizationError(
        `Project read denied: ${decision.reason}`,
        decision.reason,
      );
    }

    try {
      return await this.options.projects.getProjectById(projectId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ProjectNotFoundError(`Project not found: ${projectId}`);
      }
      throw error;
    }
  }

  public async listProjects(input: ListProjectsInput): Promise<ProjectRow[]> {
    const accountId = requireUuid("accountId", input.accountId);
    const organizationId = requireUuid("organizationId", input.organizationId);

    const decision = await this.options.authz.authorize({
      accountId,
      action: "read",
      resource: { type: "organization", id: organizationId },
    });

    if (!decision.allowed) {
      if (decision.reason === "unknown_resource") {
        throw new ProjectNotFoundError(`Organization not found: ${organizationId}`);
      }
      throw new ProjectAuthorizationError(
        `Project list denied: ${decision.reason}`,
        decision.reason,
      );
    }

    return this.options.projects.listProjectsForOrganization(organizationId);
  }

  public async updateProject(input: UpdateProjectInput): Promise<ProjectRow> {
    const accountId = requireUuid("accountId", input.accountId);
    const projectId = requireUuid("projectId", input.projectId);
    const name = requireNonEmpty("name", input.name);

    const decision = await this.options.authz.authorize({
      accountId,
      action: "update",
      resource: { type: "project", id: projectId },
    });

    if (!decision.allowed) {
      if (decision.reason === "unknown_resource") {
        throw new ProjectNotFoundError(`Project not found: ${projectId}`);
      }
      throw new ProjectAuthorizationError(
        `Project update denied: ${decision.reason}`,
        decision.reason,
      );
    }

    try {
      return await this.options.projects.updateProject({ id: projectId, name });
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ProjectNotFoundError(`Project not found: ${projectId}`);
      }
      throw error;
    }
  }
}
