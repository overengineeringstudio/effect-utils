// Shell Entry (enterShell) dashboard
// How long do shell entry tasks take, with breakdown by task.
//
// Shell entry runs optional tasks: pnpm:install, genie:run, megarepo:sync, ts:emit
// These tasks are only executed when their dependencies change (git hash caching).
// Use FORCE_SETUP=1 to force re-run even when cached.
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';

// Helper for trace table (sorted by time, relative display)
local traceTable(title, query, limit=50) =
  g.panel.table.new(title)
  + g.panel.table.queryOptions.withTargets([
    lib.tempoQuery(query, 'A', limit),
  ])
  + g.panel.table.options.withSortBy([
    g.panel.table.options.sortBy.withDisplayName('startTime')
    + g.panel.table.options.sortBy.withDesc(true),
  ])
  + {
    fieldConfig+: {
      overrides: [
        {
          matcher: { id: 'byName', options: 'startTime' },
          properties: [{ id: 'unit', value: 'dateTimeFromNow' }],
        },
      ],
    },
  };

g.dashboard.new('Shell Entry Performance')
+ g.dashboard.withUid('otel-shell-entry')
+ g.dashboard.withDescription('Performance breakdown of devenv shell entry tasks (pnpm:install, genie:run, megarepo:sync, ts:emit)')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withTimezone('browser')
+ g.dashboard.withPanels(
  g.util.grid.makeGrid([
    // Row: All shell entry tasks
    g.panel.row.new('Shell Entry Tasks'),

    traceTable(
      'All shell entry tasks (pnpm:install, genie:run, megarepo:sync, ts:emit)',
      '{resource.service.name="dt-task" && name=~"pnpm:install|genie:run|megarepo:sync|ts:emit"}',
      50,
    ),

    // Row: Individual task breakdown
    g.panel.row.new('Task Breakdown'),

    traceTable(
      'pnpm:install',
      '{resource.service.name="dt-task" && name="pnpm:install"}',
      30,
    ),

    traceTable(
      'genie:run',
      '{resource.service.name="dt-task" && name="genie:run"}',
      30,
    ),

    traceTable(
      'ts:emit',
      '{resource.service.name="dt-task" && name="ts:emit"}',
      30,
    ),

    traceTable(
      'megarepo:sync',
      '{resource.service.name="dt-task" && name="megarepo:sync"}',
      30,
    ),
  ], panelWidth=24, panelHeight=10)
)
