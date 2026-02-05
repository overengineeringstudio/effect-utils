// TS App Traces dashboard
// General-purpose trace exploration for Effect OTEL layers and non-dt services.
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';

g.dashboard.new('TS App Traces')
+ g.dashboard.withUid('otel-ts-app-traces')
+ g.dashboard.withDescription('Trace exploration for TS application code (Effect OTEL layers)')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withPanels(
  g.util.grid.makeGrid([
    // Row: Overview
    g.panel.row.new('App Traces'),

    g.panel.stat.new('App traces (non-dt)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name!="dt"}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(8)
    + g.panel.stat.gridPos.withH(4),

    g.panel.stat.new('App errors')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name!="dt" && status.code=error}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(8)
    + g.panel.stat.gridPos.withH(4),

    g.panel.stat.new('All services')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(8)
    + g.panel.stat.gridPos.withH(4),

    // Row: Recent app traces
    g.panel.row.new('Recent App Traces'),

    lib.tempoTable(
      'Recent app traces (excluding dt)',
      '{resource.service.name!="dt"}',
      'A',
      100,
    ),

    // Row: Errors
    g.panel.row.new('Error Traces'),

    lib.tempoTable(
      'App error traces',
      '{resource.service.name!="dt" && status.code=error}',
      'A',
      50,
    ),

    // Row: Search
    g.panel.row.new('Trace Search'),

    g.panel.text.new('Trace Search Tip')
    + g.panel.text.options.withContent(|||
      ## Searching Traces

      Use **Explore > Tempo** in the left sidebar for advanced trace search with:
      - TraceQL queries: `{resource.service.name="my-app" && duration > 1s}`
      - Trace ID lookup: paste a trace ID directly
      - Service filtering and tag-based search

      The panels above show recent traces. For deeper analysis, use Explore.
    |||)
    + g.panel.text.gridPos.withW(24)
    + g.panel.text.gridPos.withH(5),
  ], panelWidth=8, panelHeight=4)
)
