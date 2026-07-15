CREATE TABLE IF NOT EXISTS call_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id text NOT NULL UNIQUE,
  direction text NOT NULL DEFAULT 'outbound',
  status text NOT NULL DEFAULT 'dispatched',
  owner_outcome text NOT NULL DEFAULT 'not_asked',
  success boolean NOT NULL DEFAULT false,
  answered boolean NOT NULL DEFAULT false,
  phone_number text,
  owner_name text,
  property_id text,
  property_address text,
  caller_name text,
  company_name text,
  room_name text,
  dispatch_id text,
  languages jsonb NOT NULL DEFAULT '[]'::jsonb,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  transcript_summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_logs_status_idx ON call_logs (status);
CREATE INDEX IF NOT EXISTS call_logs_completed_at_idx ON call_logs (completed_at DESC);
