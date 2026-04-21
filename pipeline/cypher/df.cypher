// Export all DF relationships (Event -> Event), one row per edge.
// PromG may use :DF or typed variants like :DF_PURCHASEORDER, :DF_HUMANRESOURCE, etc.
MATCH (src:Event)-[df]->(tgt:Event)
WHERE type(df) = 'DF' OR type(df) STARTS WITH 'DF_'
CALL {
  WITH src, tgt, df
  OPTIONAL MATCH (src)-[]->(en:Entity)<-[]-(tgt)
  WHERE (
    df.entityId IS NOT NULL
    AND trim(toString(df.entityId)) <> ''
    AND COALESCE(toString(en.sysId), toString(en.ID), '') = trim(toString(df.entityId))
  ) OR (
    (df.entityId IS NULL OR trim(toString(df.entityId)) = '')
    AND (
      (df.entityType IS NOT NULL AND df.entityType IN labels(en))
      OR (df.entityType IS NULL AND type(df) STARTS WITH 'DF_' AND substring(type(df), 3) IN labels(en))
    )
  )
  RETURN head(collect(DISTINCT COALESCE(toString(en.sysId), toString(en.ID)))) AS inferred_entity_id
}
RETURN
  toString(id(src))        AS source_event_id,
  toString(id(tgt))        AS target_event_id,
  CASE
    WHEN df.entityId IS NULL OR trim(toString(df.entityId)) = '' THEN COALESCE(inferred_entity_id, '')
    ELSE trim(toString(df.entityId))
  END                      AS entity_id,
  CASE
    WHEN df.entityType IS NULL OR trim(toString(df.entityType)) = '' THEN
      CASE WHEN type(df) STARTS WITH 'DF_' THEN substring(type(df), 3) ELSE '' END
    ELSE trim(toString(df.entityType))
  END                      AS entity_type
