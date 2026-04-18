// Export all DF relationships (Event -> Event), one row per edge.
// PromG may use :DF or typed variants like :DF_PURCHASEORDER, :DF_HUMANRESOURCE, etc.
MATCH (src:Event)-[df]->(tgt:Event)
WHERE type(df) = 'DF' OR type(df) STARTS WITH 'DF_'
RETURN
  toString(id(src))        AS source_event_id,
  toString(id(tgt))        AS target_event_id,
  toString(df.entityId)    AS entity_id,
  df.entityType            AS entity_type
