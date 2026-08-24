import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";

const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

export function defaultMigrationsDirectory(): string {
  return DEFAULT_MIGRATIONS_DIR;
}

export async function listCommittedSqlMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

const MIGRATION_ADVISORY_LOCK = 9_009_001;

function migrationSha256(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

interface AppliedMigrationRow {
  id: string;
  sha256: string | null;
}

/**
 * Applies committed SQL under one PostgreSQL advisory lock. This makes a
 * concurrent startup/test runner observe the recorded migration rather than
 * racing to apply the same durable transition twice.
 *
 * Applied migrations are content-addressed. A historical migration filename
 * may never silently refer to different bytes on an existing database. Legacy
 * rows created before the digest column existed are bound once to the current
 * committed bytes during this upgrade, after which the column is NOT NULL.
 */
export async function applyCommittedSqlMigrations(
  pool: pg.Pool,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
): Promise<{ applied: string[]; skipped: string[] }> {
  const files = await listCommittedSqlMigrations(migrationsDir);
  const committed = new Set(files);
  const applied: string[] = [];
  const skipped: string[] = [];
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS vibeflow_schema_migrations (
        id text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Upgrade databases whose migration ledger predates digest recording.
    await client.query(
      "ALTER TABLE vibeflow_schema_migrations ADD COLUMN IF NOT EXISTS sha256 text",
    );

    const recorded = await client.query<AppliedMigrationRow>(
      "SELECT id, sha256 FROM vibeflow_schema_migrations ORDER BY id",
    );
    for (const row of recorded.rows) {
      if (!committed.has(row.id)) {
        throw new Error(
          `database records migration ${row.id} but that committed migration file is missing`,
        );
      }
    }

    const recordedById = new Map(recorded.rows.map((row) => [row.id, row]));

    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      const sha256 = migrationSha256(sql);
      const existing = recordedById.get(file);

      if (existing !== undefined) {
        if (existing.sha256 === null) {
          // One-time binding for pre-digest migration ledgers. This cannot
          // retrospectively prove old bytes, but prevents all future drift.
          await client.query(
            "UPDATE vibeflow_schema_migrations SET sha256 = $2 WHERE id = $1 AND sha256 IS NULL",
            [file, sha256],
          );
        } else if (existing.sha256 !== sha256) {
          throw new Error(
            `migration content drift detected for ${file}: database=${existing.sha256} repository=${sha256}`,
          );
        }
        skipped.push(file);
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO vibeflow_schema_migrations (id, sha256) VALUES ($1, $2)",
          [file, sha256],
        );
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    // All legacy rows corresponding to committed files have now been bound.
    await client.query(
      "ALTER TABLE vibeflow_schema_migrations ALTER COLUMN sha256 SET NOT NULL",
    );
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK]);
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
