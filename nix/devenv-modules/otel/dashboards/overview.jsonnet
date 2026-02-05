// Overview / Home dashboard
// Landing page with summary of recent activity across all services.
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';

g.dashboard.new('OTEL Overview')
+ g.dashboard.withUid('otel-overview')
+ g.dashboard.withDescription('Overview of all traces collected by the local OTEL stack')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withPanels(
  g.util.grid.makeGrid([
    // Row: Stats
    g.panel.row.new('Summary'),

    g.panel.stat.new('Total traces (1h)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(6)
    + g.panel.stat.gridPos.withH(4),

    g.panel.stat.new('Error traces (1h)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{status.code=error}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(6)
    + g.panel.stat.gridPos.withH(4),

    g.panel.stat.new('dt task traces (1h)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt"}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(6)
    + g.panel.stat.gridPos.withH(4),

    g.panel.stat.new('App traces (1h)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name!="dt"}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(6)
    + g.panel.stat.gridPos.withH(4),

    // Row: Recent traces
    g.panel.row.new('Recent Traces'),

    lib.tempoTable('Recent traces (all services)', '{}', 'A', 50),

    // Row: Error traces
    g.panel.row.new('Errors'),

    lib.tempoTable('Recent error traces', '{status.code=error}', 'A', 20),
  ], panelWidth=6, panelHeight=4)
)
