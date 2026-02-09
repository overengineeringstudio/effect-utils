// Overview / Home dashboard
// Landing page with summary of recent activity across all services.
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
};

g.dashboard.new('OTEL Overview')
+ g.dashboard.withUid('otel-overview')
+ g.dashboard.withDescription('Overview of all traces collected by the local OTEL stack')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withTimezone('browser')
+ g.dashboard.withPanels([

  // Row: Stats
  at(g.panel.row.new('Summary'), 0, y.statsRow, 24, 1),

  at(
    g.panel.stat.new('Total traces (1h)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{}', 'A', 100),
    ]),
    0, y.stats, 6, 4,
  ),

  at(
    g.panel.stat.new('Error traces (1h)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{status.code=error}', 'A', 100),
    ]),
    6, y.stats, 6, 4,
  ),

  at(
    g.panel.stat.new('dt task traces (1h)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt"}', 'A', 100),
    ]),
    12, y.stats, 6, 4,
  ),

  at(
    g.panel.stat.new('App traces (1h)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name!="dt"}', 'A', 100),
    ]),
    18, y.stats, 6, 4,
  ),

  // Row: Recent traces
  at(g.panel.row.new('Recent Traces'), 0, y.recentRow, 24, 1),

  at(
    lib.tempoTable('Recent traces (all services)', '{}', 'A', 50),
    0, y.recent, 24, 10,
  ),

  // Row: Error traces
  at(g.panel.row.new('Errors'), 0, y.errorsRow, 24, 1),

  at(
    lib.tempoTable('Recent error traces', '{status.code=error}', 'A', 20),
    0, y.errors, 24, 10,
  ),
])
