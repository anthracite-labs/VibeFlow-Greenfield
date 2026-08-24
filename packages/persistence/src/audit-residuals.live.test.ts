import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectCapabilityRepository } from "./capability-repository.js";
import { createControlPlanePool, type ControlPlanePool } from "./client.js";
import {
  applyCommittedSqlMigrations,
  defaultMigrationsDirectory,
} from "./migrate.js";
import { ArtifactRepository, ProjectRepository, TenantRepository } from "./repositories.js";

const connectionString = process.env["VIBEFLOW_DATABASE_URL"] ?? process.env["DATABASE_URL"];

if (connectionString === undefined && process.env["CI"] === "true") {
  throw new Error("audit residual PostgreSQL tests require DATABASE_URL in CI");
}

const describePostgres = connectionString === undefined ? describe.skip : describe;

describePostgres("post-audit residual persistence invariants", () => {
  let controlPlane: ControlPlanePool;

  beforeAll(async () => {
    controlPlane = createControlPlanePool(connectionString as string);
    await applyCommittedSqlMigrations(controlPlane.pool, defaultMigrationsDirectory());
  });

  afterAll(async () => {
    await controlPlane.close();
  });

  it("keeps clone Artifact mapping scope valid under later referenced-row updates", async () => {
    const tenants = new TenantRepository(controlPlane.db);
    const projects = new ProjectRepository(controlPlane.db);
    const artifacts = new ArtifactRepository(controlPlane.db);

    const actor = await tenants.createAccount({ displayName: "Residual Clone Actor" });
    const organization = await tenants.createOrganization({
      name: "Residual Clone Org",
      kind: "standard",
    });
    const source = await projects.createProject({
      organizationId: organization.id,
      name: "Residual Clone Source",
    });
    const target = await projects.createProject({
      organizationId: organization.id,
      name: "Residual Clone Target",
    });
    const alternateSource = await projects.createProject({
      organizationId: organization.id,
      name: "Residual Alternate Source",
    });

    const sourceArtifact = await artifacts.createArtifact({
      projectId: source.id,
      type: "test/source",
    });
    const targetArtifact = await artifacts.createArtifact({
      projectId: target.id,
      type: "test/target",
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
        `residual-${randomUUID()}`,
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
        "UPDATE artifacts SET project_id = $1 WHERE id = $2",
        [alternateSource.id, sourceArtifact.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      controlPlane.pool.query(
        "UPDATE project_clone_plans SET source_project_id = $1 WHERE id = $2",
        [alternateSource.id, planId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const sourceAfter = await artifacts.getArtifactById(sourceArtifact.id);
    expect(sourceAfter.projectId).toBe(source.id);
    const planAfter = await controlPlane.pool.query<{ source_project_id: string }>(
      "SELECT source_project_id FROM project_clone_plans WHERE id = $1",
      [planId],
    );
    expect(planAfter.rows[0]?.source_project_id).toBe(source.id);
  });

  it("stores capability set epochs independently from ProjectProfile", async () => {
    const tenants = new TenantRepository(controlPlane.db);
    const projects = new ProjectRepository(controlPlane.db);
    const capabilities = new ProjectCapabilityRepository(controlPlane.db);

    const organization = await tenants.createOrganization({
      name: "Residual Capability Org",
      kind: "standard",
    });
    const project = await projects.createProject({
      organizationId: organization.id,
      name: "Residual Capability Project",
    });

    const beforeProfile = await controlPlane.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM project_profiles WHERE project_id = $1",
      [project.id],
    );
    expect(beforeProfile.rows[0]?.count).toBe("0");

    const first = await capabilities.replaceCapabilities({
      projectId: project.id,
      expectedVersion: 0,
      capabilities: ["runtime/node"],
    });
    expect(first.map((row) => row.version)).toEqual([1]);
    expect(await capabilities.getVersionByProjectId(project.id)).toBe(1);

    const profileAfterWrite = await controlPlane.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM project_profiles WHERE project_id = $1",
      [project.id],
    );
    expect(profileAfterWrite.rows[0]?.count).toBe("0");

    const epoch = await controlPlane.pool.query<{ version: number }>(
      "SELECT version FROM project_capability_profiles WHERE project_id = $1",
      [project.id],
    );
    expect(epoch.rows[0]?.version).toBe(1);

    await expect(
      controlPlane.pool.query(
        `INSERT INTO project_capabilities (id, project_id, capability_key, version, created_at)
         VALUES ($1, $2, 'runtime/invalidepoch', 999, now())`,
        [randomUUID(), project.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    const empty = await capabilities.replaceCapabilities({
      projectId: project.id,
      expectedVersion: 1,
      capabilities: [],
    });
    expect(empty).toEqual([]);
    expect(await capabilities.getVersionByProjectId(project.id)).toBe(2);

    const finalProfile = await controlPlane.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM project_profiles WHERE project_id = $1",
      [project.id],
    );
    expect(finalProfile.rows[0]?.count).toBe("0");
  });
});
