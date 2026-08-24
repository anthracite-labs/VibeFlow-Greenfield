export class PersistenceError extends Error {
  override readonly name: string = "PersistenceError";
}

export class PersistenceInputError extends PersistenceError {
  override readonly name = "PersistenceInputError";
}

export class NotFoundError extends PersistenceError {
  override readonly name = "NotFoundError";
}

export class DuplicateMembershipError extends PersistenceError {
  override readonly name = "DuplicateMembershipError";
}

/** A PostgreSQL uniqueness violation outside the membership-specific contract. */
export class UniqueConstraintError extends PersistenceError {
  override readonly name = "UniqueConstraintError";

  public constructor(message: string, public readonly constraint?: string) {
    super(message);
  }
}

export class ForeignKeyViolationError extends PersistenceError {
  override readonly name = "ForeignKeyViolationError";
}

export class ProviderAuthorityRejectedError extends PersistenceError {
  override readonly name = "ProviderAuthorityRejectedError";
}

/** A relation whose endpoints resolve to different canonical Projects. */
export class CrossProjectArtifactRelationError extends PersistenceError {
  override readonly name = "CrossProjectArtifactRelationError";
}

/**
 * A durable command with this (tenant, actor, idempotency key) was already
 * applied. M-014 uses it to keep a retried import/clone command from creating
 * a second Project.
 */
export class DuplicateIdempotentCommandError extends PersistenceError {
  override readonly name = "DuplicateIdempotentCommandError";
}

/** A duplicate (project, subject, kind, object) relation edge. */
export class DuplicateArtifactRelationError extends PersistenceError {
  override readonly name = "DuplicateArtifactRelationError";
}

/**
 * An optimistic concurrency version conflict: the caller's expectedVersion
 * does not match the current persisted version, so the mutation is rejected.
 */
export class StaleVersionError extends PersistenceError {
  override readonly name = "StaleVersionError";
}

const PROVIDER_AUTHORITY_KEYS = [
  "providerId",
  "provider_id",
  "externalId",
  "external_id",
  "clientTenantId",
  "client_tenant_id",
  "providerAccountId",
  "provider_account_id",
  "providerOrganizationId",
  "provider_organization_id",
] as const;

export function rejectProviderAuthority(input: Record<string, unknown>): void {
  const present = PROVIDER_AUTHORITY_KEYS.filter((key) => {
    return Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  });
  if (present.length > 0) {
    throw new ProviderAuthorityRejectedError(
      `Client/provider identifiers never establish tenant authority: ${present.join(", ")}`,
    );
  }
}

interface PgLikeError {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

interface PostgresErrorMetadata {
  code: string;
  constraint?: string;
}

function postgresErrorMetadata(error: unknown): PostgresErrorMetadata | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as PgLikeError;
    if (typeof candidate.code === "string" && /^\d{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint === "string"
          ? { constraint: candidate.constraint }
          : {}),
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

export function mapDatabaseError(error: unknown): never {
  const metadata = postgresErrorMetadata(error);
  if (metadata?.code === "23505") {
    if (metadata.constraint === "organization_memberships_org_account_uidx") {
      throw new DuplicateMembershipError("organization membership already exists");
    }
    throw new UniqueConstraintError(
      metadata.constraint === undefined
        ? "unique constraint violated"
        : `unique constraint violated: ${metadata.constraint}`,
      metadata.constraint,
    );
  }
  if (metadata?.code === "23503") {
    throw new ForeignKeyViolationError("referenced account or organization does not exist");
  }
  if (error instanceof PersistenceError) {
    throw error;
  }
  throw new PersistenceError(error instanceof Error ? error.message : "persistence operation failed");
}
