// dt Task Duration Trends dashboard
// Time-series charts tracking task durations over time with percentiles.
//
// Uses TraceQL metrics (Tempo local_blocks) to compute p50/p95/p99
// from raw trace spans. Requires:
//   - Tempo metrics_generator with local_blocks processor
//   - Grafana datasource with traceqlMetrics: true
//
// Main tasks tracked:
//   - check:quick (the most common developer workflow)
//   - ts:check, ts:build (TypeScript compilation)
//   - pnpm:install (dependency installation)
//   - genie:run (config generation)
//   - lint:check (linting)
//   - test:run (test execution)
//   - megarepo:sync (repo synchronization)
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';
local at = lib.at;

// =========================================================================
// Helper: create a duration percentile time series panel for a specific task
// =========================================================================
local taskDurationPanel(title, taskFilter, h=8) =
  lib.durationTimeSeries(
    title,
    [
      lib.tempoMetricsQuery(
        '{resource.service.name="dt-task" && name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.5) by (name)',
        'p50',
      ),
      lib.tempoMetricsQuery(
        '{resource.service.name="dt-task" && name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.95) by (name)',
        'p95',
      ),
      lib.tempoMetricsQuery(
        '{resource.service.name="dt-task" && name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.99) by (name)',
        'p99',
      ),
    ],
  );

// Helper: create a rate panel (invocations/min)
local taskRatePanel(title, taskFilter) =
  g.panel.timeSeries.new(title)
  + g.panel.timeSeries.queryOptions.withTargets([
    lib.tempoMetricsQuery(
      '{resource.service.name="dt-task" && name=~"' + taskFilter + '"} | rate() by (name)',
      'A',
    ),
  ])
  + g.panel.timeSeries.standardOptions.withUnit('cpm')
  + g.panel.timeSeries.fieldConfig.defaults.custom.withLineWidth(1)
  + g.panel.timeSeries.fieldConfig.defaults.custom.withFillOpacity(20);

// Y positions for layout
local y = {
  // Row 1: Top-level overview
  overviewRow: 0,
  overviewRate: 1,
  overviewDuration: 1,
  // Row 2: check:quick (most common workflow)
  checkQuickRow: 9,
  checkQuick: 10,
  // Row 3: TypeScript
  tsRow: 18,
  tsCheck: 19,
  tsBuild: 19,
  // Row 4: Install + Genie
  installRow: 27,
  pnpmInstall: 28,
  genieRun: 28,
  // Row 5: Lint + Test
  lintTestRow: 36,
  lintCheck: 37,
  testRun: 37,
  // Row 6: Other
  otherRow: 45,
  megarepo: 46,
  nixBuild: 46,
};

g.dashboard.new('dt Task Duration Trends')
+ g.dashboard.withUid('otel-dt-duration-trends')
+ g.dashboard.withDescription('Track task duration over time with p50/p95/p99 percentiles — identify regressions and improvements')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withTimezone('browser')
+ g.dashboard.time.withFrom('now-24h')
+ g.dashboard.time.withTo('now')
+ g.dashboard.withPanels([

  // =========================================================================
  // Row: Overview — all dt invocations
  // =========================================================================
  at(g.panel.row.new('Overview — All dt Invocations'), 0, y.overviewRow, 24, 1),

  // Top-level dt invocation durations (the wall time users experience)
  at(
    lib.durationTimeSeries(
      'dt invocation duration (p50 / p95 / p99)',
      [
        lib.tempoMetricsQuery(
          '{resource.service.name="dt"} | quantile_over_time(duration, 0.5)',
          'p50',
        ),
        lib.tempoMetricsQuery(
          '{resource.service.name="dt"} | quantile_over_time(duration, 0.95)',
          'p95',
        ),
        lib.tempoMetricsQuery(
          '{resource.service.name="dt"} | quantile_over_time(duration, 0.99)',
          'p99',
        ),
      ],
    ),
    0, y.overviewDuration, 16, 8,
  ),

  // Invocation rate
  at(
    taskRatePanel('dt invocation rate', '.*')
    + { fieldConfig+: { defaults+: { unit: 'cpm' } } },
    16, y.overviewRate, 8, 8,
  ),

  // =========================================================================
  // Row: check:quick — the most common developer workflow
  // =========================================================================
  at(g.panel.row.new('check:quick — Most Common Workflow'), 0, y.checkQuickRow, 24, 1),

  at(
    lib.durationTimeSeries(
      'check:quick total duration (p50 / p95 / p99)',
      [
        lib.tempoMetricsQuery(
          '{resource.service.name="dt" && name="check:quick"} | quantile_over_time(duration, 0.5)',
          'p50',
        ),
        lib.tempoMetricsQuery(
          '{resource.service.name="dt" && name="check:quick"} | quantile_over_time(duration, 0.95)',
          'p95',
        ),
        lib.tempoMetricsQuery(
          '{resource.service.name="dt" && name="check:quick"} | quantile_over_time(duration, 0.99)',
          'p99',
        ),
      ],
    ),
    0, y.checkQuick, 12, 8,
  ),

  // check:quick sub-task breakdown
  at(
    taskDurationPanel(
      'check:quick sub-tasks (p50 / p95 / p99)',
      'ts:check|lint:check:oxlint|lint:check:format|lint:check:genie|genie:run|nix:check:quick:.*|workspace:check',
    ),
    12, y.checkQuick, 12, 8,
  ),

  // =========================================================================
  // Row: TypeScript — ts:check and ts:build
  // =========================================================================
  at(g.panel.row.new('TypeScript'), 0, y.tsRow, 24, 1),

  at(
    taskDurationPanel('ts:check duration (p50 / p95 / p99)', 'ts:check'),
    0, y.tsCheck, 12, 8,
  ),

  at(
    taskDurationPanel('ts:build duration (p50 / p95 / p99)', 'ts:build'),
    12, y.tsBuild, 12, 8,
  ),

  // =========================================================================
  // Row: Install + Genie
  // =========================================================================
  at(g.panel.row.new('Install + Config Generation'), 0, y.installRow, 24, 1),

  at(
    taskDurationPanel('pnpm:install duration (p50 / p95 / p99)', 'pnpm:install'),
    0, y.pnpmInstall, 12, 8,
  ),

  at(
    taskDurationPanel('genie:run duration (p50 / p95 / p99)', 'genie:run'),
    12, y.genieRun, 12, 8,
  ),

  // =========================================================================
  // Row: Lint + Test
  // =========================================================================
  at(g.panel.row.new('Lint + Test'), 0, y.lintTestRow, 24, 1),

  at(
    taskDurationPanel('lint:check duration (p50 / p95 / p99)', 'lint:check:oxlint|lint:check:format'),
    0, y.lintCheck, 12, 8,
  ),

  at(
    taskDurationPanel('test:run duration (p50 / p95 / p99)', 'test:.*'),
    12, y.testRun, 12, 8,
  ),

  // =========================================================================
  // Row: Other — megarepo, nix builds
  // =========================================================================
  at(g.panel.row.new('Other Tasks'), 0, y.otherRow, 24, 1),

  at(
    taskDurationPanel('megarepo:sync duration (p50 / p95 / p99)', 'megarepo:sync|megarepo:check'),
    0, y.megarepo, 12, 8,
  ),

  at(
    taskDurationPanel('nix:build duration (p50 / p95 / p99)', 'nix:build:.*|nix:hash:.*'),
    12, y.nixBuild, 12, 8,
  ),
])
