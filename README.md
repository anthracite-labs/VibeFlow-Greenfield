# VibeFlow

VibeFlow is a mobile-first control, policy, durability, recovery, and independent-verification layer for agentic software development. It coordinates independently owned agents, model providers, workspaces, repositories, tools/data connections, and deployment providers without requiring one provider to own the full stack.

The phone is a control, approval, and inspection surface. It is not the execution owner.

## Start here

For development:

1. Read `AGENTS.md`.
2. Read `CHECKPOINT.md`.
3. Inspect the code and tests relevant to the requested change.
4. Load Master Build System files only when the task touches the authority they define.

Do not use historical evidence as current project status. `CHECKPOINT.md` is the current handoff; `master-build-system/10_IMPLEMENTATION/MISSION_DAG.yaml` remains authoritative for mission status and dependencies.

## Current mission pointer

Active/reviewable mission: **M-015**. This single pointer is retained because repository integrity validation requires the human-facing README to name the mission selected by the authoritative DAG. Current implementation/validation state belongs in `CHECKPOINT.md`, not here.

The current authoritative active/reviewable mission is **M-016**. This pointer exists because retained integrity validation requires human-facing entry points to name the mission selected by the DAG; do not infer broader status or acceptance from this README.
Update this pointer only in the same change that advances the authoritative mission state and checkpoint.

## Stack

Update the M-016 pointer in this README only in the same mission-progression change that updates the authoritative DAG. If a historical document or evidence file disagrees with current mission authority, the Master Build System and mission DAG win.
- Node.js 24
- pnpm 11.4.0
- TypeScript 6
- Turborepo
- Vitest
- Python 3 stdlib validation/integration harnesses
- PostgreSQL-backed live integration paths where required by a mission

## Repository map

- `packages/` — shared product/domain packages and canonical implementation surfaces
- `apps/`, `services/`, `workers/`, `adapters/` — application/provider surfaces activated by missions
- `migrations/` — durable persistence migrations
- `scripts/`, `tests/` — validation, contract, integration, and repository tooling
- `infrastructure/`, `security/` — development/security policy and supporting configuration
- `master-build-system/` — retained authoritative product/architecture/security/mission contracts used by validators and code generation
- `evidence/` — retained mission acceptance evidence; historical, not current work direction
- `reference/` — clean-room implementation-reference evidence
- `docs/` — durable implementation notes and ADRs

## Install

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Validate

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run contracts:check
pnpm run check
```

Some integration checks require PostgreSQL and `DATABASE_URL`; a skipped live test is not equivalent to a verified pass.

## AI contributors

Keep permanent operating rules in `AGENTS.md` and current project state in `CHECKPOINT.md`. Do not create provider-specific instruction files or duplicate status documents unless a tool requires a compatibility pointer.

The repository is the canonical working tree. Keep changes reviewable and leave it in a state the next developer or agent can continue from immediately.
