# Active Mission

**Mission:** M-016 — Implement binding resource family

**Status:** READY

**Phase:** 4 — Provider Bindings

Authoritative mission row:
`master-build-system/10_IMPLEMENTATION/MISSION_DAG.yaml` (M-016)

M-001 through M-015 are accepted and `DONE`. M-016 is the sole active mission
and is `READY` for implementation. M-017 and all later missions remain
`LOCKED` and remain required for V1.

## M-016 scope

Authoritative mission scope:
- Agent/Model/Workspace/Repo/Data/Storage/Deployment binding resource family
- preserve VibeFlow-owned binding metadata/policy while external providers remain authoritative for their runtimes, repositories, data and objects
- canonical binding resources: AgentBinding, ModelBinding, WorkspaceBinding, RepositoryBinding, DeploymentBinding, DataBinding and ObjectStorageBinding
- preserve canonical Project/Organization authority and tenant isolation across every binding

Implementation guardrails:
- external/provider IDs are references and never become VibeFlow Project/Organization authority
- M-017 provider capability discovery remains a separate locked mission
- M-020+ Connection, ConnectionGrant and SecretRef broker/grant semantics remain later scope
- provider-specific adapters, workspace provisioning, task/execution, deployment execution, UI/mobile/Canvas and later mission scope must not be inferred from this READY pointer
- exact implementation and acceptance semantics must be derived from the Master Build System before code changes begin

At implementation start, transition M-016 from `READY` to `IN_PROGRESS` in
the authoritative mission files and update the synchronized human-facing
mission pointers in the same change.
## M-015 scope

Implemented:
- Project Profile subordinate state (VF-PRJ-016 IN_PROGRESS)
- ProjectCapabilityProfile (VF-PRJ-014 IMPLEMENTED), with independent durable set epoch
- ProjectOverview read model from one PostgreSQL snapshot
- Creation-mode E2E parity (empty, archive-import, clone)
- Full authorization/IDOR ordering compliance
- Optimistic concurrency and transactional semantics
- PostgreSQL integrity backstops

Explicitly out of scope:
- M-016+ provider bindings
- GitHub/Bitbucket/Vercel/Figma provider implementations
- workspace provisioning
- agent/model integrations
- execution/task/deployment
- UI/mobile/Canvas
- Collaboration/sharing (M-117+)
- later mission scope

## Current validation pointer

Historical mission evidence remains under `evidence/missions/M-014/` and
`evidence/missions/M-015/`; it records the candidate state when authored and is
not current-head CI proof.

Current post-audit remediation evidence:
`evidence/audits/2026-08-21_POST_AUDIT_RESIDUAL_REMEDIATION.md`.

Before any M-015 acceptance transition, verify the required GitHub Actions runs
for the **exact** candidate/main SHA. `CHECKPOINT.md` contains the handoff rule.
