-- ============================================================================
-- 009_role_admin.sql
-- Permission for the roles & permissions editor. Kept separate from
-- users:manage: editing what a role can do is privilege-escalation-sensitive,
-- so granting user administration must not implicitly grant it.
-- ============================================================================

INSERT INTO permissions (code, descr) VALUES
    ('roles:manage', 'Edit roles and their permissions');

-- admin holds everything, including the new permission.
INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no
FROM roles r JOIN permissions p ON p.code = 'roles:manage'
WHERE r.code = 'admin';

-- Role definitions and their permission grants become editable at runtime,
-- so audit them like user_roles (fn_audit_row reads app.user_id per tx).
CREATE TRIGGER trg_audit_roles
    AFTER INSERT OR UPDATE OR DELETE ON roles
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row('role_no');

CREATE TRIGGER trg_audit_role_permissions
    AFTER INSERT OR DELETE ON role_permissions
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row('role_no');
