-- One row per Apollo phone call we've seen. This is the idempotency ledger: the nightly run
-- re-sweeps a multi-day window, so it must be able to tell "already done" from "new".
--
-- `state` is the pipeline stage the call has reached:
--   pending      queued, nothing done yet
--   no_audio     Apollo has no recording_url for it (retried while inside the lookback window)
--   too_short    below MIN_DURATION_SECONDS — dial tone / instant hangup, no content to analyze
--   transcribed  AssemblyAI returned utterances
--   analyzed     Claude produced the insight object
--   written      Notion page created — terminal success
--   failed       gave up; see last_error
CREATE TABLE IF NOT EXISTS calls (
  apollo_call_id     TEXT PRIMARY KEY,
  disposition        TEXT,
  duration_seconds   INTEGER,
  started_at         TEXT,     -- ISO 8601, from Apollo start_time
  contact_name       TEXT,
  account_name       TEXT,
  -- Three independent grouping signals, matched with OR. No single field is populated on every
  -- call (no single field is always populated), so collapsing them into one key
  -- always splits somebody.
  account_id         TEXT,
  account_name_key   TEXT,     -- normalized company name
  email_domain       TEXT,     -- contact email domain; free-mail hosts excluded upstream
  conversation_id    TEXT,     -- non-null => Apollo also transcribed it; our attribution ground truth

  -- The analysis output, kept so a later call to the same account can be analyzed WITH the
  -- history rather than from scratch. A call is a fragment of an account relationship; scoring
  -- it in isolation repeats the same mistake as scoring an objection against one adjacent turn.
  insights_json      TEXT,

  state              TEXT NOT NULL DEFAULT 'pending',
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,

  transcript_id      TEXT,     -- AssemblyAI transcript id
  rep_channel        TEXT,     -- AssemblyAI channel string ("1"/"2") judged to be the rep
  rep_confidence     TEXT,     -- high | medium | low — how many of the 3 signals agreed
  notion_page_id     TEXT,

  first_seen_at      TEXT,
  updated_at         TEXT
);

-- The nightly run scans by state to find work.
CREATE INDEX IF NOT EXISTS idx_calls_state ON calls (state);

-- Lets us report/backfill by day without a table scan.
CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls (started_at);

-- Prior-call lookup when analyzing a new call at an account we've already worked.
CREATE INDEX IF NOT EXISTS idx_calls_account_id ON calls (account_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_account_name ON calls (account_name_key, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_email_domain ON calls (email_domain, started_at);
