# TypeScript Target Execution Requirements

## Context

TypeScript target execution refines the shared
[target execution requirements](../requirements.md) for TypeScript project
validation, tests, and standalone executable production.

## Assumptions

- **BUCK.EXEC.TS-A01 Shared execution contract:** The common target envelope,
  declared-action, tool-provider, quality, platform, and evidence requirements
  are inherited from `BUCK.EXEC-R01` through `BUCK.EXEC-R17`.
- **BUCK.EXEC.TS-A02 Dependency authority:** The canonical package manifest,
  workspace policy, and package-manager lock projection determine external and
  workspace dependency identity. The TypeScript adapter consumes their declared
  closure rather than resolving packages.

## Acceptable Tradeoffs

- **BUCK.EXEC.TS-T01 Staged workspace:** An action may construct an isolated
  workspace from declared files and dependency artifacts when the compiler or
  bundler requires package-relative filesystem layout.
- **BUCK.EXEC.TS-T02 Role-specific closures:** Project checking, tests, tools,
  and runtime compilation may consume different dependency closures when their
  observable package capabilities differ.

## Requirements

### Must preserve TypeScript semantics

- **BUCK.EXEC.TS-R01 Target variants:** The TypeScript adapter must distinguish
  project checking, test execution, linting, formatting, and executable
  compilation as semantic roles rather than one generic command target.
  Refines: BUCK.EXEC-R01, BUCK.EXEC-R03, BUCK.EXEC-R05.
- **BUCK.EXEC.TS-R02 Project graph:** Project references, compiler options,
  module-resolution configuration, source sets, generated declarations, and
  workspace-package edges that can affect a result must be declared inputs.
  Refines: BUCK.EXEC-R03, BUCK.EXEC-R04.
- **BUCK.EXEC.TS-R03 Entry and output identity:** An executable target must name
  one declared entrypoint, output name, build identity input, runtime ABI, and
  target platform.
  Refines: BUCK.EXEC-R02, BUCK.EXEC-R17.

### Must isolate dependency and tool execution

- **BUCK.EXEC.TS-R04 Exact package closure:** Each action must consume the
  external and workspace package contexts selected for its role and configured
  platform, without access to an ambient `node_modules` tree or mutable package
  store.
  Refines: BUCK.EXEC-R04, BUCK.EXEC-R06.
- **BUCK.EXEC.TS-R05 Native package selection:** Platform-specific native
  packages and runtime assets must be explicit closure members selected by the
  configured target and execution platforms.
  Refines: BUCK.EXEC-R04, BUCK.EXEC-R14.
- **BUCK.EXEC.TS-R06 Canonical executables:** The TypeScript compiler, linter,
  formatter, test runner, JavaScript runtime, bundler, and native normalization
  tools must be declared tool-provider inputs.
  Refines: BUCK.EXEC-R11.
- **BUCK.EXEC.TS-R07 Deterministic staging:** Isolated workspace staging must
  reject escaping or duplicate paths and produce equivalent compiler-visible
  structure for equivalent declared inputs regardless of checkout location or
  source mtime.
  Refines: BUCK.EXEC-R04, BUCK.EXEC-R06, BUCK.EXEC-R15.

### Must expose authoritative quality and artifacts

- **BUCK.EXEC.TS-R08 Validation separation:** Project checking, linting,
  formatting, test execution, executable compilation, normalization, and
  packaging must expose independent validation or output targets where their
  inputs differ.
  Refines: BUCK.EXEC-R05, BUCK.EXEC-R08.
- **BUCK.EXEC.TS-R09 Diagnostic policy:** Structured compiler, linter, test, and
  formatter results must be validated under repository policy; a tool's ability
  to emit a report must not mask a failing result.
  Refines: BUCK.EXEC-R09.
- **BUCK.EXEC.TS-R10 Test inventory:** Test actions must report the exact test
  files and cases admitted by their generated role and fail on missing,
  duplicated, or unexpectedly empty inventory.
  Refines: BUCK.EXEC-R10.
- **BUCK.EXEC.TS-R11 Compiler authority:** For an admitted executable, Buck is
  the sole compiler and bundler authority. Deployment convergence consumes the
  verified Buck artifact and does not rebuild the TypeScript sources
  independently.
  Refines: BUCK.EXEC-R17.
