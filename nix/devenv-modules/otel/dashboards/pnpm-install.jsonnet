// pnpm Install Deep-Dive dashboard
// Per-package install analysis. Directly addresses network overhead from #110/#114.
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';

g.dashboard.new('pnpm Install Deep-Dive')
+ g.dashboard.withUid('otel-pnpm-install')
+ g.dashboard.withDescription('Per-package pnpm install timing and cache analysis')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withPanels(
  g.util.grid.makeGrid([
    // Row: Overall
    g.panel.row.new('Aggregate Install'),

    g.panel.stat.new('Total installs')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && name="pnpm:install"}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(8)
    + g.panel.stat.gridPos.withH(4),

    g.panel.stat.new('Per-package installs')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && name=~"pnpm:install:.*"}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(8)
    + g.panel.stat.gridPos.withH(4),

    g.panel.stat.new('Failed installs')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && name=~"pnpm:install.*" && status.code=error}', 'A', 100),
    ])
    + g.panel.stat.gridPos.withW(8)
    + g.panel.stat.gridPos.withH(4),

    // Row: All install traces
    g.panel.row.new('Install Traces'),

    lib.tempoTable(
      'pnpm:install aggregate traces (shows total duration)',
      '{resource.service.name="dt" && name="pnpm:install"}',
      'A',
      50,
    ),

    // Row: Per-package breakdown
    g.panel.row.new('Per-Package Traces'),

    lib.tempoTable(
      'Per-package install traces (pnpm:install:*)',
      '{resource.service.name="dt" && name=~"pnpm:install:.*"}',
      'A',
      100,
    ),

    // Row: Sequential chain analysis
    g.panel.row.new('Sequential Chain'),

    g.panel.text.new('Sequential Chain Note')
    + g.panel.text.options.withContent(|||
      ## Sequential Chain Analysis

      pnpm installs run **sequentially** to avoid race conditions from overlapping
      workspace members. To see the full sequential chain, click on a `pnpm:install`
      trace above to see its child spans (one per package).

      Look for:
      - **Long individual packages**: which package takes the most time?
      - **Network vs cached**: uncached installs (cold) are much slower
      - **Total wall time**: sum of all sequential packages
    |||)
    + g.panel.text.gridPos.withW(24)
    + g.panel.text.gridPos.withH(6),
  ], panelWidth=8, panelHeight=4)
)
