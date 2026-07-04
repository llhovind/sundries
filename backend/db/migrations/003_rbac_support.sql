-- ============================================================================
-- 003_rbac_support.sql
-- Fixes two gaps found while wiring RBAC into the existing auth flow, and
-- adds the permission-resolution function used by token issuance and the
-- requirePermission middleware.
-- ============================================================================

-- Registration creates users with no username (email-only identity until the
-- profile is completed); 001 was stricter than the code that already exists.
ALTER TABLE users ALTER COLUMN username DROP NOT NULL;

-- Tracks which user consumed which invitation code (registration writes this).
CREATE TABLE invitation_code_uses (
    id                  BIGSERIAL PRIMARY KEY,
    invitation_code_id  BIGINT NOT NULL REFERENCES invitation_codes ON DELETE CASCADE,
    user_id             BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
    used_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX invitation_code_uses_code_idx ON invitation_code_uses (invitation_code_id);

-- Resolves a user's effective permission codes.
-- Source of truth is user_roles; the legacy users.role column is unioned in
-- during the transition so a user created before role grants existed keeps
-- working. Remove the legacy branch when users.role is dropped.
CREATE FUNCTION fn_user_permissions(p_user_id BIGINT)
RETURNS TABLE (code TEXT) AS $$
    SELECT DISTINCT p.code
    FROM permissions p
    JOIN role_permissions rp ON rp.perm_no = p.perm_no
    JOIN roles r             ON r.role_no = rp.role_no
    WHERE r.role_no IN (
        SELECT ur.role_no FROM user_roles ur WHERE ur.user_id = p_user_id
        UNION
        SELECT r2.role_no FROM roles r2
        JOIN users u ON u.role = r2.code
        WHERE u.id = p_user_id
    )
$$ LANGUAGE sql STABLE;

-- Backfill: give every existing user a user_roles row matching their legacy
-- primary role, so grants are queryable/auditable in one place from now on.
INSERT INTO user_roles (user_id, role_no)
SELECT u.id, r.role_no
FROM users u
JOIN roles r ON r.code = u.role
ON CONFLICT (user_id, role_no) DO NOTHING;
