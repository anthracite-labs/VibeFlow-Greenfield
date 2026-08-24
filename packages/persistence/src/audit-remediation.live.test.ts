import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyCommittedSqlMigrations,
  defaultMigrationsDirectory,
  listCommittedSqlMigrations,
} from "./migrate.js";
import { createControlPlanePool, type ControlPlanePool } from "./client.js";
import { ArtifactRepository, ProjectRepository, TenantRepository } from "./repositories.js";

const connectionString = process.env["VIBEFLOW_DATABASE_URL"] ?? process.env["DATABASE_URL"];

if (connectionString === undefined && process.env["CI"] === "true") {
  throw new Error("audit remediation PostgreSQL tests require DATABASE_URL in CI");
}

const describePostgres = connectionString === undefined ? describe.skip : describe;

describePostgres("audit remediation persistence backstops", () => {
  let controlPlane: ControlPlanePool;

  beforeAll(async () => {
    controlPlane = createControlPlanePool(connectionString as string);
    await applyCommittedSqlMigrations(controlPlane.pool, defaultMigrationsDirectory());
  });

  afterAll(async () => {
    await controlPlane.close();
  });

  it("records migration SHA-256 and rejects changed bytes for an applied filename", async () => {
    const rows = await controlPlane.pool.query<{ id: string; sha256: string }>(
      "SELECT id, sha256 FROM vibeflow_schema_migrations ORDER BY id",
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    const sourceDir = defaultMigrationsDirectory();
    const copyDir = await mkdtemp(path.join(tmpdir(), "vibeflow-migration-integrity-"));
    try {
      const files = await listCommittedSqlMigrations(sourceDir);
      for (const file of files) {
        await copyFile(path.join(sourceDir, file), path.join(copyDir, file));
      }
      const probe = files.at(-1);
      if (probe === undefined) {
        throw new Error("expected at least one committed migration");
      }
      await appendFile(path.join(copyDir, probe), "\n-- mutation probe\n", "utf8");

      await expect(
        applyCommittedSqlMigrations(controlPlane.pool, copyDir),
      ).rejects.toThrow(/migration content drift detected/);
    } finally {
      await rm(copyDir, { recursive: true, force: true });
    }
  });

  it("rejects clone provenance whose Artifact endpoints do not match the clone plan Projects", async () => {
    const tenants = new TenantRepository(controlPlane.db);
    const projects = new ProjectRepository(controlPlane.db);
    const artifacts = new ArtifactRepository(controlPlane.db);

    const actor = await tenants.createAccount({ displayName: "Clone Scope Actor" });
    const organization = await tenants.createOrganization({
      name: "Clone Scope Org",
      kind: "standard",
    });
    const source = await projects.createProject({
      organizationId: organization.id,
      name: "Clone Scope Source",
    });
    const target = await projects.createProject({
      organizationId: organization.id,
      name: "Clone Scope Target",
    });
    const otherSource = await projects.createProject({
      organizationId: organization.id,
      name: "Clone Scope Other Source",
    });

    const sourceArtifact = await artifacts.createArtifact({
      projectId: source.id,
      type: "test/source",
    });
    const wrongSourceArtifact = await artifacts.createArtifact({
      projectId: otherSource.id,
      type: "test/wrong-source",
    });
    const targetArtifact = await artifacts.createArtifact({
      projectId: target.id,
      type: "test/target",
    });
    const secondTargetArtifact = await artifacts.createArtifact({
      projectId: target.id,
      type: "test/target-2",
    });

    const planId = randomUUID();
    await controlPlane.pool.query(
      `INSERT INTO project_clone_plans (
         id, organization_id, source_project_id, target_project_id,
         actor_account_id, plan_kind, artifact_count, relation_count,
         idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'project_clone', 1, 0, $6, now())`,
      [
        planId,
        organization.id,
        source.id,
        target.id,
        actor.id,
        `scope-${randomUUID()}`,
      ],
    );

    await controlPlane.pool.query(
      `INSERT INTO project_clone_artifact_map (
         id, clone_plan_id, source_artifact_id, target_artifact_id
       ) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), planId, sourceArtifact.id, targetArtifact.id],
    );

    await expect(
      controlPlane.pool.query(
        `INSERT INTO project_clone_artifact_map (
           id, clone_plan_id, source_artifact_id, target_artifact_id
         ) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), planId, wrongSourceArtifact.id, secondTargetArtifact.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
