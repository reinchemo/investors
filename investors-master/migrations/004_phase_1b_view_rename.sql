send me the sql files i paste-- ============================================================
-- PHASE 1b — starlink_virtual_capital_total view
-- Renamed from starlink_investment_total to match the actual category.
-- ============================================================

DROP VIEW IF EXISTS starlink_investment_total;

CREATE OR REPLACE VIEW starlink_virtual_capital_total AS
SELECT COALESCE(SUM(amount), 0) AS total
FROM transactions
WHERE type = 'expense'
  AND category = 'STARLINK Virtual Capital'
  AND status = 'posted'
  AND deleted_at IS NULL
  AND reversed_at IS NULL;