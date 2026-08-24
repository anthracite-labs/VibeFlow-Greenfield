/**
 * M-014 Project archive-import / clone-plan persistence.
 *
 * These repositories persist PROJECT-DOMAIN INTERNAL implementation records,
 * not new canonical resources. `CANONICAL_RESOURCE_MODEL.yaml` defines no
 * top-level Import/Template/Clone resource and M-014 adds none.
 *
 * Authority invariants preserved here:
 * - every id is server-generated; timestamps are server-controlled,
 * - Organization/Project relationships are canonical FKs, never client claims,
 * - archive bytes never enter these rows (only server-derived fingerprints),
 * - provider/external identifiers are rejected outright,
 * - the whole materialization runs in ONE transaction, so a rejected or failed
 *   import/clone leaves no partial Project/Artifact/Relation graph.
 */

import { and, eq, sql } from "drizzle-orm";

import type { ControlPlaneDatabase } from "./client.js";
import {
  DuplicateIdempotentCommandError,
  ForeignKeyViolationError,
  NotFoundError,
  PersistenceError,
  PersistenceInputError,
  rejectProviderAuthority,
} from "./errors.js";
import { newId, requireArtifactTypeToken, requireId, requireNonEmpty } from "./ids.js";
import {
  ARCHIVE_ENTRY_KINDS,
  ARCHIVE_FORMATS,
  ARCHIVE_IMPORT_SOURCE_KINDS,
  artifactRelations,
  artifacts,
  projectArchiveImportEntries,
  projectArchiveImports,
  projectCloneArtifactMap,
  projectClonePlans,
  projects,
  type ArchiveEntryKind,
  type ArchiveFormat,
  type ArtifactRelationRow,
  type ArtifactRow,
  type ProjectArchiveImportEntryRow,
  type ProjectArchiveImportRow,
  type ProjectCloneArtifactMapRow,
  type ProjectClonePlanRow,
  type ProjectRow,
} from "./schema.js";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/** One normalized, already-scanned manifest entry ready to persist. */
export interface ArchiveManifestEntryInput {
  readonly entryIndex: number;
  readonly normalizedPath: string;
  readonly kind: ArchiveEntryKind;
  readonly declaredSize: number;
  readonly compressedSize: number;
  readonly contentSha256?: string | undefined;
}

export interface ApplyArchiveImportInput {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly projectName: string;
  readonly archiveFormat: ArchiveFormat;
  readonly archiveSha256: string;
  readonly archiveByteSize: number;
  readonly manifestSha256: string;
  readonly manifestEntries: readonly ArchiveManifestEntryInput[];
  readonly stagedBlobRef?: string | undefined;
  readonly idempotencyKey: string;
  /**
   * Test-only injection point proving transactional rollback. Invoked inside
   * the transaction after the Project and manifest rows exist; throwing must
   * leave no durable state.
   */
  readonly failAfterProjectCreate?: (() => Promise<void>) | undefined;
}

export interface ApplyArchiveImportResult {
  readonly project: ProjectRow;
  readonly import: ProjectArchiveImportRow;
  readonly entries: readonly ProjectArchiveImportEntryRow[];
  /** True when an existing idempotent command result was replayed. */
  readonly replayed: boolean;
}

/** A source Artifact plus the relations to reproduce in the clone target. */
export interface CloneSourceGraph {
  readonly artifacts: readonly ArtifactRow[];
  readonly relations: readonly ArtifactRelationRow[];
}

export interface ApplyCloneplanInput {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly sourceProjectId: string;
  readonly targetProjectName: string;
  readonly idempotencyKey: string;
  /**
   * Test-only injection point proving transactional rollback mid-clone.
   * Invoked inside the transaction after target Project/Artifacts exist.
   */
  readonly failAfterArtifactClone?: (() => Promise<void>) | undefined;
}

export interface ApplyClonePlanResult {
  readonly targetProject: ProjectRow;
  readonly plan: ProjectClonePlanRow;
  readonly artifacts: readonly ArtifactRow[];
  readonly relations: readonly ArtifactRelationRow[];
  /** source artifact id -> target artifact id */
  readonly artifactIdMap: ReadonlyMap<string, string>;
  readonly replayed: boolean;
}

function now(): Date {
  return new Date();
}

function requireSha256(name: string, value: string): string {
  const trimmed = requireNonEmpty(name, value);
  if (!SHA256_HEX_RE.test(trimmed)) {
    throw new PersistenceInputError(`${name} must be a lowercase hex SHA-256 digest`);
  }
  return trimmed;
}

function requireIdempotencyKey(value: string): string {
  const trimmed = requireNonEmpty("idempotencyKey", value);
  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new PersistenceInputError(
      `idempotencyKey must be ${IDEMPOTENCY_KEY_MAX_LENGTH} characters or fewer`,
    );
  }
  return trimmed;
}

function requireNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new PersistenceInputError(`${name} must be a non-negative integer`);
  }
  return value;
}

interface PgLikeError {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as PgLikeError;
    if (typeof candidate.code === "string" && /^\d{5}$/.test(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

function mapLifecycleError(error: unknown): never {
  const code = postgresErrorCode(error);
  if (code === "23505") {
    throw new DuplicateIdempotentCommandError("idempotent command already applied");
  }
  if (code === "23503") {
    throw new ForeignKeyViolationError(
      "referenced canonical organization, project, account or artifact does not exist",
    );
  }
  if (error instanceof PersistenceError) {
    throw error;
  }
  throw new PersistenceError(
    error instanceof Error ? error.message : "persistence operation failed",
  );
}

/**
 * Durable persistence for the M-014 archive-import and clone-plan lifecycle.
 *
 * Every mutation is a single transaction covering Project + Artifact +
 * ArtifactRelation + internal provenance, so partial graphs are impossible.
 */
export class ProjectLifecycleRepository {
  public constructor(private readonly db: ControlPlaneDatabase) {}

  // -------------------------------------------------------------------------
  // Archive import
  // -------------------------------------------------------------------------

  /**
   * Transactionally materialize an accepted archive import.
   *
   * Creates the canonical Project and the internal import/manifest provenance
   * in ONE transaction. Retrying with the same (organization, actor,
   * idempotency key) replays the original result instead of creating a second
   * Project.
   *
   * NOTE: no Artifact is created per archive file. Artifact remains M-013
   * VibeFlow-owned typed-output metadata, and M-014 invents no source-file
   * Artifact type.
   */
  public async applyArchiveImport(
    input: ApplyArchiveImportInput,
  ): Promise<ApplyArchiveImportResult> {
    rejectProviderAuthority(input as unknown as Record<string, unknown>);
    const organizationId = requireId("organizationId", input.organizationId);
    const actorAccountId = requireId("actorAccountId", input.actorAccountId);
    const projectName = requireNonEmpty("projectName", input.projectName);
    const archiveSha256 = requireSha256("archiveSha256", input.archiveSha256);
    const manifestSha256 = requireSha256("manifestSha256", input.manifestSha256);
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const archiveByteSize = requireNonNegativeInteger(
      "archiveByteSize",
      input.archiveByteSize,
    );

    if (!(ARCHIVE_FORMATS as readonly string[]).includes(input.archiveFormat)) {
      throw new PersistenceInputError(
        `archiveFormat must be one of: ${ARCHIVE_FORMATS.join(", ")}`,
      );
    }

    for (const entry of input.manifestEntries) {
      if (!(ARCHIVE_ENTRY_KINDS as readonly string[]).includes(entry.kind)) {
        throw new PersistenceInputError(
          `manifest entry kind must be one of: ${ARCHIVE_ENTRY_KINDS.join(", ")}`,
        );
      }
      requireNonEmpty("normalizedPath", entry.normalizedPath);
      requireNonNegativeInteger("entryIndex", entry.entryIndex);
      requireNonNegativeInteger("declaredSize", entry.declaredSize);
      requireNonNegativeInteger("compressedSize", entry.compressedSize);
      if (entry.contentSha256 !== undefined) {
        requireSha256("contentSha256", entry.contentSha256);
      }
    }

    // Idempotent replay: return the already-applied result rather than
    // creating a duplicate Project/import.
    const existing = await this.findArchiveImportByIdempotencyKey(
      organizationId,
      actorAccountId,
      idempotencyKey,
    );
    if (existing !== undefined) {
      return { ...existing, replayed: true };
    }

    const totalDeclaredSize = input.manifestEntries.reduce(
      (sum, entry) => sum + entry.declaredSize,
      0,
    );

    try {
      return await this.db.transaction(async (tx) => {
        const createdAt = now();

        const projectRows = await tx
          .insert(projects)
          .values({
            id: newId(),
            organizationId,
            name: projectName,
            createdAt,
            updatedAt: createdAt,
          })
          .returning();
        const project = projectRows[0];
        if (!project) {
          throw new PersistenceInputError("project insert returned no row");
        }

        const importRows = await tx
          .insert(projectArchiveImports)
          .values({
            id: newId(),
            organizationId,
            projectId: project.id,
            actorAccountId,
            sourceKind: ARCHIVE_IMPORT_SOURCE_KINDS[0],
            archiveFormat: input.archiveFormat,
            archiveSha256,
            archiveByteSize,
            manifestSha256,
            manifestEntryCount: input.manifestEntries.length,
            manifestTotalDeclaredSize: totalDeclaredSize,
            stagedBlobRef: input.stagedBlobRef ?? null,
            idempotencyKey,
            createdAt,
          })
          .returning();
        const importRow = importRows[0];
        if (!importRow) {
          throw new PersistenceInputError("archive import insert returned no row");
        }

        let entries: ProjectArchiveImportEntryRow[] = [];
        if (input.manifestEntries.length > 0) {
          entries = await tx
            .insert(projectArchiveImportEntries)
            .values(
              input.manifestEntries.map((entry) => ({
                id: newId(),
                importId: importRow.id,
                entryIndex: entry.entryIndex,
                normalizedPath: entry.normalizedPath,
                entryKind: entry.kind,
                declaredSize: entry.declaredSize,
                compressedSize: entry.compressedSize,
                contentSha256: entry.contentSha256 ?? null,
                crc32: null,
              })),
            )
            .returning();
        }

        // Injectable mid-transaction failure proving atomic rollback.
        if (input.failAfterProjectCreate !== undefined) {
          await input.failAfterProjectCreate();
        }

        return { project, import: importRow, entries, replayed: false };
      });
    } catch (error) {
      mapLifecycleError(error);
    }
  }

  /** Look up a previously applied archive-import command by its scoped key. */
  public async findArchiveImportByIdempotencyKey(
    organizationId: string,
    actorAccountId: string,
    idempotencyKey: string,
  ): Promise<Omit<ApplyArchiveImportResult, "replayed"> | undefined> {
    const orgId = requireId("organizationId", organizationId);
    const actorId = requireId("actorAccountId", actorAccountId);
    const key = requireIdempotencyKey(idempotencyKey);

    const rows = await this.db
      .select()
      .from(projectArchiveImports)
      .where(
        and(
          eq(projectArchiveImports.organizationId, orgId),
          eq(projectArchiveImports.actorAccountId, actorId),
          eq(projectArchiveImports.idempotencyKey, key),
        ),
      );
    const importRow = rows[0];
    if (!importRow) {
      return undefined;
    }

    const projectRows = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, importRow.projectId));
    const project = projectRows[0];
    if (!project) {
      throw new NotFoundError(`project not found: ${importRow.projectId}`);
    }

    const entries = await this.db
      .select()
      .from(projectArchiveImportEntries)
      .where(eq(projectArchiveImportEntries.importId, importRow.id));

    return { project, import: importRow, entries };
  }

  public async getArchiveImportByProjectId(projectId: string): Promise<ProjectArchiveImportRow | undefined> {
    const id = requireId("projectId", projectId);
    const rows = await this.db
      .select()
      .from(projectArchiveImports)
      .where(eq(projectArchiveImports.projectId, id));
    return rows[0];
  }

  public async getArchiveImportById(importId: string): Promise<ProjectArchiveImportRow> {
    const id = requireId("importId", importId);
    const rows = await this.db
      .select()
      .from(projectArchiveImports)
      .where(eq(projectArchiveImports.id, id));
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`archive import not found: ${id}`);
    }
    return row;
  }

  /** Tenant-safe list: imports are listed only for one canonical organization. */
  public async listArchiveImportsForOrganization(
    organizationId: string,
  ): Promise<ProjectArchiveImportRow[]> {
    const id = requireId("organizationId", organizationId);
    return this.db
      .select()
      .from(projectArchiveImports)
      .where(eq(projectArchiveImports.organizationId, id));
  }

  public async listArchiveImportEntries(
    importId: string,
  ): Promise<ProjectArchiveImportEntryRow[]> {
    const id = requireId("importId", importId);
    return this.db
      .select()
      .from(projectArchiveImportEntries)
      .where(eq(projectArchiveImportEntries.importId, id));
  }

  // -------------------------------------------------------------------------
  // Project Clone Plan
  // -------------------------------------------------------------------------

  /**
   * Read the canonical source graph (Artifacts + same-Project relations) for a
   * clone. Callers must already have authorized the source Project.
   */
  public async readCloneSourceGraph(sourceProjectId: string): Promise<CloneSourceGraph> {
    const id = requireId("sourceProjectId", sourceProjectId);
    const sourceArtifacts = await this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.projectId, id));
    const sourceRelations = await this.db
      .select()
      .from(artifactRelations)
      .where(eq(artifactRelations.projectId, id));
    return { artifacts: sourceArtifacts, relations: sourceRelations };
  }

  /**
   * Transactionally materialize an authorized Project clone plan.
   *
   * Creates a NEW canonical Project (new server id), clones Artifact metadata
   * with NEW Artifact ids preserving each type token, recreates each
   * ArtifactRelation INSIDE the target Project by remapping old artifact ids to
   * their new ids preserving the canonical relation kind, and records the
   * clone provenance/mapping in the internal clone-plan tables.
   *
   * It never creates an ArtifactRelation between source and target Projects,
   * never reuses a source Artifact id, and never copies provider/repository/
   * workspace identifiers. Project + Artifact + ArtifactRelation target state
   * commits atomically.
   */
  public async applyClonePlan(input: ApplyCloneplanInput): Promise<ApplyClonePlanResult> {
    rejectProviderAuthority(input as unknown as Record<string, unknown>);
    const organizationId = requireId("organizationId", input.organizationId);
    const actorAccountId = requireId("actorAccountId", input.actorAccountId);
    const sourceProjectId = requireId("sourceProjectId", input.sourceProjectId);
    const targetProjectName = requireNonEmpty("targetProjectName", input.targetProjectName);
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);

    const existing = await this.findClonePlanByIdempotencyKey(
      organizationId,
      actorAccountId,
      idempotencyKey,
    );
    if (existing !== undefined) {
      return { ...existing, replayed: true };
    }

    try {
      return await this.db.transaction(async (tx) => {
        // PostgreSQL READ COMMITTED takes a fresh snapshot per statement. The
        // clone reads Artifacts and relations separately, so explicitly pin a
        // REPEATABLE READ snapshot before either query to prevent a torn graph.
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);

        const createdAt = now();

        const sourceArtifacts = await tx
          .select()
          .from(artifacts)
          .where(eq(artifacts.projectId, sourceProjectId));
        const sourceRelations = await tx
          .select()
          .from(artifactRelations)
          .where(eq(artifactRelations.projectId, sourceProjectId));

        const targetRows = await tx
          .insert(projects)
          .values({
            id: newId(),
            organizationId,
            name: targetProjectName,
            createdAt,
            updatedAt: createdAt,
          })
          .returning();
        const targetProject = targetRows[0];
        if (!targetProject) {
          throw new PersistenceInputError("target project insert returned no row");
        }

        // Clone Artifact metadata with NEW ids, preserving the type token.
        const artifactIdMap = new Map<string, string>();
        let clonedArtifacts: ArtifactRow[] = [];
        if (sourceArtifacts.length > 0) {
          const values = sourceArtifacts.map((source) => {
            const targetId = newId();
            artifactIdMap.set(source.id, targetId);
            return {
              id: targetId,
              projectId: targetProject.id,
              // Preserve the canonical typed-output token exactly.
              type: requireArtifactTypeToken("type", source.type),
              createdAt,
              updatedAt: createdAt,
            };
          });
          clonedArtifacts = await tx.insert(artifacts).values(values).returning();
        }

        if (input.failAfterArtifactClone !== undefined) {
          await input.failAfterArtifactClone();
        }

        // Recreate relations INSIDE the target project by remapping endpoints.
        let clonedRelations: ArtifactRelationRow[] = [];
        if (sourceRelations.length > 0) {
          const values = sourceRelations.map((relation) => {
            const subject = artifactIdMap.get(relation.subjectArtifactId);
            const object = artifactIdMap.get(relation.objectArtifactId);
            if (subject === undefined || object === undefined) {
              // Cannot happen for a consistent same-Project source graph; if it
              // did, failing here aborts the transaction rather than writing a
              // relation that points outside the target Project.
              throw new PersistenceError(
                "clone relation endpoint has no remapped target artifact",
              );
            }
            return {
              id: newId(),
              projectId: targetProject.id,
              subjectArtifactId: subject,
              objectArtifactId: object,
              // Preserve the canonical relation kind.
              relationKind: relation.relationKind,
              createdAt,
            };
          });
          clonedRelations = await tx.insert(artifactRelations).values(values).returning();
        }

        const planRows = await tx
          .insert(projectClonePlans)
          .values({
            id: newId(),
            organizationId,
            sourceProjectId,
            targetProjectId: targetProject.id,
            actorAccountId,
            planKind: "project_clone",
            artifactCount: clonedArtifacts.length,
            relationCount: clonedRelations.length,
            idempotencyKey,
            createdAt,
          })
          .returning();
        const plan = planRows[0];
        if (!plan) {
          throw new PersistenceInputError("clone plan insert returned no row");
        }

        // Clone provenance lives here, NOT in ArtifactRelation.
        if (artifactIdMap.size > 0) {
          await tx.insert(projectCloneArtifactMap).values(
            [...artifactIdMap.entries()].map(([sourceArtifactId, targetArtifactId]) => ({
              id: newId(),
              clonePlanId: plan.id,
              sourceArtifactId,
              targetArtifactId,
            })),
          );
        }

        return {
          targetProject,
          plan,
          artifacts: clonedArtifacts,
          relations: clonedRelations,
          artifactIdMap,
          replayed: false,
        };
      });
    } catch (error) {
      mapLifecycleError(error);
    }
  }

  /** Look up a previously applied clone command by its scoped key. */
  public async findClonePlanByIdempotencyKey(
    organizationId: string,
    actorAccountId: string,
    idempotencyKey: string,
  ): Promise<Omit<ApplyClonePlanResult, "replayed"> | undefined> {
    const orgId = requireId("organizationId", organizationId);
    const actorId = requireId("actorAccountId", actorAccountId);
    const key = requireIdempotencyKey(idempotencyKey);

    const rows = await this.db
      .select()
      .from(projectClonePlans)
      .where(
        and(
          eq(projectClonePlans.organizationId, orgId),
          eq(projectClonePlans.actorAccountId, actorId),
          eq(projectClonePlans.idempotencyKey, key),
        ),
      );
    const plan = rows[0];
    if (!plan) {
      return undefined;
    }

    const targetRows = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, plan.targetProjectId));
    const targetProject = targetRows[0];
    if (!targetProject) {
      throw new NotFoundError(`project not found: ${plan.targetProjectId}`);
    }

    const clonedArtifacts = await this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.projectId, plan.targetProjectId));
    const clonedRelations = await this.db
      .select()
      .from(artifactRelations)
      .where(eq(artifactRelations.projectId, plan.targetProjectId));
    const mapRows = await this.db
      .select()
      .from(projectCloneArtifactMap)
      .where(eq(projectCloneArtifactMap.clonePlanId, plan.id));

    const artifactIdMap = new Map<string, string>(
      mapRows.map((row) => [row.sourceArtifactId, row.targetArtifactId]),
    );

    return {
      targetProject,
      plan,
      artifacts: clonedArtifacts,
      relations: clonedRelations,
      artifactIdMap,
    };
  }

  public async getClonePlanByTargetProjectId(targetProjectId: string): Promise<ProjectClonePlanRow | undefined> {
    const id = requireId("targetProjectId", targetProjectId);
    const rows = await this.db
      .select()
      .from(projectClonePlans)
      .where(eq(projectClonePlans.targetProjectId, id));
    return rows[0];
  }

  public async getClonePlanById(planId: string): Promise<ProjectClonePlanRow> {
    const id = requireId("planId", planId);
    const rows = await this.db
      .select()
      .from(projectClonePlans)
      .where(eq(projectClonePlans.id, id));
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`clone plan not found: ${id}`);
    }
    return row;
  }

  /** Tenant-safe list: clone plans are listed only for one canonical org. */
  public async listClonePlansForOrganization(
    organizationId: string,
  ): Promise<ProjectClonePlanRow[]> {
    const id = requireId("organizationId", organizationId);
    return this.db
      .select()
      .from(projectClonePlans)
      .where(eq(projectClonePlans.organizationId, id));
  }

  public async listCloneArtifactMap(
    clonePlanId: string,
  ): Promise<ProjectCloneArtifactMapRow[]> {
    const id = requireId("clonePlanId", clonePlanId);
    return this.db
      .select()
      .from(projectCloneArtifactMap)
      .where(eq(projectCloneArtifactMap.clonePlanId, id));
  }
}
