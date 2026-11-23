alter table public.funding_opportunities
  add column if not exists legal_approved_by uuid,
  add column if not exists legal_approved_at timestamptz,
  add column if not exists finance_approved_by uuid,
  add column if not exists finance_approved_at timestamptz;
alter table public.funding_receipts add column if not exists created_by uuid;
alter table public.funding_settlements add column if not exists created_by uuid;
create unique index if not exists funding_liability_ledger_receipt_once
  on public.funding_liability_ledger(receipt_id) where receipt_id is not null;
create unique index if not exists funding_liability_ledger_settlement_type_once
  on public.funding_liability_ledger(settlement_id,entry_type) where settlement_id is not null;