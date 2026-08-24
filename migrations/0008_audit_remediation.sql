-- Audit remediation: strengthen clone provenance integrity without creating a
-- new canonical resource or widening M-014/M-015 product scope.
--
-- project_clone_artifact_map already FK-pins each artifact id to an Artifact,
-- but the original schema did not prove that the source Artifact belongs to
-- the clone plan's source Project or that the target Artifact belongs to the
-- plan's target Project. Keep the existing compact row shape and enforce that
-- cross-table invariant with a database trigger.

CREATE OR REPLACE FUNCTION enforce_project_clone_artifact_map_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_source_project_id uuid;
  expected_target_project_id uuid;
  actual_source_project_id uuid;
  actual_target_project_id uuid;
BEGIN
  SELECT source_project_id, target_project_id
    INTO expected_source_project_id, expected_target_project_id
    FROM project_clone_plans
    WHERE id = NEW.clone_plan_id;

  IF expected_source_project_id IS NULL OR expected_target_project_id IS NULL THEN
    RAISE EXCEPTION 'clone plan does not exist for clone artifact mapping'
      USING ERRCODE = '23503';
  END IF;

  SELECT project_id
    INTO actual_source_project_id
    FROM artifacts
    WHERE id = NEW.source_artifact_id;

  SELECT project_id
    INTO actual_target_project_id
    FROM artifacts
    WHERE id = NEW.target_artifact_id;

  IF actual_source_project_id IS NULL OR actual_target_project_id IS NULL THEN
    RAISE EXCEPTION 'artifact does not exist for clone artifact mapping'
      USING ERRCODE = '23503';
  END IF;

  IF actual_source_project_id <> expected_source_project_id
     OR actual_target_project_id <> expected_target_project_id THEN
    RAISE EXCEPTION 'clone artifact mapping endpoints must match the clone plan source and target Projects'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Refuse to install the trigger over already-corrupt provenance.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project_clone_artifact_map AS mapping
    JOIN project_clone_plans AS plan ON plan.id = mapping.clone_plan_id
    JOIN artifacts AS source_artifact ON source_artifact.id = mapping.source_artifact_id
    JOIN artifacts AS target_artifact ON target_artifact.id = mapping.target_artifact_id
    WHERE source_artifact.project_id <> plan.source_project_id
       OR target_artifact.project_id <> plan.target_project_id
  ) THEN
    RAISE EXCEPTION 'existing clone artifact mapping violates clone plan Project scope';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS project_clone_artifact_map_scope_guard
  ON project_clone_artifact_map;

CREATE TRIGGER project_clone_artifact_map_scope_guard
BEFORE INSERT OR UPDATE OF clone_plan_id, source_artifact_id, target_artifact_id
ON project_clone_artifact_map
FOR EACH ROW
EXECUTE FUNCTION enforce_project_clone_artifact_map_scope();
