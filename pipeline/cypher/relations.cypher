// Export structural relationships between entity nodes only.
// This intentionally excludes non-entity graph structure such as PREVALENCE,
// while preserving viewer-relevant semantics like HAS_ITEM, SELLS, BUYS, INVOICE_OF.
MATCH (src:Entity)-[rel]->(tgt:Entity)
WHERE type(rel) <> 'CORR'
  AND type(rel) <> 'DF'
  AND NOT type(rel) STARTS WITH 'DF_'
  AND type(rel) <> 'FROM'
  AND type(rel) <> 'TO'
RETURN
  COALESCE(toString(src.sysId), toString(src.ID), toString(id(src))) AS source_id,
  COALESCE(toString(tgt.sysId), toString(tgt.ID), toString(id(tgt))) AS target_id,
  type(rel)                                                           AS relation_type,
  properties(rel)                                                     AS props
