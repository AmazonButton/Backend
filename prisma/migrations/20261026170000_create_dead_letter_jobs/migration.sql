-- CreateTable
CREATE TABLE "dead_letter_jobs" (
    "id" VARCHAR(64) NOT NULL,
    "queue_name" VARCHAR(64) NOT NULL,
    "job_name" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts_made" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "failed_reason" TEXT,
    "stacktrace" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(32) NOT NULL DEFAULT 'DEAD',
    "failed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_dead_letter_queue_name" ON "dead_letter_jobs"("queue_name");

-- CreateIndex
CREATE INDEX "idx_dead_letter_status" ON "dead_letter_jobs"("status");
