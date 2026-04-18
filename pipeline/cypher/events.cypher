// Export all Event nodes.
// Returns one row per event; all node properties are included.
MATCH (e:Event)
RETURN
  toString(id(e))        AS event_id,
  e.activity             AS activity,
  toString(e.timestamp)  AS timestamp,
  properties(e)          AS props
ORDER BY e.timestamp
