-- Keep legacy expenditure snapshots private to trusted backend/service access.
-- These tables are historical backups, not application-facing data sources.
REVOKE ALL PRIVILEGES ON TABLE
  public.expenditure_data_backup,
  public.expenditure_data_backup2,
  public.expenditure_data_backup_final
FROM PUBLIC, anon, authenticated;

ALTER TABLE public.expenditure_data_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenditure_data_backup2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenditure_data_backup_final ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenditure_data_backup FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expenditure_data_backup2 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expenditure_data_backup_final FORCE ROW LEVEL SECURITY;
