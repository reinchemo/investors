-- ============================================================
-- PHASE 1c — equity_as_of()
-- Reconstructs every investor's equity + ownership % as of a given date.
-- Sections: 15 (Equity History & Effective Dates)
-- ============================================================

CREATE OR REPLACE FUNCTION equity_as_of(p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE (
  investor_id   bigint,
  name          text,
  investor_number text,
  equity        numeric,
  pct          numeric,
  last_change   text,
  last_ref      text,
  last_date     date,
  is_current    boolean
) AS $$
BEGIN
  RETURN QUERY
  WITH last_txn AS (
    SELECT DISTINCT ON (st.investor_id)
      st.investor_id,
      st.action,
      st.reference,
      st.date,
      st.equity_after
    FROM share_transactions st
    WHERE st.date <= p_as_of
    ORDER BY st.investor_id, st.date DESC, st.id DESC
  ),
  holders AS (
    SELECT
      i.id           AS investor_id,
      i.name         AS name,
      i.investor_number AS investor_number,
      COALESCE(lt.equity_after, 0) AS equity,
      lt.action      AS last_change,
      lt.reference   AS last_ref,
      lt.date        AS last_date,
      (i.deleted_at IS NULL) AS is_current
    FROM investors i
    LEFT JOIN last_txn lt ON lt.investor_id = i.id
    WHERE
      (i.joined_date IS NOT NULL AND i.joined_date <= p_as_of)
      OR
      (lt.investor_id IS NOT NULL)
      OR
      (i.deleted_at IS NULL AND i.joined_date IS NULL)
  )
  SELECT
    h.investor_id,
    h.name,
    h.investor_number,
    COALESCE(h.equity, 0) AS equity,
    CASE
      WHEN SUM(h.equity) OVER () > 0
      THEN ROUND((COALESCE(h.equity, 0) / SUM(h.equity) OVER ()) * 100, 4)
      ELSE 0
    END AS pct,
    h.last_change,
    h.last_ref,
    h.last_date,
    h.is_current
  FROM holders h
  WHERE COALESCE(h.equity, 0) > 0
  ORDER BY COALESCE(h.equity, 0) DESC;
END;
$$ LANGUAGE plpgsql STABLE;