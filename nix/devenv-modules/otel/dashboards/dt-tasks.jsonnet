// dt Task Performance dashboard
// Primary dashboard for understanding task execution times and bottlenecks.
//
// Two trace levels:
//   - Root spans (service.name="dt"): top-level `dt <task>` invocations
//   - Child spans (service.name="dt-task"): individual sub-task executions
//
// Cached sub-tasks don't emit spans (devenv skips their exec), so only
// actually-executed sub-tasks appear. This is correct: cached tasks have
// ~0 cost and don't need visibility.
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';
local at = lib.at;

local y = {
  // Row 1: Overview stats
  statsRow: 0,
  stats: 1,
  // Row 2: Top-level dt invocations
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

g.dashboard.new('dt Task Performance')
+ g.dashboard.withUid('otel-dt-tasks')
+ g.dashboard.withDescription('Performance of dt (devenv tasks) — root spans show total wall time, child spans reveal per-task bottlenecks')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withTimezone('browser')
+ g.dashboard.withPanels([

  // =========================================================================
  // Row: Overview stats
  // =========================================================================
  at(g.panel.row.new('Overview'), 0, y.statsRow, 24, 1),

  at(
    g.panel.stat.new('dt invocations')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt"}', 'A', 100),
    ]),
    0, y.stats, 6, 4,
  ),

  at(
    g.panel.stat.new('Sub-task executions')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt-task"}', 'A', 200),
    ]),
    6, y.stats, 6, 4,
  ),

  at(
    g.panel.stat.new('Failed (root)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && status.code=error}', 'A', 100),
    ]),
    12, y.stats, 6, 4,
  ),

  at(
    g.panel.stat.new('Failed (sub-task)')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt-task" && status.code=error}', 'A', 100),
    ]),
    18, y.stats, 6, 4,
  ),

  // =========================================================================
  // Row: Top-level dt invocations (root spans)
  // =========================================================================
  at(g.panel.row.new('Top-Level dt Invocations'), 0, y.topLevelRow, 24, 1),

  at(
    g.panel.table.new('Recent dt calls (click trace ID to see sub-task waterfall)')
    + g.panel.table.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt"}', 'A', 50),
    ]),
    0, y.topLevel, 24, 10,
  ),

  // =========================================================================
  // Row: Sub-task breakdown (the bottleneck finder!)
  // =========================================================================
  at(g.panel.row.new('Sub-Task Breakdown (Bottleneck Finder)'), 0, y.subtaskRow, 24, 1),

  at(
    g.panel.table.new('All executed sub-tasks — cached tasks are invisible (correctly: 0 cost)')
    + g.panel.table.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt-task"}', 'A', 200),
    ]),
    0, y.subtask, 24, 10,
  ),

  // =========================================================================
  // Row: Slowest sub-tasks (> 5s)
  // =========================================================================
  at(g.panel.row.new('Slow Sub-Tasks (> 5s)'), 0, y.slowRow, 24, 1),

  at(
    g.panel.table.new('Sub-tasks exceeding 5 seconds — these are your bottlenecks')
    + g.panel.table.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt-task" && duration > 5s}', 'A', 100),
    ]),
    0, y.slow, 24, 10,
  ),

  // =========================================================================
  // Row: Failures
  // =========================================================================
  at(g.panel.row.new('Failures'), 0, y.failRow, 24, 1),

  at(
    g.panel.table.new('Failed tasks (root and sub-task)')
    + g.panel.table.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name=~"dt|dt-task" && status.code=error}', 'A', 50),
    ]),
    0, y.fail, 24, 10,
  ),
])
