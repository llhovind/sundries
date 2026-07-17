-- ============================================================================
-- 011_report_categories_and_runs.sql
-- Reporting becomes a first-class subsystem:
--
--   1. Access control moves from two broad codes (reports:view, reports:cogs)
--      to one permission per report CATEGORY, mirroring how every other
--      endpoint group is guarded. A report's category decides who sees it:
--        reports:sales       — what customers bought (revenue, sales trends)
--        reports:finance     — cost data (COGS, valuation, shrinkage)
--        reports:inventory   — operational stock reports (no sales data)
--        reports:purchasing  — vendor / purchase-order reports
--
--   2. report_runs stores the output of scheduled (e.g. monthly) and
--      long-running reports so they can be listed, viewed, and downloaded
--      later. Immediate reports never write here.
-- ============================================================================

-- ── Category permissions ─────────────────────────────────────────────────────

INSERT INTO permissions (code, descr) VALUES
    ('reports:sales',      'Sales & revenue reports (what customers purchased)'),
    ('reports:finance',    'Finance reports: COGS, valuation, shrinkage'),
    ('reports:inventory',  'Operational inventory reports'),
    ('reports:purchasing', 'Purchasing & vendor reports');

-- ── System-role grants (deliberate least-privilege mapping) ──────────────────
-- customer_service sees sales activity but never purchasing/costs;
-- inventory_control sees stock operations but never what customers bought.

INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no FROM roles r JOIN permissions p ON p.code IN
    ('reports:sales', 'reports:finance', 'reports:inventory', 'reports:purchasing')
WHERE r.code IN ('admin', 'finance')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no FROM roles r JOIN permissions p ON p.code IN
    ('reports:purchasing', 'reports:inventory')
WHERE r.code = 'purchasing'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no FROM roles r JOIN permissions p
    ON p.code = 'reports:inventory'
WHERE r.code = 'inventory_control'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no FROM roles r JOIN permissions p
    ON p.code = 'reports:sales'
WHERE r.code = 'customer_service'
ON CONFLICT DO NOTHING;

-- ── Carry-forward for custom roles created since install ─────────────────────
-- reports:cogs implied full cost visibility → all categories.
-- reports:view was "operational reports" → the inventory category.

INSERT INTO role_permissions (role_no, perm_no)
SELECT rp.role_no, np.perm_no
FROM role_permissions rp
JOIN permissions op ON op.perm_no = rp.perm_no AND op.code = 'reports:cogs'
JOIN permissions np ON np.code IN
    ('reports:sales', 'reports:finance', 'reports:inventory', 'reports:purchasing')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_no, perm_no)
SELECT rp.role_no, np.perm_no
FROM role_permissions rp
JOIN permissions op ON op.perm_no = rp.perm_no AND op.code = 'reports:view'
JOIN permissions np ON np.code = 'reports:inventory'
ON CONFLICT DO NOTHING;

-- ── Retire the old codes (role_permissions rows cascade) ─────────────────────

DELETE FROM permissions WHERE code IN ('reports:view', 'reports:cogs');

-- ── Stored report runs ───────────────────────────────────────────────────────
-- One row per generation of a stored report (scheduled or long-running).
-- `result` holds the rows as JSONB: report outputs are aggregates, small
-- enough for a row, and self-contained snapshots must not change when the
-- underlying data does. requested_by is NULL for schedule-triggered runs.

CREATE TABLE report_runs (
    run_no        BIGSERIAL   PRIMARY KEY,
    report_slug   TEXT        NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    trigger       TEXT        NOT NULL
                              CHECK (trigger IN ('manual', 'schedule')),
    params        JSONB       NOT NULL DEFAULT '{}',
    requested_by  BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    row_count     INTEGER,
    result        JSONB,
    error         TEXT,
    _create_ts    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ
);

CREATE INDEX report_runs_slug_idx ON report_runs (report_slug, _create_ts DESC);
