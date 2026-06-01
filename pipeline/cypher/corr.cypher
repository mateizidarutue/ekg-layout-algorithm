// Export all event-to-entity correlations regardless of relationship type.
// PromG datasets may use :CORR or custom types (e.g. ACTS_ON, EXECUTED_BY).
MATCH (e:Event)-[r]->(en:Entity)
RETURN
  toString(id(e))                                      AS event_id,
  COALESCE(toString(en.sysId), toString(en.ID))        AS entity_id,
  labels(en)                                           AS entity_labels,
  type(r)                                              AS relation_type
