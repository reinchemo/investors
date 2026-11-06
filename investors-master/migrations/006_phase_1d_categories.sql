-- ============================================================
-- PHASE 1d — Configurable Categories
-- Replaces hardcoded category arrays with data-driven categories.
-- Sections: 17 (Locations), 18 (Expenditure Category Management)
-- ============================================================

-- 1. Create the table
CREATE TABLE IF NOT EXISTS categories (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL,           -- 'income' | 'expense' | 'capital'
  description   text,
  sort_order    integer DEFAULT 100,
  active        boolean NOT NULL DEFAULT true,
  is_system     boolean NOT NULL DEFAULT false,
  metadata      jsonb DEFAULT '{}'::jsonb,
  created_at    timestamptz DEFAULT now(),
  created_by    text,
  updated_at    timestamptz DEFAULT now(),
  updated_by    text,
  deleted_at    timestamptz,
  deleted_by    text,
  delete_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_kind_code
  ON categories (kind, code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_categories_kind_active
  ON categories (kind, active)
  WHERE deleted_at IS NULL;

-- 2. Seed from hardcoded lists
INSERT INTO categories (code, name, kind, is_system) VALUES
  -- income
  ('customer_payments',    'Customer Payments',    'income', true),
  ('installation_fees',    'Installation Fees',    'income', true),
  ('equipment_sales',      'Equipment Sales',      'income', true),
  ('other_income',         'Other Income',         'income', true),
  -- expense
  ('internet',             'Internet',             'expense', true),
  ('safaricom',            'Safaricom',            'expense', true),
  ('starlink',             'Starlink',             'expense', true),
  ('kplc',                 'KPLC',                 'expense', true),
  ('electricity',          'Electricity',          'expense', true),
  ('equipment',            'Equipment',            'expense', true),
  ('routers',              'Routers',              'expense', true),
  ('access_points',        'Access Points',        'expense', true),
  ('fiber',                'Fiber',                'expense', true),
  ('cables',               'Cables',               'expense', true),
  ('salaries',             'Salaries',             'expense', true),
  ('transport',            'Transport',            'expense', true),
  ('repairs',              'Repairs',              'expense', true),
  ('rent',                 'Rent',                 'expense', true),
  ('software',             'Software',             'expense', true),
  ('marketing',            'Marketing',            'expense', true),
  ('airtime',              'Airtime',              'expense', true),
  ('mpesa_charges',        'M-PESA Charges',       'expense', true),
  ('taxes',                'Taxes',                'expense', true),
  ('loan_repayment',       'Loan Repayment',       'expense', true),
  ('other',                'Other',                'expense', true),
  ('starlink_virtual_capital', 'STARLINK Virtual Capital', 'expense', true),
  -- capital
  ('investor_capital',     'Investor Capital',     'capital', true),
  ('loans_received',       'Loans Received',       'capital', true),
  ('share_transfer',       'Share Transfer',       'capital', true)
ON CONFLICT DO NOTHING;

-- 3. Views for app consumption
CREATE OR REPLACE VIEW active_expense_categories AS
SELECT id, code, name, sort_order
FROM categories
WHERE kind = 'expense' AND active = true AND deleted_at IS NULL
ORDER BY sort_order, name;

CREATE OR REPLACE VIEW active_income_categories AS
SELECT id, code, name, sort_order
FROM categories
WHERE kind = 'income' AND active = true AND deleted_at IS NULL
ORDER BY sort_order, name;

CREATE OR REPLACE VIEW active_capital_categories AS
SELECT id, code, name, sort_order
FROM categories
WHERE kind = 'capital' AND active = true AND deleted_at IS NULL
ORDER BY sort_order, name;