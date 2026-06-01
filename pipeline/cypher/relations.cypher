// Export structural relationships between entity nodes only.
// This intentionally excludes non-entity graph structure such as PREVALENCE,
// while preserving viewer-relevant semantics like HAS_ITEM, SELLS, BUYS, INVOICE_OF.
// Direct edges
MATCH (src:Entity)-[rel]->(tgt:Entity)
WHERE type(rel) <> 'CORR'
  AND type(rel) <> 'DF'
  AND NOT type(rel) STARTS WITH 'DF_'
  AND type(rel) <> 'FROM'
  AND type(rel) <> 'TO'
RETURN
  COALESCE(toString(src.sysId), toString(src.ID), toString(id(src))) AS source_id,
  labels(src)                                                         AS src_labels,
  COALESCE(toString(tgt.sysId), toString(tgt.ID), toString(id(tgt))) AS target_id,
  labels(tgt)                                                         AS tgt_labels,
  type(rel)                                                           AS relation_type,
  properties(rel)                                                     AS props
UNION
// Reified (model_as_node) relations: collapse src -[:FROM]-> relay -[:TO]-> tgt
MATCH (src:Entity)-[:FROM]->(relay:Entity)-[:TO]->(tgt:Entity)
WHERE NOT src:Event AND NOT tgt:Event AND NOT relay:Activity
RETURN
  COALESCE(toString(src.sysId), toString(src.ID), toString(id(src)))  AS source_id,
  labels(src)                                                          AS src_labels,
  COALESCE(toString(tgt.sysId), toString(tgt.ID), toString(id(tgt)))  AS target_id,
  labels(tgt)                                                          AS tgt_labels,
  head([l IN labels(relay) WHERE l <> 'Entity' | l])                   AS relation_type,
  properties(relay)                                                     AS props
