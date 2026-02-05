// Shell Entry (enterShell) dashboard
// How long does `direnv allow` take, with breakdown by setup phase.
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';

g.dashboard.new('Shell Entry Performance')
+ g.dashboard.withUid('otel-shell-entry')
+ g.dashboard.withDescription('Performance breakdown of devenv shell entry (direnv allow)')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withPanels(
  g.util.grid.makeGrid([
    // Row: Overall timing
    g.panel.row.new('Shell Entry'),

    lib.tempoTable(
      'Recent shell entry traces',
      '{resource.service.name="dt" && name=~"setup:.*"}',
      'A',
      50,
    ),

    // Row: Setup phases
    g.panel.row.new('Setup Phases'),

    lib.tempoTable(
      'pnpm:install during setup',
      '{resource.service.name="dt" && name="pnpm:install"}',
      'A',
      30,
    ),

    lib.tempoTable(
      'genie:run during setup',
      '{resource.service.name="dt" && name="genie:run"}',
      'A',
      30,
    ),

    lib.tempoTable(
      'ts:build during setup',
      '{resource.service.name="dt" && name="ts:build"}',
      'A',
      30,
    ),

    lib.tempoTable(
      'megarepo:sync during setup',
      '{resource.service.name="dt" && name="megarepo:sync"}',
      'A',
      30,
    ),
  ], panelWidth=24, panelHeight=10)
)
