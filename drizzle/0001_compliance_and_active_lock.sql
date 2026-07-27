-- Compliance + atomic active-call lock
-- Apply with: npm run db:migrate

CREATE TABLE IF NOT EXISTS suppressed_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS suppressed_numbers_phone_unique
  ON suppressed_numbers (phone_number);

-- Close stuck duplicate active rows so the unique index can be created.
-- Keep the newest row per (property_id, phone_number); mark the rest failed.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY property_id, phone_number
      ORDER BY coalesce(updated_at, created_at) DESC, created_at DESC, id DESC
    ) AS rn
  FROM call_logs
  WHERE status IN ('pending', 'dispatched', 'in_progress')
    AND property_id IS NOT NULL
    AND phone_number IS NOT NULL
)
UPDATE call_logs AS c
SET
  status = 'failed',
  success = false,
  transcript_summary = coalesce(
    transcript_summary,
    'Closed as duplicate active reservation during 0001_compliance_and_active_lock migration'
  ),
  completed_at = coalesce(completed_at, now()),
  updated_at = now()
FROM ranked
WHERE c.id = ranked.id
  AND ranked.rn > 1;

-- Second safety layer for concurrent dials to the same property+phone pair.
CREATE UNIQUE INDEX IF NOT EXISTS call_logs_active_property_phone_uidx
  ON call_logs (property_id, phone_number)
  WHERE status IN ('pending', 'dispatched', 'in_progress');
