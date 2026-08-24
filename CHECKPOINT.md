# VibeFlow Checkpoint

Updated: 2026-08-21

This file is a handoff pointer, not authority. Canonical product/build truth remains under `master-build-system/`; exact validation truth is the GitHub Actions run set for the exact candidate/main commit being accepted.

## Current phase

Phase 3 — Project Authority.

`M-001` through `M-014` are `DONE` in the authoritative mission DAG.

`M-015 — Implement project lifecycle E2E` is the sole active mission and remains `REVIEW` in `master-build-system/10_IMPLEMENTATION/MISSION_DAG.yaml`.

M-015 implementation is merged, but implementation merge alone does **not** change the mission from `REVIEW` to `DONE`. `M-016` and later work remains locked until the required M-015 review/acceptance transition occurs.

## M-015 implemented scope

- Project Profile subordinate state
- ProjectCapabilityProfile subordinate state with its own durable set epoch
- ProjectOverview read model from one PostgreSQL `REPEATABLE READ` snapshot
- empty/archive-import/clone creation-mode parity
- authorization/IDOR ordering
- optimistic concurrency and transactional semantics
- PostgreSQL integrity backstops

Explicitly not implemented by M-015: provider bindings, workspace provisioning, agent/model integration, execution/task/deployment, UI/mobile/Canvas, collaboration/sharing, project deletion/archive state, and later-mission features.

## Post-audit remediation state

The independent full-repository audit and its approved remediation tightened the accepted M-014/M-015 implementation without widening mission scope. Current code now includes:

- fail-closed POSIX PAX archive handling;
- coherent capability-profile read/write version responses;
- `REPEATABLE READ` clone and ProjectOverview snapshots;
- constraint-aware uniqueness handling and infrastructure-error propagation;
- migration SHA-256 drift detection;
- staged archive claim cleanup;
- clone Artifact-map scope enforcement on mapping writes **and** later referenced Artifact/clone-plan endpoint updates;
- a dedicated `project_capability_profiles` epoch row, with capability rows FK-bound to the exact `(project_id, version)` and no synthetic ProjectProfile creation;
- executable M-015 authority contracts wired into root `check`.

Historical mission evidence under `evidence/missions/M-014/` and `evidence/missions/M-015/` records the implementation/review state at the time those files were authored. It must not be used as a claim that the current repository head is green. Current acceptance evidence is always the exact-head Actions run set.

## Validation rule

Before accepting M-015:

1. inspect the exact current `main` commit;
2. verify the required Repository Foundation, Master Build System Integrity, Repository Sanitation, and Security & Dependency Gates runs are green for that exact head/candidate;
3. include PostgreSQL-backed live/integration gates where `DATABASE_URL` is required;
4. confirm no authoritative Master Build System invariant is violated;
5. only then perform the repository's M-015 `REVIEW` → `DONE` transition.

A prior green run for an older SHA is not acceptance proof for a newer SHA.

## Important architecture boundaries

- Account → Organization membership → Project → Artifact/ArtifactRelation remains canonical Project authority.
- ProjectProfile and ProjectCapabilityProfile are subordinate Project-domain state, not new canonical roots.
- ProjectOverview is a projection/read model.
- No Project state machine or new M-015 event family is introduced.
- Provider-specific concerns remain outside Project authority and are deferred to their owning missions.

## Repository context note

The repository intentionally retains `master-build-system/`, `.ai/` compatibility/index files, `reference/`, mission `evidence/`, placeholder surfaces, and validators because current code generation/verification contracts reference them. They are not all startup context for an AI agent.

The normal startup path is only:

1. `AGENTS.md`
2. `CHECKPOINT.md`
3. relevant code/tests

Load deeper authority or historical evidence only when the task requires it.
