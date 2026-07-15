-- ============================================================================
-- 006_otp_attempt_lockout.sql
-- Brute-force guard for OTP login: each failed verification increments the
-- code's attempt counter, and a code past the limit is dead (findValid
-- excludes it) — the shopper must request a fresh code, which is itself
-- rate-limited. Counting per code in the database keeps the guard correct
-- across any number of API instances.
-- ============================================================================

ALTER TABLE otp_codes ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
