-- Restore suppression table as a read-only block list for dispatch.
-- Apply with: npm run db:migrate

CREATE TABLE IF NOT EXISTS suppressed_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS suppressed_numbers_phone_unique
  ON suppressed_numbers (phone_number);
