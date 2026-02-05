// dt Task Performance dashboard
// Primary dashboard for understanding task execution times and cache effectiveness.
// This directly addresses the PR #114 use case (pnpm install overhead).
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';

g.dashboard.new('dt Task Performance')
+ g.dashboard.withUid('otel-dt-tasks')
+ g.dashboard.withDescription('Performance of dt (devenv tasks) executions')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withPanels(
  g.util.grid.makeGrid([
    // Row: Stats overview
    g.panel.row.new('Overview'),

    g.panel.stat.new('Total task runs')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt"}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(6)
    + g.panel.stat.gridPos.withH(4),

    g.panel.stat.new('Failed tasks')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && status.code=error}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(6)
    + g.panel.stat.gridPos.withH(4),

    g.panel.stat.new('Cached runs')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && span.cached="true"}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(6)
    + g.panel.stat.gridPos.withH(4),

    g.panel.stat.new('Uncached runs')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && span.cached="false"}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(6)
    + g.panel.stat.gridPos.withH(4),

    // Row: Task traces
    g.panel.row.new('All Task Runs'),

    lib.tempoTable('Recent dt task traces', '{resource.service.name="dt"}', 'A', 100),

    // Row: Specific tasks
    g.panel.row.new('pnpm:install'),

    lib.tempoTable(
      'pnpm:install traces',
      '{resource.service.name="dt" && name="pnpm:install"}',
      'A',
      50,
    ),

    g.panel.row.new('ts:check'),

    lib.tempoTable(
      'ts:check traces',
      '{resource.service.name="dt" && name="ts:check"}',
      'A',
      50,
    ),

    g.panel.row.new('check:quick'),

    lib.tempoTable(
      'check:quick traces',
      '{resource.service.name="dt" && name="check:quick"}',
      'A',
      50,
    ),

    // Row: Failed tasks
    g.panel.row.new('Failures'),

    lib.tempoTable(
      'Failed task traces',
      '{resource.service.name="dt" && status.code=error}',
      'A',
      50,
    ),
  ], panelWidth=6, panelHeight=4)
)
