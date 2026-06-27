// devenv task Performance dashboard
// Primary dashboard for understanding task execution times and bottlenecks.
//
// Two trace levels:
//   - Task execution spans: name="devenv.task.exec"
//   - Task status spans: name="devenv.task.status" for cache/status checks
//
// Task caching:
//   - task.cached=false: task actually executed
//   - task.cached=true: task was skipped (status check passed)
//   - Use the "Task Filter" dropdown to show all/executed/cached tasks
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';
local at = lib.at;
local var = g.dashboard.variable;

// ============================================================================
// Variables (dropdowns)
// ============================================================================

// Task filter: All / Executed only / Cached only
// Values are TraceQL filter fragments that get appended to queries
local taskFilterVar =
  var.custom.new(
    'task_filter',
    [
      { key: 'All Tasks', value: '' },
      { key: 'Executed Only', value: ' && span.task.cached=false' },
      { key: 'Cached Only', value: ' && span.task.cached=true' },
    ],
  )
  + var.custom.generalOptions.withLabel('Task Filter')
  + var.custom.generalOptions.withDescription('Filter sub-tasks by cache status')
  + var.custom.generalOptions.withCurrent('All Tasks', '');

// ============================================================================
// Helper functions
// ============================================================================

// Helper: trace table with sorting by startTime (descending) and relative time display
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

// ============================================================================
// Layout coordinates
// ============================================================================

local y = {
  // Row 1: Overview stats
  statsRow: 0,
  stats: 1,
  // Row 2: Top-level devenv task executions
  topLevelRow: 5,
  topLevel: 6,
  // Row 3: Sub-task breakdown (the bottleneck finder)
  subtaskRow: 16,
  subtask: 17,
  // Row 4: Slowest sub-tasks
  slowRow: 27,
  slow: 28,
  // Row 5: Failures
  failRow: 38,
  fail: 39,
};

// ============================================================================
// Dashboard
// ============================================================================

g.dashboard.new('devenv task Performance')
+ g.dashboard.withUid('otel-devenv-tasks')
+ g.dashboard.withDescription('Performance of native devenv task spans. Use Task Filter to show cached vs executed tasks.')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withTimezone('browser')
+ g.dashboard.withVariables([taskFilterVar])
+ g.dashboard.withPanels([

  // =========================================================================
  // Row: Overview stats
  // =========================================================================
  at(g.panel.row.new('Overview'), 0, y.statsRow, 24, 1),

  at(
    g.panel.stat.new('devenv task executions')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="effect-utils-devenv" && name="devenv.task.exec"}', 'A', 100),
    ]),
    0, y.stats, 4, 4,
  ),

  at(
    g.panel.stat.new('Executed tasks')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.cached=false}', 'A', 500),
    ])
    + g.panel.stat.options.withColorMode('value')
    + g.panel.stat.standardOptions.color.withMode('fixed')
    + g.panel.stat.standardOptions.color.withFixedColor('green'),
    4, y.stats, 4, 4,
  ),

  at(
    g.panel.stat.new('Cached tasks')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="effect-utils-devenv" && name="devenv.task.status" && span.task.cached=true}', 'A', 500),
    ])
    + g.panel.stat.options.withColorMode('value')
    + g.panel.stat.standardOptions.color.withMode('fixed')
    + g.panel.stat.standardOptions.color.withFixedColor('blue'),
    8, y.stats, 4, 4,
  ),

  at(
    g.panel.stat.new('Total tasks')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="effect-utils-devenv" && name=~"devenv.task.exec|devenv.task.status"}', 'A', 500),
    ])
    + g.panel.stat.options.withColorMode('value')
    + g.panel.stat.standardOptions.color.withMode('fixed')
    + g.panel.stat.standardOptions.color.withFixedColor('purple'),
    12, y.stats, 4, 4,
  ),

  at(
    g.panel.stat.new('Failed executions')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && status.code=error}', 'A', 100),
    ])
    + g.panel.stat.options.withColorMode('value')
    + g.panel.stat.standardOptions.color.withMode('fixed')
    + g.panel.stat.standardOptions.color.withFixedColor('red'),
    16, y.stats, 4, 4,
  ),

  at(
    g.panel.stat.new('Failed (sub-task)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="effect-utils-devenv" && name=~"devenv.task.exec|devenv.task.status" && status.code=error}', 'A', 100),
    ])
    + g.panel.stat.options.withColorMode('value')
    + g.panel.stat.standardOptions.color.withMode('fixed')
    + g.panel.stat.standardOptions.color.withFixedColor('red'),
    20, y.stats, 4, 4,
  ),

  // =========================================================================
  // Row: devenv task executions
  // =========================================================================
  at(g.panel.row.new('devenv task executions'), 0, y.topLevelRow, 24, 1),

  at(
    traceTable('Recent devenv task spans (click trace ID to see sub-task waterfall)', '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec"}', 50),
    0, y.topLevel, 24, 10,
  ),

  // =========================================================================
  // Row: Sub-task breakdown (the bottleneck finder!)
  // Uses $task_filter variable to filter by cache status
  // =========================================================================
  at(g.panel.row.new('Sub-Task Breakdown (use Task Filter dropdown above)'), 0, y.subtaskRow, 24, 1),

  at(
    traceTable(
      'Sub-tasks filtered by cache status (green=executed, blue=cached)',
      '{resource.service.name="effect-utils-devenv" && name=~"devenv.task.exec|devenv.task.status"$task_filter}',
      200
    ),
    0, y.subtask, 24, 10,
  ),

  // =========================================================================
  // Row: Slowest sub-tasks (> 5s) - only executed tasks can be slow
  // =========================================================================
  at(g.panel.row.new('Slow Sub-Tasks (> 5s)'), 0, y.slowRow, 24, 1),

  at(
      traceTable('Sub-tasks exceeding 5 seconds — these are your bottlenecks', '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && duration > 5s && span.task.cached=false}', 100),
    0, y.slow, 24, 10,
  ),

  // =========================================================================
  // Row: Failures
  // =========================================================================
  at(g.panel.row.new('Failures'), 0, y.failRow, 24, 1),

  at(
    traceTable('Failed tasks (root and sub-task)', '{resource.service.name="effect-utils-devenv" && name=~"devenv.task.exec|devenv.task.status" && status.code=error}', 50),
    0, y.fail, 24, 10,
  ),
])
