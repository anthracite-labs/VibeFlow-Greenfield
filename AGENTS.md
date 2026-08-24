# VibeFlow Agent Instructions

## Start

Before changing code or repository structure:

1. Read `CHECKPOINT.md`.
2. Inspect the implementation and tests relevant to the task.
3. Load only the Master Build System files that govern the boundary being changed.
4. If code/tests contradict prose, stop and resolve the discrepancy rather than guessing.

`CHECKPOINT.md` is the current multi-agent handoff. The mission DAG remains authoritative for mission status/dependencies.

## Stable product rules

- VibeFlow owns product authority, policy, approvals, durable task/execution state, normalized events, reconciliation, checkpoints, evidence, verification, releases, entitlements, notifications, and audit.
- External agents, model providers, Git hosting, arbitrary workspace compute, application data/storage, and deployment runtimes stay behind explicit bindings/adapters unless a later accepted decision changes ownership.
- Agent completion is only candidate completion. VibeFlow independent verification is what permits a `VERIFIED` claim.
- Repository, workspace, storage, execution runtime, agent, and model provider are distinct concepts. Do not collapse them.
- Provider-specific code stays behind adapters.
- Raw provider/BYOK secrets must never enter client-readable project state or the native/web bridge.
- Tool availability does not imply permission; grants, policy, and approvals govern use.
- Canonical resources/state machines are cross-surface contracts. Do not invent parallel status vocabularies in UI, backend, adapters, or providers.
- Durable commands must be idempotent/deduplicated where their owning contract requires it.
- For external framework/API behavior, follow `master-build-system/04_AI_AGENT/IMPLEMENTATION_REFERENCE_POLICY.yaml`: resolve the installed version and use the highest applicable version-matched official authority before implementation or verification.

## Scope discipline

- Work only the requested task and the currently unlocked mission boundary.
- Do not advance a later mission "while here".
- Do not mark a mission `DONE` or a capability verified without the required gates/evidence.
- Do not delete placeholder packages, retained validators, Master Build System inputs, or mission evidence merely because they are not runtime code. Some are contract-tested repository inputs.
- Do not add a dependency unless the approved dependency/harvest policy or an accepted ADR allows it.
- Keep architecture changes explicit and small. Add an ADR only when a durable architectural decision actually changes.

## Context discipline

Use progressive disclosure:

1. `AGENTS.md`
2. `CHECKPOINT.md`
3. relevant code/tests
4. relevant `docs/`
5. only the exact `master-build-system/` authority needed
6. historical `evidence/` only when verification/provenance is part of the task

Do not preload the full Master Build System or historical mission evidence for ordinary implementation work.

## Repository workflow

- GitHub is the canonical development workspace/source of truth.
- Prefer a focused branch and reviewable commit/PR.
- Preserve unrelated working code and tests.
- Never commit secrets, local credentials, generated dependency directories, local databases, build caches, or machine-specific state.
- Update `CHECKPOINT.md` after materially advancing project state, changing the current blocker, or producing new authoritative validation results.
- Keep permanent rules here; keep current/recent state out of this file.

## Validation

Run the smallest relevant checks during development, then the appropriate broader gate before handoff. Common commands:

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run contracts:check
pnpm run reference:validate
pnpm run security:validate
pnpm run dev:validate
pnpm run check
```

Some integration gates require PostgreSQL/`DATABASE_URL`. Report unavailable or skipped live checks explicitly; never convert a skip into a pass.
