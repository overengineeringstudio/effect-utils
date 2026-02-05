// Shared helpers for OTEL dashboards
local g = import 'g.libsonnet';

{
  // Tempo datasource reference (matches the name provisioned by otel.nix)
  tempoDatasource:: 'Tempo',

  // Create a Tempo TraceQL query target
  tempoQuery(query, refId='A', limit=20)::
    g.query.tempo.new(self.tempoDatasource, query, [])
    + g.query.tempo.withQueryType('traceql')
    + g.query.tempo.withLimit(limit)
    + g.query.tempo.withTableType('traces')
    + g.query.tempo.withRefId(refId),

  // Shorthand for a full-width panel
  fullWidth(panel)::
    panel
    + g.panel.timeSeries.gridPos.withW(24)
    + g.panel.timeSeries.gridPos.withH(8),

  halfWidth(panel)::
    panel
    + g.panel.timeSeries.gridPos.withW(12)
    + g.panel.timeSeries.gridPos.withH(8),

  quarterWidth(panel)::
    panel
    + g.panel.timeSeries.gridPos.withW(6)
    + g.panel.timeSeries.gridPos.withH(4),

  // Stat panel with Tempo query
  tempoStat(title, query, refId='A')::
    g.panel.stat.new(title)
    + g.panel.stat.queryOptions.withTargets([
      self.tempoQuery(query, refId),
    ])
    + g.panel.stat.gridPos.withW(6)
    + g.panel.stat.gridPos.withH(4),

  // Table panel with Tempo query
  tempoTable(title, query, refId='A', limit=50)::
    g.panel.table.new(title)
    + g.panel.table.queryOptions.withTargets([
      self.tempoQuery(query, refId, limit),
    ])
    + g.panel.table.gridPos.withW(24)
    + g.panel.table.gridPos.withH(10),

  // Position a panel at specific grid coordinates
  at(panel, x, y, w, h)::
    panel
    + g.panel.stat.gridPos.withX(x)
    + g.panel.stat.gridPos.withY(y)
    + g.panel.stat.gridPos.withW(w)
    + g.panel.stat.gridPos.withH(h),
}
