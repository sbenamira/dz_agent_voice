-- Migration monitoring : colonnes de suivi + table call_turns
-- À exécuter dans Supabase SQL Editor

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS caller_number TEXT,
  ADD COLUMN IF NOT EXISTS turns         INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_llm_ms    INTEGER,
  ADD COLUMN IF NOT EXISTS avg_tts_ms    INTEGER,
  ADD COLUMN IF NOT EXISTS avg_total_ms  INTEGER,
  ADD COLUMN IF NOT EXISTS total_tokens  INTEGER;

CREATE TABLE IF NOT EXISTS call_turns (
  id              UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  call_id         UUID    REFERENCES calls(id) ON DELETE CASCADE,
  turn_number     INTEGER NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  stt_output_text TEXT,
  stt_confidence  FLOAT,
  stt_duration_ms INTEGER,

  llm_input_text  TEXT,
  llm_output_text TEXT,
  llm_tokens_used INTEGER,
  llm_duration_ms INTEGER,

  tts_input_text   TEXT,
  tts_output_bytes INTEGER,
  tts_duration_ms  INTEGER,

  total_latency_ms INTEGER,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS call_turns_call_id_idx ON call_turns(call_id);
