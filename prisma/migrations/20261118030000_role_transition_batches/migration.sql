-- Durable persistence for Step 7 role transition execution batches & exact rollback CAS state.
CREATE TABLE IF NOT EXISTS "role_transition_batches" (
  "batch_id"              VARCHAR(64) PRIMARY KEY,
  "target_database"       VARCHAR(255) NOT NULL,
  "database_name"         VARCHAR(128) NOT NULL,
  "manifest_version"      VARCHAR(100) NOT NULL,
  "manifest_hash"         VARCHAR(64) NOT NULL,
  "actor_user_id"         BIGINT NOT NULL,
  "status"                VARCHAR(30) NOT NULL DEFAULT 'EXECUTED',
  "rollback_payload"      JSONB NOT NULL,
  "executed_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rolled_back_at"        TIMESTAMPTZ(6),
  "rolled_back_by_user_id" BIGINT,
  CONSTRAINT "chk_role_transition_batches_status"
    CHECK ("status" IN ('EXECUTED', 'ROLLED_BACK'))
);

CREATE INDEX IF NOT EXISTS "idx_role_transition_batches_status_exec"
  ON "role_transition_batches"("status", "executed_at" DESC);
