import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyCommittedSqlMigrations,
  createControlPlanePool,
  defaultMigrationsDirectory,
  type AccountRow,
  type ControlPlanePool,
  type OrganizationRow,
  type ProjectRow,
  ArtifactRepository,
  ProjectCapabilityRepository,
  ProjectOverviewRepository,
  ProjectProfileRepository,
  ProjectRepository,
  TenantRepository,
} from "@vibeflow/persistence";
import { AuditService } from "@vibeflow/audit";
import { TenantAuthorizationService } from "@vibeflow/authorization";

import { ProjectService } from "./service.js";
import { ArtifactService } from "./artifact-service.js";
import { ProjectProfileService } from "./profile-service.js";
import { ProjectCapabilityProfileService } from "./capability-profile-service.js";
import { ProjectOverviewService } from "./overview-service.js";
import { ProjectNotFoundError } from "./errors.js";

const connectionString = process.env["VIBEFLOW_DATABASE_URL"] ?? process.env["DATABASE_URL"];

if (connectionString === undefined && process.env["CI"] === "true") {
  throw new Error("M-015 Project Overview PostgreSQL tests require DATABASE_URL in CI");
}

const describePostgres = connectionString === undefined ? describe.skip : describe;

describePostgres("M-015 Project Overview service", () => {
  let controlPlane: ControlPlanePool;
  let tenants: TenantRepository;
  let projectsRepo: ProjectRepository;
  let artifactsRepo: ArtifactRepository;
  let profilesRepo: ProjectProfileRepository;
  let capabilitiesRepo: ProjectCapabilityRepository;
  let audit: AuditService;
  let authz: TenantAuthorizationService;
  let projectService: ProjectService;
  let artifactService: ArtifactService;
  let profileService: ProjectProfileService;
  let capService: ProjectCapabilityProfileService;
  let overviewService: ProjectOverviewService;

  let alice: AccountRow;
  let bob: AccountRow;
  let orgA: OrganizationRow;
  let orgB: OrganizationRow;
  let project: ProjectRow;

  beforeAll(async () => {
    controlPlane = createControlPlanePool(connectionString as string);
    await applyCommittedSqlMigrations(controlPlane.pool, defaultMigrationsDirectory());
    tenants = new TenantRepository(controlPlane.db);
    projectsRepo = new ProjectRepository(controlPlane.db);
    artifactsRepo = new ArtifactRepository(controlPlane.db);
    profilesRepo = new ProjectProfileRepository(controlPlane.db);
    capabilitiesRepo = new ProjectCapabilityRepository(controlPlane.db);
    const overviewRepo = new ProjectOverviewRepository(controlPlane.db);
    audit = new AuditService(controlPlane.pool);

    const combined = {
      getOrganizationById: tenants.getOrganizationById.bind(tenants),
      getMembership: tenants.getMembership.bind(tenants),
      getProjectById: projectsRepo.getProjectById.bind(projectsRepo),
      getArtifactById: artifactsRepo.getArtifactById.bind(artifactsRepo),
      getArtifactRelationById: artifactsRepo.getArtifactRelationById.bind(artifactsRepo),
    };

    authz = new TenantAuthorizationService(combined, audit);
    projectService = new ProjectService({ tenants, projects: projectsRepo, authz });
    artifactService = new ArtifactService({ artifacts: artifactsRepo, authz });
    profileService = new ProjectProfileService({ profiles: profilesRepo, artifacts: artifactsRepo, authz });
    capService = new ProjectCapabilityProfileService({ capabilities: capabilitiesRepo, authz });
    overviewService = new ProjectOverviewService({ overview: overviewRepo, authz });

    alice = await tenants.createAccount({ displayName: "Overview Alice" });
    bob = await tenants.createAccount({ displayName: "Overview Bob" });
    orgA = await tenants.createOrganization({ name: "Overview Org A", kind: "standard" });
    orgB = await tenants.createOrganization({ name: "Overview Org B", kind: "standard" });
    await tenants.addMembership({ organizationId: orgA.id, accountId: alice.id });
    await tenants.addMembership({ organizationId: orgB.id, accountId: bob.id });

    project = await projectService.createProject({
      accountId: alice.id,
      organizationId: orgA.id,
      name: "Overview Test Project",
    });
  });

  afterAll(async () => {
    await controlPlane.close();
  });

  it("authorized empty Project overview", async () => {
    const overview = await overviewService.getProjectOverview({ accountId: alice.id, projectId: project.id });
    expect(overview.project.id).toBe(project.id);
    expect(overview.project.organizationId).toBe(orgA.id);
    expect(overview.profile.version).toBe(0);
    expect(overview.capabilityProfile.version).toBe(0);
    expect(overview.artifacts).toEqual([]);
    expect(overview.artifactRelations).toEqual([]);
  });

  it("returns populated profile, capability and artifact graph from the snapshot repository", async () => {
    const populated = await projectService.createProject({
      accountId: alice.id,
      organizationId: orgA.id,
      name: "Populated Overview Project",
    });
    const subject = await artifactService.createArtifact({
      accountId: alice.id,
      projectId: populated.id,
      type: "test/subject",
    });
    const object = await artifactService.createArtifact({
      accountId: alice.id,
      projectId: populated.id,
      type: "test/object",
    });
    const relation = await artifactService.createArtifactRelation({
      accountId: alice.id,
      subjectArtifactId: subject.id,
      objectArtifactId: object.id,
      relationKind: "contains",
    });
    await profileService.updateProjectProfile({
      accountId: alice.id,
      projectId: populated.id,
      expectedVersion: 0,
      description: "snapshot profile",
      coverArtifactId: subject.id,
    });
    await capService.replaceProjectCapabilityProfile({
      accountId: alice.id,
      projectId: populated.id,
      expectedVersion: 0,
      capabilities: ["runtime/node", "artifact/web"],
    });

    const overview = await overviewService.getProjectOverview({
      accountId: alice.id,
      projectId: populated.id,
    });

    expect(overview.profile.description).toBe("snapshot profile");
    expect(overview.profile.coverArtifactId).toBe(subject.id);
    expect(overview.capabilityProfile.version).toBe(1);
    expect(overview.capabilityProfile.capabilities).toEqual(["artifact/web", "runtime/node"]);
    expect(overview.artifacts.map((row) => row.id).sort()).toEqual([object.id, subject.id].sort());
    expect(overview.artifactRelations.map((row) => row.id)).toContain(relation.id);
  });

  it("cross-tenant overview denied", async () => {
    await expect(
      overviewService.getProjectOverview({ accountId: bob.id, projectId: project.id }),
    ).rejects.toThrow();
  });

  it("unknown Project overview opaque", async () => {
    const unknown = randomUUID();
    await expect(
      overviewService.getProjectOverview({ accountId: alice.id, projectId: unknown }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
