#!/usr/bin/env python3
"""M-015 project lifecycle E2E contract tests.

These assert the M-015 authority contract as source-level invariants.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

MIGRATION = ROOT / "migrations/0007_project_lifecycle.sql"
RESIDUAL_MIGRATION = ROOT / "migrations/0009_audit_residual_integrity.sql"
PERSISTENCE_INDEX = ROOT / "packages/persistence/src/index.ts"
REPOSITORIES = ROOT / "packages/persistence/src/repositories.ts"
CAPABILITY_REPOSITORY = ROOT / "packages/persistence/src/capability-repository.ts"
OVERVIEW_REPOSITORY = ROOT / "packages/persistence/src/overview-repository.ts"
IDS = ROOT / "packages/persistence/src/ids.ts"
ERRORS = ROOT / "packages/persistence/src/errors.ts"

PROFILE_SERVICE = ROOT / "packages/project/src/profile-service.ts"
CAP_PROFILE_SERVICE = ROOT / "packages/project/src/capability-profile-service.ts"
OVERVIEW_SERVICE = ROOT / "packages/project/src/overview-service.ts"
PROJECT_INDEX = ROOT / "packages/project/src/index.ts"
PROJECT_ERRORS = ROOT / "packages/project/src/errors.ts"

EVENT_CATALOG = ROOT / "master-build-system/03_BACKEND/EVENT_CATALOG.yaml"
STATE_MACHINES = ROOT / "master-build-system/03_BACKEND/STATE_MACHINES.yaml"
AUTHZ_TYPES = ROOT / "packages/authorization/src/types.ts"


class M015AuthorityContract(unittest.TestCase):
    """M-015 must not invent canonical resources, state machines, or events."""

    def test_no_new_canonical_resource_type_in_authz(self):
        """M-015 must not register new authorization resource types."""
        authz_content = AUTHZ_TYPES.read_text()
        resource_types = re.findall(
            r'"([a-z_]+)"',
            authz_content.split("RESOURCE_TYPES")[1].split("]")[0],
        )
        known = {"organization", "project", "artifact", "artifact_relation"}
        for resource_type in resource_types:
            if resource_type not in known:
                self.fail(f"Unknown resource type found: {resource_type}")

    def test_no_new_profile_canonical_resource_type(self):
        """ProjectProfile and ProjectCapabilityProfile must not appear as authz resource types."""
        authz_content = AUTHZ_TYPES.read_text()
        for invented in (
            "project_profile",
            "project_capability_profile",
            "project_overview",
            "profile",
            "capability",
        ):
            if invented in authz_content:
                self.fail(f"M-015 must not register '{invented}' as authz resource type")

    def test_event_catalog_has_no_m015_project_profile_events(self):
        """M-015 must not invent Project profile/capability/overview event families."""
        event_content = EVENT_CATALOG.read_text()
        event_names = re.findall(r"(?m)^  name:\s*([^\s#]+)\s*$", event_content)
        self.assertGreater(len(event_names), 0, "event catalog parser found no event names")
        forbidden_prefixes = (
            "project.profile",
            "project.capability",
            "project.overview",
            "project.lifecycle",
            "profile.",
            "capability_profile.",
            "project_profile.",
        )
        for event_name in event_names:
            lowered = event_name.lower()
            self.assertFalse(
                any(lowered.startswith(prefix) for prefix in forbidden_prefixes),
                f"M-015 must not invent Project profile/lifecycle event: {event_name}",
            )

    def test_state_machines_have_no_project_lifecycle_machine(self):
        """M-015 must not add a Project/Profile/Capability state machine."""
        sm_content = STATE_MACHINES.read_text()
        machine_names = re.findall(r"(?m)^  ([A-Za-z][A-Za-z0-9]*):\s*$", sm_content)
        self.assertGreater(len(machine_names), 0, "state-machine parser found no machines")
        for invented in ("Project", "ProjectProfile", "ProjectCapabilityProfile", "ProjectOverview"):
            self.assertNotIn(invented, machine_names)

    def test_migration_has_project_profiles_table(self):
        """Migration must create project_profiles."""
        sql = MIGRATION.read_text()
        self.assertIn("CREATE TABLE project_profiles", sql)

    def test_migration_has_project_capabilities_table(self):
        """Migration must create project_capabilities."""
        sql = MIGRATION.read_text()
        self.assertIn("CREATE TABLE project_capabilities", sql)

    def test_migration_cover_fk(self):
        """Migration must enforce cover artifact same-Project via composite FK."""
        sql = MIGRATION.read_text()
        self.assertIn("project_profiles_cover_fk", sql)
        self.assertIn("FOREIGN KEY (project_id, cover_artifact_id)", sql)

    def test_migration_capability_key_grammar(self):
        """Capability key check constraint uses open grammar."""
        sql = MIGRATION.read_text()
        self.assertIn("project_capabilities_key_valid", sql)
        self.assertIn("CHECK (capability_key ~ ", sql)

    def test_migration_no_share_columns(self):
        """M-015 must not add sharing/collaboration columns."""
        sql = MIGRATION.read_text()
        for col in ("shared", "public", "collaborator", "role", "invitation"):
            self.assertNotIn(col, sql.lower())

    def test_capability_key_grammar_open(self):
        """Capability key regex must be open-ended, not a closed enum."""
        ids_content = IDS.read_text()
        self.assertIn("CAPABILITY_KEY_RE", ids_content)
        self.assertIn("/", ids_content)

    def test_stale_version_error_exists(self):
        """StaleVersionError must exist in errors."""
        errors_content = ERRORS.read_text()
        self.assertIn("StaleVersionError", errors_content)

    def test_index_exports_new_services(self):
        """Package index must export new M-015 services."""
        index_content = PROJECT_INDEX.read_text()
        self.assertIn("ProjectProfileService", index_content)
        self.assertIn("ProjectCapabilityProfileService", index_content)
        self.assertIn("ProjectOverviewService", index_content)

    def test_errors_export_new_domain_errors(self):
        """Package errors must include new M-015 errors."""
        errors_content = PROJECT_ERRORS.read_text()
        self.assertIn("ProjectProfileError", errors_content)
        self.assertIn("ProjectCapabilityProfileError", errors_content)
        self.assertIn("ProjectOverviewError", errors_content)

    def test_profile_service_authz_ordering(self):
        """Profile service must authorize before loading cover artifact."""
        service_content = PROFILE_SERVICE.read_text()
        self.assertLess(service_content.index("action: \"update\""), service_content.index("getArtifactById"))

    def test_capability_profile_replace_atomic(self):
        """The exported capability repository must replace in one transaction."""
        repo_content = CAPABILITY_REPOSITORY.read_text()
        index_content = PERSISTENCE_INDEX.read_text()
        self.assertIn("ProjectCapabilityRepository", index_content)
        self.assertIn('from "./capability-repository.js"', index_content)
        self.assertIn("replaceCapabilities", repo_content)
        self.assertIn("transaction", repo_content)
        self.assertIn("FOR UPDATE", repo_content)

    def test_capability_profile_has_independent_durable_epoch(self):
        """Capability state must not manufacture or depend on ProjectProfile state."""
        migration_content = RESIDUAL_MIGRATION.read_text()
        repo_content = CAPABILITY_REPOSITORY.read_text()
        self.assertIn("CREATE TABLE project_capability_profiles", migration_content)
        self.assertIn("project_capabilities_profile_version_fk", migration_content)
        self.assertIn("project_profiles_version_positive", migration_content)
        self.assertIn("INSERT INTO project_capability_profiles", repo_content)
        self.assertNotIn("INSERT INTO project_profiles", repo_content)
        self.assertNotIn("projectProfiles", repo_content)

    def test_capability_profile_read_guards_against_torn_version(self):
        """Capability rows and optimistic-concurrency token must describe one version."""
        service_content = CAP_PROFILE_SERVICE.read_text()
        self.assertIn("versionBefore", service_content)
        self.assertIn("versionAfter", service_content)
        self.assertIn("versionBefore === versionAfter", service_content)
        self.assertIn("version: expectedVersion + 1", service_content)

    def test_overview_is_read_from_one_repeatable_read_snapshot(self):
        """ProjectOverview must not fan out across independent DB snapshots."""
        repository_content = OVERVIEW_REPOSITORY.read_text()
        service_content = OVERVIEW_SERVICE.read_text()
        self.assertIn("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", repository_content)
        self.assertIn("ProjectOverviewRepository", service_content)
        self.assertIn("project_capability_profiles", repository_content)
        self.assertIn("snapshot.capabilityProfileVersion", service_content)
        self.assertNotIn("catch {", service_content)

    def test_persistence_index_exports_overview_snapshot_repository(self):
        index_content = PERSISTENCE_INDEX.read_text()
        self.assertIn("ProjectOverviewRepository", index_content)

    def test_no_provider_fields_in_migration(self):
        """No provider/external identifier columns in new tables."""
        sql = MIGRATION.read_text()
        for field in (
            "provider_id",
            "external_id",
            "repository_id",
            "workspace_id",
            "credential",
            "secret",
        ):
            table_portion = sql[sql.index("CREATE TABLE"):]
            self.assertNotIn(field, table_portion.lower())

    def test_no_provider_fields_in_repositories(self):
        """Repositories reject provider authority fields."""
        repo_content = REPOSITORIES.read_text()
        capability_repo_content = CAPABILITY_REPOSITORY.read_text()
        self.assertIn("rejectProviderAuthority", repo_content)
        self.assertIn("rejectProviderAuthority", capability_repo_content)

    def test_capability_key_validation_rejects_malformed(self):
        """Capability key validator must reject common malformed tokens."""
        ids_content = IDS.read_text()
        self.assertIn("CAPABILITY_KEY_RE", ids_content)
        self.assertIn("two or more", ids_content)
        self.assertIn("[a-z]", ids_content)


if __name__ == "__main__":
    unittest.main()
