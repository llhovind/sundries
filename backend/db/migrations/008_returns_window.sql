-- ============================================================================
-- 008_returns_window.sql
-- Return-window policy setting. Customers can open an RMA within this many
-- days of the order's first shipment (staff can open one at any time).
-- 0 or negative disables the window (returns accepted indefinitely).
-- ============================================================================

INSERT INTO app_settings (key, value, descr) VALUES
    ('returns.window_days', '30',
     'Days after first shipment during which a customer can request a return; <= 0 disables the limit')
ON CONFLICT (key) DO NOTHING;
