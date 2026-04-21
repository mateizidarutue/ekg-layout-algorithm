// Export structural relationships between non-event nodes.
// This preserves entity/entity semantics such as HAS_ITEM, SELLS, BUYS, MEMBER_OF, etc.
MATCH (src)-[rel]->(tgt)
WHERE NOT src:Event
  AND NOT tgt:Event
  AND type(rel) <> 'FROM'
  AND type(rel) <> 'TO'
RETURN
  COALESCE(toString(src.sysId), toString(src.ID), toString(id(src))) AS source_id,
  labels(src)                                                         AS source_labels,
  COALESCE(toString(tgt.sysId), toString(tgt.ID), toString(id(tgt))) AS target_id,
  labels(tgt)                                                         AS target_labels,
  type(rel)                                                           AS relation_type,
  properties(rel)                                                     AS props
ORDER BY relation_type, source_id, target_id
