/**
 * M-014 Project Archive Import authority service (VF-PRJ-004 / R2V-083).
 *
 * Canonical intent: bring source/assets into a Project WITHOUT requiring an
 * external repository. VibeFlow owns the resulting Project identity; the
 * archive contributes filenames and content only.
 *
 * Authority invariants:
 * - Project id and all timestamps are server-generated.
 * - Organization ownership is proven by canonical membership, never by an
 *   archive/provider/client claim.
 * - Archive bytes are hostile input, fully validated by the structural scanner
 *   BEFORE any workspace materialization and BEFORE any durable canonical
 *   Project state exists.
 * - A rejected/failed import leaves NO canonical Project, Artifact, relation,
 *   or workspace state.
 * - Archive content is never executed during inspection or import.
 * - The manifest/archive fingerprints are server-derived; a caller may not
 *   override them.
 * - A retry with the same idempotency key does not create a second Project.
 *
 * Explicitly NOT implemented here (deferred provider capabilities):
 * VF-PRJ-008 Bitbucket, VF-PRJ-009 Bolt/Lovable/Base44, VF-PRJ-010 Figma,
 * VF-PRJ-011 Vercel, VF-PRJ-012 GitHub, RepositoryBinding, WorkspaceBinding,
 * provider credentials, Git operations, workspace provisioning, agent/model
 * execution. Those adapters should eventually feed normalized source
 * information INTO this seam; they must never own Project identity.
 */

import {
  DuplicateIdempotentCommandError,
  isUuid,
  NotFoundError,
  type ArchiveFormat,
  type ProjectArchiveImportEntryRow,
  type ProjectArchiveImportRow,
  type ProjectLifecycleRepository,
  type ProjectRow,
} from "@vibeflow/persistence";
import { TenantAuthorizationService } from "@vibeflow/authorization";

import { scanArchive, type ArchiveManifest } from "./archive/scanner.js";
import type { ArchiveScanLimits } from "./archive/limits.js";
import type { ArchiveStagingPort } from "./archive/staging.js";
import {
  ProjectAuthorizationError,
  ProjectImportError,
  ProjectInputError,
} from "./errors.js";

export interface ProjectImportServiceOptions {
  lifecycle: ProjectLifecycleRepository;
  authz: TenantAuthorizationService;
  /**
   * Optional private content-addressed staging for the accepted archive bytes.
   * NOT a canonical ObjectStorageBinding; see `archive/staging.ts`.
   */
  staging?: ArchiveStagingPort | undefined;
  /** Optional override of the M-014 implementation safety limits. */
  limits?: Partial<ArchiveScanLimits> | undefined;
}

export interface ImportProjectArchiveInput {
  /** Canonical Account id proven by M-009 authentication. */
  accountId: string;
  /** Canonical destination Organization id. */
  organizationId: string;
  /** VibeFlow-owned Project name. Suggested by the caller, owned by the server. */
  projectName: string;
  /** Untrusted archive bytes. */
  archive: Buffer;
  /** Declared container format; must be one the master/ledger proves. */
  format: ArchiveFormat;
  /** Durable command idempotency key. */
  idempotencyKey: string;
}

export interface ImportProjectArchiveResult {
  readonly project: ProjectRow;
  readonly import: ProjectArchiveImportRow;
  readonly manifestEntries: readonly ProjectArchiveImportEntryRow[];
  /** True when a duplicate idempotency key replayed the original result. */
  readonly replayed: boolean;
}

const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const PROJECT_NAME_MAX_LENGTH = 200;

/**
 * Authority-shaped fields a caller/provider might try to smuggle in to
 * redirect tenant scope or forge provenance. Presence is a hard rejection:
 * silently ignoring them would let a client believe it had set them.
 */
const FORBIDDEN_AUTHORITY_KEYS = [
  "projectId",
  "project_id",
  "importId",
  "import_id",
  "organizationIdClaim",
  "providerId",
  "provider_id",
  "externalId",
  "external_id",
  "repositoryId",
  "repository_id",
  "workspaceId",
  "workspace_id",
  "manifestSha256",
  "manifest_sha256",
  "archiveSha256",
  "archive_sha256",
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
    throw new ProjectInputError("projectName is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > PROJECT_NAME_MAX_LENGTH) {
    throw new ProjectInputError(
      `projectName must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer`,
    );
  }
  // Control characters in a product-visible name are rejected rather than
  // stripped, so a name can never render differently than it was validated.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ProjectInputError("projectName must not contain control characters");
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
      `client/provider fields never establish import authority: ${present.join(", ")}`,
    );
  }
}

export class ProjectImportService {
  public constructor(private readonly options: ProjectImportServiceOptions) {}

  /**
   * Import an archive as a NEW canonical Project.
   *
   * Authority sequence (fail-closed, in this exact order):
   *   1. validate command syntax only (no persistence reads)
   *   2. reject authority-shaped client/provider fields
   *   3. authorize `create` against the target canonical Organization
   *   4. replay a prior idempotent result if this command already ran
   *   5. scan the untrusted archive (no durable state exists yet)
   *   6. derive the server-owned manifest/provenance
   *   7. stage accepted bytes privately (never in canonical metadata rows)
   *   8. transactionally create Project + internal import provenance
   *   9. return the new canonical Project and import result
   *
   * Steps 1-6 create nothing durable, so a rejection at any point provably
   * leaves no canonical Project/Artifact/relation/workspace state behind.
   */
  public async importProjectArchive(
    input: ImportProjectArchiveInput,
  ): Promise<ImportProjectArchiveResult> {
    // 1 & 2. Primitive syntax and untrusted-field rejection only.
    rejectAuthorityShapedFields(input);
    const accountId = requireUuid("accountId", input.accountId);
    const organizationId = requireUuid("organizationId", input.organizationId);
    const projectName = requireProjectName(input.projectName);
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);

    if (input.format !== "zip" && input.format !== "tar") {
      throw new ProjectInputError("format must be 'zip' or 'tar'");
    }
    if (!Buffer.isBuffer(input.archive)) {
      throw new ProjectInputError("archive must be a Buffer of raw archive bytes");
    }

    // 3. Authorize creation against the canonical destination Organization
    // BEFORE spending any work on the archive. A caller who cannot create in
    // this tenant never reaches the scanner.
    const decision = await this.options.authz.authorize({
      accountId,
      action: "create",
      resource: { type: "organization", id: organizationId },
    });
    if (!decision.allowed) {
      throw new ProjectAuthorizationError(
        `Project archive import denied: ${decision.reason}`,
        decision.reason,
      );
    }

    // 4. Idempotent replay of an already-applied command.
    const replay = await this.options.lifecycle.findArchiveImportByIdempotencyKey(
      organizationId,
      accountId,
      idempotencyKey,
    );
    if (replay !== undefined) {
      return {
        project: replay.project,
        import: replay.import,
        manifestEntries: replay.entries,
        replayed: true,
      };
    }

    // 5. Scan hostile bytes in memory. No extraction, no execution, and no
    // durable canonical state exists at this point.
    const manifest: ArchiveManifest = scanArchive({
      bytes: input.archive,
      format: input.format,
      limits: this.options.limits,
    });

    // 6 & 7. Provenance is server-derived. Bytes go to private staging only,
    // never into canonical Project/Artifact metadata rows. put() acquires one
    // claim so a failed/replayed attempt can release its own retention without
    // deleting a shared content-addressed blob retained by another import.
    let stagedBlobRef: string | undefined;
    let stagedClaimHeld = false;
    if (this.options.staging !== undefined) {
      stagedBlobRef = await this.options.staging.put(input.archive);
      stagedClaimHeld = true;
    }

    const releaseStagedClaim = async (): Promise<void> => {
      if (
        stagedClaimHeld &&
        stagedBlobRef !== undefined &&
        this.options.staging !== undefined
      ) {
        stagedClaimHeld = false;
        await this.options.staging.release(stagedBlobRef);
      }
    };

    // 8. One transaction: canonical Project + internal import provenance.
    try {
      const applied = await this.options.lifecycle.applyArchiveImport({
        organizationId,
        actorAccountId: accountId,
        projectName,
        archiveFormat: manifest.format,
        archiveSha256: manifest.archiveSha256,
        archiveByteSize: manifest.archiveByteSize,
        manifestSha256: manifest.manifestSha256,
        manifestEntries: manifest.entries.map((entry) => ({
          entryIndex: entry.entryIndex,
          normalizedPath: entry.normalizedPath,
          kind: entry.kind,
          declaredSize: entry.declaredSize,
          compressedSize: entry.compressedSize,
          contentSha256: entry.contentSha256,
        })),
        stagedBlobRef,
        idempotencyKey,
      });

      // The repository can discover a concurrent winner in its own preflight.
      // Our staging claim is not referenced by that winner's durable command.
      if (applied.replayed) {
        await releaseStagedClaim();
      }

      // 9. Canonical result. A non-replayed success deliberately retains the
      // staging claim because the durable import row references stagedBlobRef.
      return {
        project: applied.project,
        import: applied.import,
        manifestEntries: applied.entries,
        replayed: applied.replayed,
      };
    } catch (error) {
      // This attempt did not commit a durable row that owns its staging claim.
      // Release it before resolving a concurrent idempotent winner or
      // propagating the failure.
      try {
        await releaseStagedClaim();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "archive import failed and staged archive claim release also failed",
        );
      }

      // A concurrent retry of the same command raced us to the unique
      // idempotency key. Resolve to the winner's durable result instead of
      // reporting a spurious failure or creating a second Project.
      if (error instanceof DuplicateIdempotentCommandError) {
        const settled = await this.options.lifecycle.findArchiveImportByIdempotencyKey(
          organizationId,
          accountId,
          idempotencyKey,
        );
        if (settled !== undefined) {
          return {
            project: settled.project,
            import: settled.import,
            manifestEntries: settled.entries,
            replayed: true,
          };
        }
        throw new ProjectImportError("archive import command conflicted");
      }
      throw error;
    }
  }

  /**
   * Read the normalized manifest of a prior import.
   *
   * The internal import record is not a registered canonical resource type, so
   * its canonical Project must be resolved to obtain an authorization scope.
   * That lookup reveals nothing to the caller: an unknown import id and an
   * unauthorized (foreign-tenant) import id produce the SAME opaque error, so
   * this path cannot be used to probe which import ids exist. Infrastructure
   * failures are not normalized to absence.
   */
  public async getImportManifest(input: {
    accountId: string;
    importId: string;
  }): Promise<readonly ProjectArchiveImportEntryRow[]> {
    const accountId = requireUuid("accountId", input.accountId);
    const importId = requireUuid("importId", input.importId);

    let importRow: ProjectArchiveImportRow | undefined;
    try {
      importRow = await this.options.lifecycle.getArchiveImportById(importId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        importRow = undefined;
      } else {
        throw error;
      }
    }

    // Authorize against the canonical Project scope. M-014 registers no public
    // `import` resource type; `project` remains the canonical authorization
    // resource.
    const allowed =
      importRow !== undefined &&
      (
        await this.options.authz.authorize({
          accountId,
          action: "read",
          resource: { type: "project", id: importRow.projectId },
        })
      ).allowed;

    if (!allowed || importRow === undefined) {
      throw new ProjectImportError("Archive import not found or access denied");
    }

    return this.options.lifecycle.listArchiveImportEntries(importRow.id);
  }

  /**
   * Get import provenance for a Project, if any.
   * Authorizes Project read first. Returns undefined only when no import exists;
   * persistence failures propagate rather than becoming false absence.
   */
  public async getImportByProjectId(input: {
    accountId: string;
    projectId: string;
  }): Promise<ProjectArchiveImportRow | undefined> {
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

    return this.options.lifecycle.getArchiveImportByProjectId(projectId);
  }
}
