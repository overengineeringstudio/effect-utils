// TS App Traces dashboard
// General-purpose trace exploration for Effect OTEL layers and non-dt services.
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';
local at = lib.at;

local y = {
  statsRow: 0,
  stats: 1,
  recentRow: 5,
  recent: 6,
  errorsRow: 16,
  errors: 17,
  searchRow: 27,
  search: 28,
};

g.dashboard.new('TS App Traces')
+ g.dashboard.withUid('otel-ts-app-traces')
+ g.dashboard.withDescription('Trace exploration for TS application code (Effect OTEL layers)')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withTimezone('browser')
+ g.dashboard.withPanels([

  // Row: Overview
  at(g.panel.row.new('App Traces'), 0, y.statsRow, 24, 1),

  at(
    g.panel.stat.new('App traces (non-dt)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name!="dt"}', 'A', 100),
    ]),
    0, y.stats, 8, 4,
  ),

  at(
    g.panel.stat.new('App errors')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name!="dt" && status.code=error}', 'A', 100),
    ]),
    8, y.stats, 8, 4,
  ),

  at(
    g.panel.stat.new('All services')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{}', 'A', 100),
    ]),
    16, y.stats, 8, 4,
  ),

  // Row: Recent app traces
  at(g.panel.row.new('Recent App Traces'), 0, y.recentRow, 24, 1),

  at(
    lib.tempoTable(
      'Recent app traces (excluding dt)',
      '{resource.service.name!="dt"}',
      'A',
      100,
    ),
    0, y.recent, 24, 10,
  ),

  // Row: Errors
  at(g.panel.row.new('Error Traces'), 0, y.errorsRow, 24, 1),

  at(
    lib.tempoTable(
      'App error traces',
      '{resource.service.name!="dt" && status.code=error}',
      'A',
      50,
    ),
    0, y.errors, 24, 10,
  ),

  // Row: Search
  at(g.panel.row.new('Trace Search'), 0, y.searchRow, 24, 1),

  at(
    g.panel.text.new('Trace Search Tip')
    + g.panel.text.options.withContent(|||
      ## Searching Traces

      Use **Explore > Tempo** in the left sidebar for advanced trace search with:
      - TraceQL queries: `{resource.service.name="my-app" && duration > 1s}`
      - Trace ID lookup: paste a trace ID directly
      - Service filtering and tag-based search

      The panels above show recent traces. For deeper analysis, use Explore.
    |||),
    0, y.search, 24, 5,
  ),
])
