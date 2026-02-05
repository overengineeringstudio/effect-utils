// dt Task Performance dashboard
// Primary dashboard for understanding task execution times.
// This directly addresses the PR #114 use case (pnpm install overhead).
//
// Only explicit `dt <task>` calls are traced. Sub-tasks run by devenv's
// internal task runner (e.g. pnpm:install during check:quick) are not
// individually traced — they appear as part of the parent task's duration.
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';
local at = lib.at;

// Track y position manually for clean layout
local y = {
  statsRow: 0,
  stats: 1,
  infoRow: 5,
  info: 6,
  allRunsRow: 12,
  allRuns: 13,
  slowRow: 23,
  slow: 24,
  failRow: 34,
  fail: 35,
};

g.dashboard.new('dt Task Performance')
+ g.dashboard.withUid('otel-dt-tasks')
+ g.dashboard.withDescription('Performance of dt (devenv tasks) executions — only explicit dt <task> calls are traced')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withTimezone('browser')
+ g.dashboard.withPanels([

  // =========================================================================
  // Row: Overview stats
  // =========================================================================
  at(g.panel.row.new('Overview'), 0, y.statsRow, 24, 1),

  at(
    g.panel.stat.new('Total task runs')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt"}', 'A', 100),
    ]),
    0, y.stats, 8, 4,
  ),

  at(
    g.panel.stat.new('Failed tasks')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && status.code=error}', 'A', 100),
    ]),
    8, y.stats, 8, 4,
  ),

  at(
    g.panel.stat.new('Unique task names')
    + g.panel.stat.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt"}', 'A', 100),
    ])
    + g.panel.stat.options.withReduceOptions({
      calcs: ['count'],
    }),
    16, y.stats, 8, 4,
  ),

  // =========================================================================
  // Row: How this works
  // =========================================================================
  at(g.panel.row.new('How Tracing Works'), 0, y.infoRow, 24, 1),

  at(
    g.panel.text.new('Tracing Info')
    + g.panel.text.options.withContent(|||
      ### What's traced

      Every **`dt <task>`** command is automatically wrapped in an OTEL span by the `dt` wrapper script.
      The span captures the **task name**, **duration**, and **exit code**.

      **What's NOT traced:** Sub-tasks run internally by devenv's task runner (e.g. `pnpm:install` as a
      dependency of `check:quick`) are not individually traced — they contribute to the parent task's
      total duration. Only top-level `dt` invocations produce spans.

      ### Deeper analysis

      Use **Explore → Tempo** in the sidebar for:
      - TraceQL queries like `{resource.service.name="dt" && duration > 10s}`
      - Trace ID lookups
      - Full span detail view with attributes (`dt.args`, `exit.code`, `devenv.root`)
    |||),
    0, y.info, 24, 6,
  ),

  // =========================================================================
  // Row: All task runs (main table)
  // =========================================================================
  at(g.panel.row.new('All Task Runs'), 0, y.allRunsRow, 24, 1),

  at(
    g.panel.table.new('Recent task runs')
    + g.panel.table.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt"}', 'A', 100),
    ]),
    0, y.allRuns, 24, 10,
  ),

  // =========================================================================
  // Row: Slowest tasks
  // =========================================================================
  at(g.panel.row.new('Slow Tasks (> 5s)'), 0, y.slowRow, 24, 1),

  at(
    g.panel.table.new('Tasks exceeding 5 seconds')
    + g.panel.table.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && duration > 5s}', 'A', 100),
    ]),
    0, y.slow, 24, 10,
  ),

  // =========================================================================
  // Row: Failures
  // =========================================================================
  at(g.panel.row.new('Failures'), 0, y.failRow, 24, 1),

  at(
    g.panel.table.new('Failed task traces')
    + g.panel.table.queryOptions.withTargets([
      lib.tempoQuery('{resource.service.name="dt" && status.code=error}', 'A', 50),
    ]),
    0, y.fail, 24, 10,
  ),
])
