/**
 * M-014 Project Clone Plan authority service (VF-PRJ-007 / R2V-086).
 *
 * "Template" in M-014 means EXACTLY: create a new canonical Project from an
 * authorized source Project through an explicit clone plan. There is no
 * canonical `Template` resource, no template catalog, and no marketplace —
 * the authoritative evidence maps fork/remix/template semantics to Project
 * Clone Plan, and nothing broader is invented here.
 *
 * No provider/Git/workspace action is performed. Cross-Organization and public
 * template semantics remain deferred: the master defines no public/cross-org
 * template-sharing authority, so M-014 restricts clone/template instantiation
 * to the same canonical Organization.
 */

import {
  DuplicateIdempotentCommandError,
  isUuid,
  NotFoundError,
  type ArtifactRelationRow,
  type ArtifactRow,
  type ProjectClonePlanRow,
  type ProjectLifecycleRepository,
  type ProjectRepository,
  type ProjectRow,
} from "@vibeflow/persistence";
import { TenantAuthorizationService } from "@vibeflow/authorization";

import {
  ProjectAuthorizationError,
  ProjectCloneError,
  ProjectInputError,
  ProjectNotFoundError,
} from "./errors.js";

export interface ProjectCloneServiceOptions {
  projects: ProjectRepository;
  lifecycle: ProjectLifecycleRepository;
  authz: TenantAuthorizationService;
}

export interface CloneProjectInput {
  /** Canonical Account id proven by M-009 authentication. */
  accountId: string;
  /** Opaque canonical id of the source Project to clone from. */
  sourceProjectId: string;
  /** VibeFlow-owned name for the new Project. */
  targetProjectName: string;
  /**
   * OPTIONAL destination Organization. When supplied it is only ever used as
   * an assertion to CHECK against the canonical source Organization, never as
   * the authorization scope itself. M-014 policy requires it to match.
   */
  destinationOrganizationId?: string | undefined;
  /** Durable command idempotency key. */
  idempotencyKey: string;
}

export interface CloneProjectResult {
  readonly targetProject: ProjectRow;
  readonly plan: ProjectClonePlanRow;
  readonly artifacts: readonly ArtifactRow[];
  readonly relations: readonly ArtifactRelationRow[];
  /** source Artifact id -> new target Artifact id */
  readonly artifactIdMap: ReadonlyMap<string, string>;
  readonly replayed: boolean;
}

const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const PROJECT_NAME_MAX_LENGTH = 200;

/**
 * Authority-shaped fields that must never redirect clone scope or forge
 * identity/provenance. `destinationOrganizationId` is intentionally NOT here:
 * it is accepted as an assertion and then verified against canonical state.
 */
const FORBIDDEN_AUTHORITY_KEYS = [
  "targetProjectId",
  "target_project_id",
  "sourceOrganizationId",
  "source_organization_id",
  "clonePlanId",
  "clone_plan_id",
  "providerId",
  "provider_id",
  "externalId",
  "external_id",
  "repositoryId",
  "repository_id",
  "workspaceId",
  "workspace_id",
  "artifactIds",
  "artifact_ids",
  "createdAt",
  "created_at",
  "actorAccountId",
  "actor_account_id",
] as const;

function requireUuid(name: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectInputError(`${name} is required`);
  }
  if (!isUuid(value)) {
    throw new ProjectInputError(`${name} must be a UUID`);
  }
  return value;
}

function requireProjectName(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectInputError("targetProjectName is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > PROJECT_NAME_MAX_LENGTH) {
    throw new ProjectInputError(
      `targetProjectName must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ProjectInputError("targetProjectName must not contain control characters");
  }
  return trimmed;
}

function requireIdempotencyKey(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectInputError("idempotencyKey is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ProjectInputError(
      `idempotencyKey must be ${IDEMPOTENCY_KEY_MAX_LENGTH} characters or fewer`,
    );
  }
  return trimmed;
}

function rejectAuthorityShapedFields(input: object): void {
  const present = FORBIDDEN_AUTHORITY_KEYS.filter(
    (key) =>
      Object.prototype.hasOwnProperty.call(input, key) &&
      (input as Record<string, unknown>)[key] !== undefined,
  );
  if (present.length > 0) {
    throw new ProjectInputError(
      `client/provider fields never establish clone authority: ${present.join(", ")}`,
    );
  }
}

export class ProjectCloneService {
  public constructor(private readonly options: ProjectCloneServiceOptions) {}

  /**
   * Create a new canonical Project from an authorized source Project.
   *
   * Authority ordering is fail-closed and prevents the class of authority leak
   * fixed during M-013 — no canonical source detail is loaded, and no source
   * existence is disclosed, before the caller proves read access:
   *
   *   1. primitive syntax/idempotency validation only
   *   2. authorize READ of the source Project by its OPAQUE canonical id
   *   3. only after that succeeds, load the canonical source Project row
   *   4. derive the source Organization from canonical persistence
   *   5. authorize CREATE against the canonical destination Organization
   *   6. enforce the M-014 same-tenant template policy
   *   7. transactionally create/materialize the target
   *
   * The destination Organization is DERIVED from the canonical source Project,
   * never taken from a caller-provided claim.
   */
  public async cloneProject(input: CloneProjectInput): Promise<CloneProjectResult> {
    // 1. Syntax only. No persistence reads, no existence disclosure.
    rejectAuthorityShapedFields(input);
    const accountId = requireUuid("accountId", input.accountId);
    const sourceProjectId = requireUuid("sourceProjectId", input.sourceProjectId);
    const targetProjectName = requireProjectName(input.targetProjectName);
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const assertedDestinationOrganizationId =
      input.destinationOrganizationId === undefined
        ? undefined
        : requireUuid("destinationOrganizationId", input.destinationOrganizationId);

    // 2. Authorize READ of the source Project by opaque canonical id, before
    // any canonical source detail is loaded. A cross-tenant probe therefore
    // cannot learn whether the id exists or what it contains.
    const sourceDecision = await this.options.authz.authorize({
      accountId,
      action: "read",
      resource: { type: "project", id: sourceProjectId },
    });
    if (!sourceDecision.allowed) {
      if (sourceDecision.reason === "unknown_resource") {
        throw new ProjectNotFoundError(`Project not found: ${sourceProjectId}`);
      }
      throw new ProjectAuthorizationError(
        `Project clone denied: ${sourceDecision.reason}`,
        sourceDecision.reason,
      );
    }

    // 3. Only now load the canonical source Project. A real persistence outage
    // is not equivalent to an unknown Project and must remain observable.
    let sourceProject: ProjectRow;
    try {
      sourceProject = await this.options.projects.getProjectById(sourceProjectId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ProjectNotFoundError(`Project not found: ${sourceProjectId}`);
      }
      throw error;
    }

    // 4. Derive the Organization from canonical persistence, never a claim.
    const canonicalOrganizationId = sourceProject.organizationId;

    // 5. Authorize CREATE against that canonical destination Organization.
    const createDecision = await this.options.authz.authorize({
      accountId,
      action: "create",
      resource: { type: "organization", id: canonicalOrganizationId },
    });
    if (!createDecision.allowed) {
      throw new ProjectAuthorizationError(
        `Project clone creation denied: ${createDecision.reason}`,
        createDecision.reason,
      );
    }

    // 6. M-014 cross-tenant template policy. The master defines no
    // public/cross-Organization template-sharing authority, so a clone stays
    // inside the source Organization. A caller asserting a different
    // destination is denied rather than silently redirected.
    if (
      assertedDestinationOrganizationId !== undefined &&
      assertedDestinationOrganizationId !== canonicalOrganizationId
    ) {
      throw new ProjectCloneError(
        "Cross-Organization Project clone is not permitted; M-014 restricts clone/template instantiation to the source Organization",
      );
    }

    // 7. Transactional materialization. Project + Artifacts + relations commit
    // atomically; a failure mid-clone rolls back the whole target graph.
    try {
      const applied = await this.options.lifecycle.applyClonePlan({
        organizationId: canonicalOrganizationId,
        actorAccountId: accountId,
        sourceProjectId,
        targetProjectName,
        idempotencyKey,
      });

      return {
        targetProject: applied.targetProject,
        plan: applied.plan,
        artifacts: applied.artifacts,
        relations: applied.relations,
        artifactIdMap: applied.artifactIdMap,
        replayed: applied.replayed,
      };
    } catch (error) {
      if (error instanceof DuplicateIdempotentCommandError) {
        const settled = await this.options.lifecycle.findClonePlanByIdempotencyKey(
          canonicalOrganizationId,
          accountId,
          idempotencyKey,
        );
        if (settled !== undefined) {
          return { ...settled, replayed: true };
        }
        throw new ProjectCloneError("clone command conflicted");
      }
      throw error;
    }
  }

  /**
   * Read a clone plan's provenance.
   *
   * Authorization is against the canonical target Project. Unknown and
   * unauthorized plan ids produce the same opaque error, so this cannot be
   * used to probe which plans exist. Infrastructure failures propagate.
   */
  public async getClonePlan(input: {
    accountId: string;
    planId: string;
  }): Promise<ProjectClonePlanRow> {
    const accountId = requireUuid("accountId", input.accountId);
    const planId = requireUuid("planId", input.planId);

    let plan: ProjectClonePlanRow | undefined;
    try {
      plan = await this.options.lifecycle.getClonePlanById(planId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        plan = undefined;
      } else {
        throw error;
      }
    }

    const allowed =
      plan !== undefined &&
      (
        await this.options.authz.authorize({
          accountId,
          action: "read",
          resource: { type: "project", id: plan.targetProjectId },
        })
      ).allowed;

    if (!allowed || plan === undefined) {
      throw new ProjectCloneError("Clone plan not found or access denied");
    }

    return plan;
  }

  /**
   * Get clone provenance for a target Project, if any.
   * Authorizes Project read first. Returns undefined only when no clone exists;
   * persistence failures propagate rather than becoming false absence.
   */
  public async getClonePlanByProjectId(input: {
    accountId: string;
    projectId: string;
  }): Promise<ProjectClonePlanRow | undefined> {
    const accountId = requireUuid("accountId", input.accountId);
    const projectId = requireUuid("projectId", input.projectId);

    const decision = await this.options.authz.authorize({
      accountId,
      action: "read",
      resource: { type: "project", id: projectId },
    });
    if (!decision.allowed) {
      return undefined;
    }

    return this.options.lifecycle.getClonePlanByTargetProjectId(projectId);
  }
}
