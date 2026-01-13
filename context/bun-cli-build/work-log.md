# mk-bun-cli Work Log

## 2026-01-13 17:13:24 +0100

- Run: `tests/mk-bun-cli/run.sh`
- Result: aborted during devenv step (no output after warnings)
- Timings: workspace setup 0s; effect-utils build 9s; peer bunDepsHash 4s; peer nix build 3s

## 2026-01-13 17:14:45 +0100

- Run: `tests/mk-bun-cli/run.sh --skip-effect-utils --skip-peer --keep`
- Result: failed in devenv (bunDepsHash fake because peer hash was skipped)
- Timings: workspace setup 0s
- Follow-up: updated `tests/mk-bun-cli/run.sh` to always resolve bunDepsHash when devenv runs

## 2026-01-13 17:17:18 +0100

- Run: `tests/mk-bun-cli/run.sh --skip-effect-utils --skip-peer --keep`
- Result: aborted during devenv (no output after warnings, likely options passed after CMD)
- Timings: workspace setup 0s; peer bunDepsHash 15s
- Follow-up: updated `tests/mk-bun-cli/run.sh` to pass devenv options before CMD and run `bash -lc "app-cli"`

## 2026-01-13 17:17:49 +0100

- Run: `tests/mk-bun-cli/run.sh --skip-effect-utils --skip-peer --keep`
- Result: success
- Timings: workspace setup 0s; peer bunDepsHash 3s; devenv shell 8s (reported 7.46s); total 11s

## 2026-01-13 17:20:02 +0100

- Run: `tests/mk-bun-cli/run.sh --dirty`
- Result: success
- Timings: workspace setup 1s; effect-utils build 7s; peer bunDepsHash 3s; peer nix build 3s; dirty rebuild 4s; devenv shell 9s (reported 7.78s); total 27s

## 2026-01-13 17:24:32 +0100

- Run: `NIX_CLI_BUILD_STAMP=abc123+2026-01-13T17:20:00+01:00 ./result/bin/genie --version`
- Output: `0.1.0+a096abe-dirty (stamp abc123+2026-01-13T17:20:00+01:00)`

- Run: `NIX_CLI_BUILD_STAMP=abc123+2026-01-13T17:20:00+01:00 ./result-1/bin/dotdot --version`
- Output: `0.1.0+a096abe-dirty (stamp abc123+2026-01-13T17:20:00+01:00)`

## 2026-01-13 18:26:59 +0100

- Run: `tests/mk-bun-cli/run.sh --dirty`
- Result: failed while building dotdot (TypeScript error)
- Error: `packages/@overeng/dotdot/src/commands/sync.integration.test.ts:174:16 - TS2532: Object is possibly 'undefined'.`

## 2026-01-13 18:27:35 +0100

- Run: `tests/mk-bun-cli/run.sh --dirty --skip-effect-utils`
- Result: success (peer repo + devenv validation)
- Timings: workspace setup 1s; peer bunDepsHash 4s; peer nix build 3s; dirty rebuild 4s; devenv shell 11s (reported 9.93s); total 23s

## 2026-01-13 18:39:56 +0100

- Run: `devenv update`
- Result: success (lock updated)

- Run: `tests/mk-bun-cli/run.sh --dirty`
- Result: success
- Timings: workspace setup 1s; effect-utils build 7s; peer bunDepsHash 3s; peer nix build 3s; dirty rebuild 4s; devenv shell 8s (reported 7.91s); total 26s

## 2026-01-13 18:54:21 +0100

- Run: `/usr/bin/time -p direnv reload`
- Result: success
- Timings: real 0.00; user 0.00; sys 0.00

## 2026-01-13 18:59:41 +0100

- Run: `/usr/bin/time -p direnv allow`
- Result: success
- Timings: real 0.00; user 0.00; sys 0.00

## 2026-01-13 19:04:16 +0100

- Run: `/usr/bin/time -p devenv shell -- true`
- Result: success (warning: unknown setting 'eval-cores')
- Timings: real 15.89; user 0.08; sys 0.10

## 2026-01-13 21:18:53 +0100

- Run: `/usr/bin/time -p tests/mk-bun-cli/run.sh --dirty`
- Result: interrupted during devenv validation (no output after warnings)
- Timings: workspace setup 1s; effect-utils build 10s; peer bunDepsHash 5s; peer nix build 4s; dirty rebuild 4s; total 199.90s (interrupted)

## 2026-01-13 21:18:53 +0100

- Run: `/usr/bin/time -p tests/mk-bun-cli/run.sh --keep --skip-effect-utils --skip-peer`
- Result: interrupted during devenv validation (no output after warnings)
- Timings: workspace setup 0s; peer bunDepsHash 4s; total 194.75s (interrupted)

## 2026-01-13 21:18:53 +0100

- Run: `/usr/bin/time -p devenv print-dev-env --override-input effect-utils path:... --override-input workspace path:...`
- Result: interrupted during "Building shell"
- Timings: real 85.58; user 1.28; sys 0.48

## 2026-01-13 21:18:53 +0100

- Run: `/usr/bin/time -p devenv shell --override-input effect-utils path:... --override-input workspace path:... bash -lc "app-cli"`
- Result: interrupted during "Building shell"
- Timings: real 70.88; user 1.19; sys 0.34
