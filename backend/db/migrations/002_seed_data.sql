-- ============================================================================
-- 002_seed_data.sql
-- Reasonable defaults so a fresh install is immediately usable.
-- The initial admin user is created by `node db/bootstrap.js` (env-driven),
-- not here — migrations must stay environment-independent.
-- ============================================================================

-- ── Roles ────────────────────────────────────────────────────────────────────

INSERT INTO roles (code, name, descr, is_system) VALUES
    ('admin',             'Administrator',      'Full access to every function',                    TRUE),
    ('finance',           'Finance',            'Reports, COGS, refunds',                           TRUE),
    ('purchasing',        'Purchasing',         'Vendors, purchase orders, receiving',              TRUE),
    ('inventory_control', 'Inventory Control',  'Adjustments, transfers, counts',                   TRUE),
    ('fulfillment',       'Fulfillment',        'Pick/pack/ship, order fulfillment',                TRUE),
    ('customer_service',  'Customer Service',   'Customer accounts, order support, RMAs',           TRUE),
    ('customer',          'Customer',           'Storefront shopper (default for registrations)',   TRUE);

-- ── Permissions ──────────────────────────────────────────────────────────────

INSERT INTO permissions (code, descr) VALUES
    ('catalog:read',       'View products, variants, categories'),
    ('catalog:write',      'Create/update products, variants, categories, prices'),
    ('inventory:read',     'View balances, ledger, reservations'),
    ('inventory:adjust',   'Write ADJ transactions (write-offs, count corrections)'),
    ('inventory:receive',  'Receive stock against purchase orders'),
    ('inventory:transfer', 'Create/dispatch/receive stock transfers'),
    ('purchasing:manage',  'Vendors and purchase orders'),
    ('orders:read',        'View orders'),
    ('orders:fulfill',     'Ship orders, capture backorder payments'),
    ('orders:cancel',      'Cancel orders'),
    ('refunds:create',     'Issue refunds / credit sales'),
    ('rma:manage',         'Returns workflow'),
    ('reports:view',       'Operational reports'),
    ('reports:cogs',       'Cost of goods / valuation reports'),
    ('customers:read',     'View customer accounts'),
    ('customers:write',    'Update customer accounts'),
    ('users:manage',       'User accounts and role grants'),
    ('promotions:manage',  'Promotion codes'),
    ('settings:manage',    'Store settings, shipping rules, tax tables, warehouses');

-- ── Role → permission grants ─────────────────────────────────────────────────

-- admin: everything
INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no FROM roles r CROSS JOIN permissions p WHERE r.code = 'admin';

INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no FROM roles r JOIN permissions p ON p.code IN
    ('reports:view', 'reports:cogs', 'refunds:create', 'orders:read', 'customers:read')
WHERE r.code = 'finance';

INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no FROM roles r JOIN permissions p ON p.code IN
    ('purchasing:manage', 'inventory:receive', 'inventory:read', 'catalog:read', 'reports:view')
WHERE r.code = 'purchasing';

INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no FROM roles r JOIN permissions p ON p.code IN
    ('inventory:read', 'inventory:adjust', 'inventory:receive', 'inventory:transfer',
     'catalog:read', 'reports:view')
WHERE r.code = 'inventory_control';

INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no FROM roles r JOIN permissions p ON p.code IN
    ('orders:read', 'orders:fulfill', 'inventory:read', 'catalog:read')
WHERE r.code = 'fulfillment';

INSERT INTO role_permissions (role_no, perm_no)
SELECT r.role_no, p.perm_no FROM roles r JOIN permissions p ON p.code IN
    ('orders:read', 'orders:cancel', 'customers:read', 'customers:write',
     'rma:manage', 'catalog:read')
WHERE r.code = 'customer_service';

-- ── Units of measure & conversions ───────────────────────────────────────────

INSERT INTO units_of_measure (uom_code, name, is_fractional) VALUES
    ('each', 'Each',   FALSE),
    ('in',   'Inches', TRUE),
    ('ft',   'Feet',   TRUE),
    ('yd',   'Yards',  TRUE),
    ('m',    'Meters', TRUE);

INSERT INTO uom_conversions (from_uom, to_uom, ratio) VALUES
    ('ft', 'in', 12),          ('in', 'ft', 0.08333333),
    ('yd', 'ft', 3),           ('ft', 'yd', 0.33333333),
    ('yd', 'in', 36),          ('in', 'yd', 0.02777778),
    ('m',  'in', 39.37007874), ('in', 'm',  0.02540000),
    ('m',  'ft', 3.28083990),  ('ft', 'm',  0.30480000),
    ('m',  'yd', 1.09361330),  ('yd', 'm',  0.91440000);

-- ── Warehouses ───────────────────────────────────────────────────────────────

INSERT INTO warehouses (code, name, wh_type, priority) VALUES
    ('MAIN',    'Main Warehouse',       'standard',  1),
    ('TRANSIT', 'In-Transit (default)', 'transport', 999);

-- ── Shipping rules (flat < $50, free ≥ $50) + weight surcharges (> 40 lb) ────

INSERT INTO shipping_rules (name, min_subtotal, max_subtotal, base_amount, priority) VALUES
    ('Standard shipping (orders under $50)', 0,  50,   9.95, 10),
    ('Free shipping ($50 and over)',         50, NULL, 0.00, 20);

INSERT INTO shipping_weight_bands (min_weight_lbs, max_weight_lbs, surcharge) VALUES
    (40, 70,   25.00),
    (70, NULL, 75.00);

-- ── Tax fallback (local-table adapter; replaced by Stripe Tax when enabled) ──

INSERT INTO tax_rates (country, state, rate, name) VALUES
    ('US', NULL, 0, 'Default (no tax configured)');

-- ── Categories ───────────────────────────────────────────────────────────────

INSERT INTO categories (name) VALUES ('General');

-- ── App settings ─────────────────────────────────────────────────────────────

INSERT INTO app_settings (key, value, descr) VALUES
    ('store.name',                  '"My Store"',  'Display name used by the storefront and emails'),
    ('store.currency',              '"USD"',       'Default checkout currency (ISO 4217)'),
    ('reservations.ttl_minutes',    '15',          'How long a Place Order holds stock before payment must confirm'),
    ('inventory.partition_months',  '-1',          'Months of inventory_transactions partitions to pre-create; -1 disables partition maintenance (default partition only)'),
    ('checkout.guest_enabled',      'true',        'Allow guest checkout (implicit customer accounts, OTP login)'),
    ('shipping.free_threshold',     '50',          'Informational mirror of the shipping_rules threshold for storefront messaging'),
    ('mail.provider',               '"smtp"',      'Mail adapter: "smtp" (nodemailer) or "ses"'),
    ('search.provider',             '"postgres"',  'Search adapter: "postgres" or "opensearch"'),
    ('tax.provider',                '"local"',     'Tax adapter: "local" (tax_rates table) or "stripe"');
