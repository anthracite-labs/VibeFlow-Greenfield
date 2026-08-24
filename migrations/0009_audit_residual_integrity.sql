-- Post-audit residual remediation for M-014/M-015.
--
-- 1. Make clone provenance scope invariant under indirect updates of referenced
--    Artifacts and clone-plan endpoints, not only writes to the mapping row.
-- 2. Give ProjectCapabilityProfile its own subordinate version authority so a
--    capability write never needs to manufacture a ProjectProfile row.
--
-- No canonical resource, provider binding, state machine, event family or
-- mission-state transition is introduced here.

-- ---------------------------------------------------------------------------
-- Clone provenance: preserve scope when referenced rows are mutated later.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_clone_artifact_scope_on_artifact_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id AND EXISTS (
    SELECT 1
    FROM project_clone_artifact_map AS mapping
    JOIN project_clone_plans AS plan ON plan.id = mapping.clone_plan_id
    WHERE (mapping.source_artifact_id = NEW.id AND plan.source_project_id <> NEW.project_id)
       OR (mapping.target_artifact_id = NEW.id AND plan.target_project_id <> NEW.project_id)
  ) THEN
    RAISE EXCEPTION 'Artifact Project ownership change would invalidate clone provenance scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clone_artifact_scope_on_artifact_update
  ON artifacts;

CREATE TRIGGER clone_artifact_scope_on_artifact_update
BEFORE UPDATE OF project_id
ON artifacts
FOR EACH ROW
EXECUTE FUNCTION enforce_clone_artifact_scope_on_artifact_update();

CREATE OR REPLACE FUNCTION enforce_clone_artifact_scope_on_plan_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project_clone_artifact_map AS mapping
    JOIN artifacts AS source_artifact ON source_artifact.id = mapping.source_artifact_id
    JOIN artifacts AS target_artifact ON target_artifact.id = mapping.target_artifact_id
    WHERE mapping.clone_plan_id = NEW.id
      AND (
        source_artifact.project_id <> NEW.source_project_id
        OR target_artifact.project_id <> NEW.target_project_id
      )
  ) THEN
    RAISE EXCEPTION 'clone plan Project endpoint change would invalidate clone provenance scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clone_artifact_scope_on_plan_update
  ON project_clone_plans;

CREATE TRIGGER clone_artifact_scope_on_plan_update
BEFORE UPDATE OF source_project_id, target_project_id
ON project_clone_plans
FOR EACH ROW
EXECUTE FUNCTION enforce_clone_artifact_scope_on_plan_update();

-- ---------------------------------------------------------------------------
-- ProjectCapabilityProfile: independent subordinate version authority.
-- ---------------------------------------------------------------------------

-- Refuse to migrate already-incoherent capability row epochs. The pre-0009
-- implementation intended every row in one Project set to carry one version.
DO $$
BEGIN
  IF EXISTS (
    SELECT project_id
    FROM project_capabilities
    GROUP BY project_id
    HAVING count(DISTINCT version) > 1
  ) THEN
    RAISE EXCEPTION 'project_capabilities contains multiple epochs for one Project';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM project_capabilities AS capability
    JOIN project_profiles AS profile ON profile.project_id = capability.project_id
    WHERE profile.capability_profile_version <> capability.version
  ) THEN
    RAISE EXCEPTION 'legacy capability profile version disagrees with capability rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM project_profiles
    WHERE version = 0
      AND (description IS NOT NULL OR cover_artifact_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'version-zero ProjectProfile row contains real profile state';
  END IF;
END;
$$;

CREATE TABLE project_capability_profiles (
  project_id uuid PRIMARY KEY REFERENCES projects (id),
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT project_capability_profiles_version_non_negative
    CHECK (version >= 0),
  CONSTRAINT project_capability_profiles_project_version_uidx
    UNIQUE (project_id, version)
);

-- Migrate the durable epoch even when the current capability set is empty.
INSERT INTO project_capability_profiles (project_id, version, created_at, updated_at)
SELECT project_id, capability_profile_version, created_at, updated_at
FROM project_profiles
WHERE capability_profile_version > 0;

-- Defensive compatibility for any capability rows written directly without a
-- project_profiles backing row. Coherent rows are admitted; corrupt mixed
-- epochs were rejected above.
INSERT INTO project_capability_profiles (project_id, version, created_at, updated_at)
SELECT
  capability.project_id,
  max(capability.version),
  min(capability.created_at),
  max(capability.created_at)
FROM project_capabilities AS capability
GROUP BY capability.project_id
ON CONFLICT (project_id) DO NOTHING;

-- Every capability row must now belong to the exact authoritative set epoch.
ALTER TABLE project_capabilities
  ADD CONSTRAINT project_capabilities_profile_version_fk
  FOREIGN KEY (project_id, version)
  REFERENCES project_capability_profiles (project_id, version);

-- The legacy column remains physically present for Drizzle compatibility in
-- this bounded remediation, but it is permanently inert. New capability writes
-- use project_capability_profiles exclusively.
UPDATE project_profiles
SET capability_profile_version = 0
WHERE capability_profile_version <> 0;

ALTER TABLE project_profiles
  ADD CONSTRAINT project_profiles_legacy_capability_version_zero
  CHECK (capability_profile_version = 0);

-- Version-zero rows were synthetic storage created solely to host the legacy
-- capability epoch. Once migrated they are not ProjectProfile state and can be
-- removed. Future persisted ProjectProfile rows must be real version >= 1 rows.
DELETE FROM project_profiles
WHERE version = 0
  AND description IS NULL
  AND cover_artifact_id IS NULL;

ALTER TABLE project_profiles
  DROP CONSTRAINT project_profiles_version_non_negative;

ALTER TABLE project_profiles
  ADD CONSTRAINT project_profiles_version_positive
  CHECK (version >= 1);
