// pnpm Install Deep-Dive dashboard
// Per-package install analysis. Directly addresses network overhead from #110/#114.
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';
local at = lib.at;

local y = {
  statsRow: 0,
  stats: 1,
  installRow: 5,
  install: 6,
  perPkgRow: 16,
  perPkg: 17,
  noteRow: 27,
  note: 28,
};

g.dashboard.new('pnpm Install Deep-Dive')
+ g.dashboard.withUid('otel-pnpm-install')
+ g.dashboard.withDescription('Per-package pnpm install timing and cache analysis')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withTimezone('browser')
+ g.dashboard.withPanels([

  // Row: Aggregate stats
  at(g.panel.row.new('Aggregate Install'), 0, y.statsRow, 24, 1),

  at(
    g.panel.stat.new('Total installs')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && name="pnpm:install"}', 'A', 100),
    ]),
    0, y.stats, 8, 4,
  ),

  at(
    g.panel.stat.new('Per-package installs')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && name=~"pnpm:install:.*"}', 'A', 100),
    ]),
    8, y.stats, 8, 4,
  ),

  at(
    g.panel.stat.new('Failed installs')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && name=~"pnpm:install.*" && status.code=error}', 'A', 100),
    ]),
    16, y.stats, 8, 4,
  ),

  // Row: All install traces
  at(g.panel.row.new('Install Traces'), 0, y.installRow, 24, 1),

  at(
    lib.tempoTable(
      'pnpm:install aggregate traces (shows total duration)',
      '{resource.service.name="dt" && name="pnpm:install"}',
      'A',
      50,
    ),
    0, y.install, 24, 10,
  ),

  // Row: Per-package breakdown
  at(g.panel.row.new('Per-Package Traces'), 0, y.perPkgRow, 24, 1),

  at(
    lib.tempoTable(
      'Per-package install traces (pnpm:install:*)',
      '{resource.service.name="dt" && name=~"pnpm:install:.*"}',
      'A',
      100,
    ),
    0, y.perPkg, 24, 10,
  ),

  // Row: Sequential chain analysis
  at(g.panel.row.new('Sequential Chain'), 0, y.noteRow, 24, 1),

  at(
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
    |||),
    0, y.note, 24, 6,
  ),
])
