# 2026-08-21 Post-Audit Residual Remediation

## Status

This is the current additive evidence record for the independent repository audit remediation that followed the merge of PR #28. It does **not** replace the authoritative Master Build System and it deliberately does not claim that its own containing commit passed CI.

Acceptance authority is the GitHub Actions run set for the exact candidate/main commit being accepted. Any later push invalidates an older run set as acceptance proof.

`M-015` remains `REVIEW`. `M-016` and later missions remain locked. No mission-state transition is part of this remediation.

## Authoritative boundaries rechecked

The remediation preserves the current Project Authority model:

`Account -> Organization membership -> Project -> Artifact / ArtifactRelation`

ProjectProfile and ProjectCapabilityProfile remain subordinate Project-domain state. ProjectOverview remains a projection/read model. No new canonical resource, authorization resource type, Project state machine, M-015 event family, provider binding, provider adapter, collaboration surface, or later-mission capability is introduced.

Authoritative sources remain:

- `master-build-system/00_MASTER/MASTER_OF_MASTERS.md`
- `master-build-system/02_ARCHITECTURE/CANONICAL_RESOURCE_MODEL.yaml`
- `master-build-system/03_BACKEND/EVENT_CATALOG.yaml`
- `master-build-system/03_BACKEND/STATE_MACHINES.yaml`
- `master-build-system/08_SECURITY/THREAT_MODEL.md`
- `master-build-system/10_IMPLEMENTATION/MISSION_DAG.yaml`

## Residuals closed

### R-01 — clone provenance scope after indirect updates

`migrations/0008_audit_remediation.sql` originally guarded writes to `project_clone_artifact_map` itself. A later direct database update of a referenced Artifact's `project_id`, or a clone plan's source/target Project endpoint, could make an already-valid mapping inconsistent without firing that trigger.

`migrations/0009_audit_residual_integrity.sql` adds reverse guards on:

- `artifacts.project_id` updates; and
- `project_clone_plans.source_project_id` / `target_project_id` updates.

Both reject a proposed update with SQLSTATE `23514` when it would invalidate any existing clone Artifact mapping.

### R-02 — capability epoch stored inside ProjectProfile

The pre-remediation `ProjectCapabilityRepository` used `project_profiles.capability_profile_version` and manufactured a version-zero `project_profiles` row when capabilities were written before real profile metadata. That contradicted the API/schema meaning of ProjectProfile version zero as "no ProjectProfile yet".

The current exported `ProjectCapabilityRepository` now uses a dedicated subordinate table:

- `project_capability_profiles(project_id, version, created_at, updated_at)`

`project_capabilities(project_id, version)` is foreign-key bound to the exact authoritative capability epoch. The migration moves legacy epochs, deletes synthetic version-zero ProjectProfile rows, requires persisted ProjectProfile version `>= 1`, and freezes the legacy capability-version column at zero for bounded compatibility.

Capability replacement retains the same public API and CAS semantics:

1. create the capability epoch row at version zero if absent;
2. lock it with `SELECT ... FOR UPDATE`;
3. compare `expectedVersion`;
4. delete old capability rows;
5. advance the epoch;
6. insert the new set at exactly that epoch.

An empty set therefore still has a durable monotonic version without requiring a ProjectProfile row.

### R-03 — stale handoff/evidence interpretation

Historical mission evidence under `evidence/missions/M-014/` and `evidence/missions/M-015/` remains a record of the candidate state at the time it was authored. It is no longer treated as current-head validation proof.

`CHECKPOINT.md` now states explicitly that:

- Master Build System files are authoritative for product/build truth;
- exact-head GitHub Actions are authoritative for current validation;
- historical mission evidence must not be used to claim the current head is green.

This file is the additive current remediation record, so historical evidence does not need to be rewritten into a false post-hoc snapshot.

## Regression proof added

`packages/persistence/src/audit-residuals.live.test.ts` requires PostgreSQL in CI and proves:

- a valid clone mapping cannot later be invalidated by Artifact re-parenting;
- a valid clone mapping cannot later be invalidated by changing the clone-plan source Project;
- capability replacement does not create a ProjectProfile row;
- capability epoch versioning remains monotonic through non-empty and empty sets;
- direct capability rows with a version that does not match the authoritative capability epoch are rejected by the database FK.

`tests/contract/test_m015_project_lifecycle.py` now follows the **exported** capability repository implementation rather than the retained legacy class in `repositories.ts`, and asserts the independent capability epoch, FK, ProjectProfile-positive-version rule, and ProjectOverview snapshot wiring.

## Validation gate

Before merge/acceptance, verify the exact candidate head has successful required runs for:

- Repository Sanitation
- Master Build System Integrity
- Repository Foundation
- Security & Dependency Gates

Repository Foundation must include the PostgreSQL-backed live tests and the root M-015 contract suite. No prior SHA's run set can substitute for the exact candidate head.
