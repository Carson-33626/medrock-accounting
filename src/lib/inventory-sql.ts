/**
 * Shared SQL fragments for the FIFO inventory API routes.
 *
 * PRODUCT_NAMES_CTE resolves a display name for ledger rows whose receipt_id
 * has no purchase_lots match (opening-balance pseudo-receipts, 'OB|...').
 * Sources in priority order: purchase_lots by ndc_norm, drug_usage_* by
 * ndc_norm, drug_usage_* by the 'name:<lowercased>' product_key convention
 * (see fifo_transform.py product_key_for()).
 *
 * Usage: `WITH ${PRODUCT_NAMES_CTE}, ...` then
 * `LEFT JOIN product_names pn ON pn.key = l.product_key` and select
 * `${RESOLVED_PRODUCT_NAME} AS product_name`.
 */

export const PRODUCT_NAMES_CTE = `product_names AS (
  SELECT DISTINCT ON (key) key, name
  FROM (
    SELECT ndc_norm AS key, product_name AS name, 1 AS pri
    FROM inventory.purchase_lots
    WHERE COALESCE(ndc_norm, '') <> '' AND COALESCE(product_name, '') <> ''
    UNION ALL
    SELECT u.ndc_norm, u.drug_name, 2
    FROM inventory.drug_usage_commercial u
    WHERE COALESCE(u.ndc_norm, '') <> '' AND COALESCE(u.drug_name, '') <> ''
    UNION ALL
    SELECT u.ndc_norm, u.drug_name, 3
    FROM inventory.drug_usage_compound u
    WHERE COALESCE(u.ndc_norm, '') <> '' AND COALESCE(u.drug_name, '') <> ''
    UNION ALL
    SELECT 'name:' || lower(trim(u.drug_name)), u.drug_name, 4
    FROM inventory.drug_usage_commercial u
    WHERE COALESCE(u.drug_name, '') <> ''
    UNION ALL
    SELECT 'name:' || lower(trim(u.drug_name)), u.drug_name, 5
    FROM inventory.drug_usage_compound u
    WHERE COALESCE(u.drug_name, '') <> ''
  ) s
  ORDER BY key, pri, name
)`;

export const RESOLVED_PRODUCT_NAME = `COALESCE(
  p.product_name,
  pn.name,
  CASE WHEN l.product_key LIKE 'name:%' THEN upper(substr(l.product_key, 6)) END
)`;
