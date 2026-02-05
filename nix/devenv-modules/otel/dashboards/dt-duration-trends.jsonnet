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
//   - nix:build, nix:check, nix:hash (Nix operations)
//   - tsc per-project breakdown (from extendedDiagnostics spans)
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

// Helper: dt root span duration panel
local dtRootDurationPanel(title, taskFilter) =
  lib.durationTimeSeries(
    title,
    [
      lib.tempoMetricsQuery(
        '{resource.service.name="dt" && name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.5)',
        'p50',
      ),
      lib.tempoMetricsQuery(
        '{resource.service.name="dt" && name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.95)',
        'p95',
      ),
      lib.tempoMetricsQuery(
        '{resource.service.name="dt" && name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.99)',
        'p99',
      ),
    ],
  );

// Helper: tsc project breakdown panel (from extendedDiagnostics child spans)
local tscProjectPanel(title) =
  lib.durationTimeSeries(
    title,
    [
      lib.tempoMetricsQuery(
        '{resource.service.name="tsc-project"} | quantile_over_time(duration, 0.5) by (name)',
        'p50',
      ),
      lib.tempoMetricsQuery(
        '{resource.service.name="tsc-project"} | quantile_over_time(duration, 0.95) by (name)',
        'p95',
      ),
    ],
  );

// Y positions for layout (each row header is 1 unit, content is 8 units)
local y = {
  // Row 1: Top-level overview
  overviewRow: 0,
  overviewContent: 1,
  // Row 2: check:quick (most common workflow)
  checkQuickRow: 9,
  checkQuickContent: 10,
  // Row 3: TypeScript
  tsRow: 18,
  tsContent: 19,
  // Row 4: Install + Genie
  installRow: 27,
  installContent: 28,
  // Row 5: Lint Components
  lintRow: 36,
  lintContent: 37,
  // Row 6: Test Execution
  testRow: 45,
  testContent: 46,
  // Row 7: Nix Operations
  nixRow: 54,
  nixContent: 55,
  // Row 8: Megarepo + Other
  megarepoRow: 63,
  megarepoContent: 64,
  // Row 9: Shell Entry Performance
  shellRow: 72,
  shellContent: 73,
  // Row 10: Per-Package Install Times
  pkgInstallRow: 81,
  pkgInstallContent: 82,
  // Row 11: TypeScript Per-Project Breakdown
  tscProjectRow: 90,
  tscProjectContent: 91,
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
  // Row 1: Overview — all dt invocations
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
    0, y.overviewContent, 16, 8,
  ),

  // Invocation rate
  at(
    taskRatePanel('dt invocation rate', '.*')
    + { fieldConfig+: { defaults+: { unit: 'cpm' } } },
    16, y.overviewContent, 8, 8,
  ),

  // =========================================================================
  // Row 2: check:quick — the most common developer workflow
  // =========================================================================
  at(g.panel.row.new('check:quick — Most Common Workflow'), 0, y.checkQuickRow, 24, 1),

  at(
    dtRootDurationPanel('check:quick total duration (p50 / p95 / p99)', 'check:quick'),
    0, y.checkQuickContent, 12, 8,
  ),

  // check:quick sub-task breakdown
  at(
    taskDurationPanel(
      'check:quick sub-tasks (p50 / p95 / p99)',
      'ts:check|lint:check:oxlint|lint:check:format|lint:check:genie|genie:run|nix:check:quick:.*|workspace:check',
    ),
    12, y.checkQuickContent, 12, 8,
  ),

  // =========================================================================
  // Row 3: TypeScript — ts:check and ts:build
  // =========================================================================
  at(g.panel.row.new('TypeScript Compilation'), 0, y.tsRow, 24, 1),

  at(
    taskDurationPanel('ts:check duration (p50 / p95 / p99)', 'ts:check'),
    0, y.tsContent, 12, 8,
  ),

  at(
    taskDurationPanel('ts:build duration (p50 / p95 / p99)', 'ts:build'),
    12, y.tsContent, 12, 8,
  ),

  // =========================================================================
  // Row 4: Install + Genie
  // =========================================================================
  at(g.panel.row.new('Install + Config Generation'), 0, y.installRow, 24, 1),

  at(
    taskDurationPanel('pnpm:install (aggregate) (p50 / p95 / p99)', 'pnpm:install.*'),
    0, y.installContent, 12, 8,
  ),

  at(
    taskDurationPanel('genie:run duration (p50 / p95 / p99)', 'genie:run'),
    12, y.installContent, 12, 8,
  ),

  // =========================================================================
  // Row 5: Lint Components
  // =========================================================================
  at(g.panel.row.new('Lint Components'), 0, y.lintRow, 24, 1),

  at(
    taskDurationPanel('lint:check:oxlint (p50 / p95 / p99)', 'lint:check:oxlint'),
    0, y.lintContent, 8, 8,
  ),

  at(
    taskDurationPanel('lint:check:format (oxfmt) (p50 / p95 / p99)', 'lint:check:format'),
    8, y.lintContent, 8, 8,
  ),

  at(
    taskDurationPanel('lint:check:genie (p50 / p95 / p99)', 'lint:check:genie'),
    16, y.lintContent, 8, 8,
  ),

  // =========================================================================
  // Row 6: Test Execution
  // =========================================================================
  at(g.panel.row.new('Test Execution'), 0, y.testRow, 24, 1),

  at(
    taskDurationPanel('test:* aggregate (p50 / p95 / p99)', 'test:.*'),
    0, y.testContent, 12, 8,
  ),

  // Per-package test breakdown
  at(
    taskDurationPanel(
      'Per-package test times (p50 / p95)',
      'test:megarepo|test:genie|test:tui-react|test:tui-core|test:utils|test:notion-cli|test:notion-effect-client|test:notion-effect-schema|test:effect-path|test:effect-rpc-tanstack|test:effect-ai-claude-cli|test:oxc-config',
    ),
    12, y.testContent, 12, 8,
  ),

  // =========================================================================
  // Row 7: Nix Operations
  // =========================================================================
  at(g.panel.row.new('Nix Operations'), 0, y.nixRow, 24, 1),

  at(
    taskDurationPanel('nix:build:* (p50 / p95 / p99)', 'nix:build:.*'),
    0, y.nixContent, 8, 8,
  ),

  at(
    taskDurationPanel('nix:check:quick:* (p50 / p95 / p99)', 'nix:check:quick:.*'),
    8, y.nixContent, 8, 8,
  ),

  at(
    taskDurationPanel('nix:hash:* (p50 / p95 / p99)', 'nix:hash:.*'),
    16, y.nixContent, 8, 8,
  ),

  // =========================================================================
  // Row 8: Megarepo + Other
  // =========================================================================
  at(g.panel.row.new('Megarepo + Other'), 0, y.megarepoRow, 24, 1),

  at(
    taskDurationPanel('megarepo:sync (p50 / p95 / p99)', 'megarepo:sync'),
    0, y.megarepoContent, 8, 8,
  ),

  at(
    taskDurationPanel('megarepo:check (p50 / p95 / p99)', 'megarepo:check'),
    8, y.megarepoContent, 8, 8,
  ),

  at(
    taskDurationPanel('workspace:check (p50 / p95 / p99)', 'workspace:check'),
    16, y.megarepoContent, 8, 8,
  ),

  // =========================================================================
  // Row 9: Shell Entry Performance
  // =========================================================================
  at(g.panel.row.new('Shell Entry Performance'), 0, y.shellRow, 24, 1),

  // Shell entry uses service.name="dt-shell-entry" for the root span
  at(
    lib.durationTimeSeries(
      'Shell entry total time (p50 / p95 / p99)',
      [
        lib.tempoMetricsQuery(
          '{resource.service.name="dt-shell-entry"} | quantile_over_time(duration, 0.5)',
          'p50',
        ),
        lib.tempoMetricsQuery(
          '{resource.service.name="dt-shell-entry"} | quantile_over_time(duration, 0.95)',
          'p95',
        ),
        lib.tempoMetricsQuery(
          '{resource.service.name="dt-shell-entry"} | quantile_over_time(duration, 0.99)',
          'p99',
        ),
      ],
    ),
    0, y.shellContent, 12, 8,
  ),

  // Shell entry sub-tasks (setup:gate, pnpm:install, genie:run, ts:patch-lsp, etc.)
  at(
    taskDurationPanel(
      'Shell entry sub-tasks (p50 / p95)',
      'setup:gate|setup:opt:.*|devenv:.*|ts:patch-lsp',
    ),
    12, y.shellContent, 12, 8,
  ),

  // =========================================================================
  // Row 10: Per-Package Install Times
  // =========================================================================
  at(g.panel.row.new('Per-Package Install Times'), 0, y.pkgInstallRow, 24, 1),

  at(
    taskDurationPanel(
      'pnpm:install per-package (p50 / p95)',
      'pnpm:install:otel-cli|pnpm:install:tui-react|pnpm:install:megarepo|pnpm:install:genie|pnpm:install:notion-cli|pnpm:install:utils|pnpm:install:effect-path|pnpm:install:effect-react|pnpm:install:effect-rpc-tanstack|pnpm:install:effect-schema-form|pnpm:install:effect-schema-form-aria|pnpm:install:effect-ai-claude-cli|pnpm:install:react-inspector|pnpm:install:tui-core|pnpm:install:notion-effect-client|pnpm:install:notion-effect-schema|pnpm:install:oxc-config|pnpm:install:utils-dev',
    ),
    0, y.pkgInstallContent, 24, 8,
  ),

  // =========================================================================
  // Row 11: TypeScript Per-Project Breakdown (from tsc --extendedDiagnostics)
  // =========================================================================
  at(g.panel.row.new('TypeScript Per-Project Breakdown (tsc diagnostics)'), 0, y.tscProjectRow, 24, 1),

  at(
    tscProjectPanel('tsc per-project compilation time (p50 / p95)'),
    0, y.tscProjectContent, 24, 8,
  ),
])
