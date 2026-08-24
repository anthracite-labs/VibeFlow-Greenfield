import { eq, sql } from "drizzle-orm";

import type { ControlPlaneDatabase } from "./client.js";
import { PersistenceError, rejectProviderAuthority, StaleVersionError } from "./errors.js";
import { newId, requireCapabilityKey, requireId } from "./ids.js";
import { projectCapabilities, type ProjectCapabilityRow } from "./schema.js";

function now(): Date {
  return new Date();
}

interface CapabilityProfileVersionRow {
  version: number;
}

function capabilityProfileVersionRows(
  rows: readonly Record<string, unknown>[],
): CapabilityProfileVersionRow[] {
  return rows.map((row) => {
    const version = row["version"];
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
      throw new PersistenceError("capability profile version query returned an invalid version");
    }
    return { version };
  });
}

/**
 * M-015 ProjectCapabilityProfile subordinate persistence.
 *
 * The authoritative set epoch lives in `project_capability_profiles`, not in
 * ProjectProfile. This keeps ProjectProfile's version-zero sentinel truthful
 * while retaining genuine concurrent CAS semantics for capability replacement.
 * Every non-empty capability row is database-FK-bound to the exact
 * (project_id, version) epoch created by this repository.
 */
export class ProjectCapabilityRepository {
  public constructor(private readonly db: ControlPlaneDatabase) {}

  public async getCapabilitiesByProjectId(projectId: string): Promise<ProjectCapabilityRow[]> {
    const id = requireId("projectId", projectId);
    return this.db
      .select()
      .from(projectCapabilities)
      .where(eq(projectCapabilities.projectId, id))
      .orderBy(projectCapabilities.capabilityKey);
  }

  public async getVersionByProjectId(projectId: string): Promise<number> {
    const id = requireId("projectId", projectId);
    const result = await this.db.execute(
      sql`SELECT version FROM project_capability_profiles WHERE project_id = ${id}`,
    );
    const rows = capabilityProfileVersionRows(result.rows);
    return rows[0]?.version ?? 0;
  }

  public async replaceCapabilities(input: {
    projectId: string;
    expectedVersion: number;
    capabilities: readonly string[];
  }): Promise<ProjectCapabilityRow[]> {
    rejectProviderAuthority(input as unknown as Record<string, unknown>);
    const projectId = requireId("projectId", input.projectId);

    for (const key of input.capabilities) {
      requireCapabilityKey(key);
    }

    return this.db.transaction(async (tx) => {
      const changedAt = now();

      // The insert establishes a durable version-zero capability profile without
      // manufacturing a ProjectProfile. ON CONFLICT avoids aborting a concurrent
      // first-writer transaction; SELECT FOR UPDATE below serializes the CAS.
      await tx.execute(
        sql`INSERT INTO project_capability_profiles (project_id, version, created_at, updated_at)
            VALUES (${projectId}, 0, ${changedAt}, ${changedAt})
            ON CONFLICT (project_id) DO NOTHING`,
      );

      const lockResult = await tx.execute(
        sql`SELECT version
            FROM project_capability_profiles
            WHERE project_id = ${projectId}
            FOR UPDATE`,
      );
      const rows = capabilityProfileVersionRows(lockResult.rows);
      const current = rows[0];
      if (!current) {
        throw new PersistenceError("project_capability_profiles row not found after insert");
      }

      if (current.version !== input.expectedVersion) {
        throw new StaleVersionError(
          "capability version conflict: expected " +
            input.expectedVersion +
            ", current " +
            current.version,
        );
      }

      const newVersion = current.version + 1;

      // Old rows reference the old epoch, so remove them before advancing the
      // authoritative version. The FK then guarantees every replacement row is
      // attached to the exact new epoch.
      await tx.delete(projectCapabilities).where(eq(projectCapabilities.projectId, projectId));

      await tx.execute(
        sql`UPDATE project_capability_profiles
            SET version = ${newVersion}, updated_at = ${changedAt}
            WHERE project_id = ${projectId}`,
      );

      if (input.capabilities.length === 0) {
        return [];
      }

      const uniqueSorted = [...new Set(input.capabilities)].sort();
      const resultRows = await tx
        .insert(projectCapabilities)
        .values(
          uniqueSorted.map((key) => ({
            id: newId(),
            projectId,
            capabilityKey: key,
            version: newVersion,
            createdAt: changedAt,
          })),
        )
        .returning();

      return resultRows.sort((a, b) => a.capabilityKey.localeCompare(b.capabilityKey));
    });
  }
}
