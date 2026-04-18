// Export all Entity nodes.
// Returns one row per entity; secondary labels give entity_type.
MATCH (en:Entity)
RETURN
  COALESCE(toString(en.sysId), toString(en.ID)) AS entity_id,
  labels(en)                                    AS node_labels,
  properties(en)                                AS props
ORDER BY entity_id
