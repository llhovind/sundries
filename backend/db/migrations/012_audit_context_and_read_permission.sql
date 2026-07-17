-- ============================================================================
-- 012_audit_context_and_read_permission.sql
-- 1) fn_audit_row now records the request context (ip, correlation_id) that
--    audit_log always had columns for. Services provide it per transaction
--    via set_config('app.ip' / 'app.correlation_id') — see common/db.js
--    withAudit(); absent settings stay NULL so job/CLI writes keep working.
-- 2) audit:read — permission to view the audit log. Read-only but sensitive
--    (row snapshots expose customer PII and staff activity), so it is its own
--    grant rather than riding on settings:manage or users:manage.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_audit_row() RETURNS trigger AS $$
DECLARE
    actor   BIGINT;
    pk      TEXT;
    req_ip  TEXT;
    corr_id TEXT;
BEGIN
    BEGIN
        actor := NULLIF(current_setting('app.user_id', TRUE), '')::BIGINT;
    EXCEPTION WHEN OTHERS THEN
        actor := NULL;
    END;
    req_ip  := NULLIF(current_setting('app.ip', TRUE), '');
    corr_id := NULLIF(current_setting('app.correlation_id', TRUE), '');

    IF TG_OP = 'DELETE' THEN
        pk := to_jsonb(OLD) ->> TG_ARGV[0];
        INSERT INTO audit_log (actor_user_id, action, entity, entity_id, old_data, ip, correlation_id)
        VALUES (actor, TG_OP, TG_TABLE_NAME, pk, to_jsonb(OLD), req_ip, corr_id);
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        pk := to_jsonb(NEW) ->> TG_ARGV[0];
        INSERT INTO audit_log (actor_user_id, action, entity, entity_id, old_data, new_data, ip, correlation_id)
        VALUES (actor, TG_OP, TG_TABLE_NAME, pk, to_jsonb(OLD), to_jsonb(NEW), req_ip, corr_id);
        RETURN NEW;
    ELSE
        pk := to_jsonb(NEW) ->> TG_ARGV[0];
        INSERT INTO audit_log (actor_user_id, action, entity, entity_id, new_data, ip, correlation_id)
        VALUES (actor, TG_OP, TG_TABLE_NAME, pk, to_jsonb(NEW), req_ip, corr_id);
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- shipping_weight_bands is pricing configuration exactly like shipping_rules;
-- it was the one settings-surface table without an audit trigger.
CREATE TRIGGER trg_audit_shipping_weight_bands
    AFTER INSERT OR UPDATE OR DELETE ON shipping_weight_bands
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row('band_no');

INSERT INTO permissions (code, descr) VALUES
    ('audit:read', 'View the audit log of privileged actions');

-- admin holds everything, including the new permission.
INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no
FROM roles r JOIN permissions p ON p.code = 'audit:read'
WHERE r.code = 'admin';
