-- ============================================================================
-- 010_refresh_token_rotation.sql
-- Refresh-token rotation. Tokens form families: a login starts a family, and
-- every refresh revokes the presented token and issues a successor in the
-- same family (replaced_by links predecessor to successor). Presenting a
-- revoked token outside the short reuse-grace window is treated as theft and
-- revokes every live token in the family.
-- ============================================================================

ALTER TABLE refresh_tokens
    ADD COLUMN family_id   UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN replaced_by BIGINT REFERENCES refresh_tokens (id) ON DELETE SET NULL;

-- Family-wide revocation (reuse detection, logout) targets live tokens only.
CREATE INDEX refresh_tokens_family_live_idx
    ON refresh_tokens (family_id) WHERE revoked_at IS NULL;
