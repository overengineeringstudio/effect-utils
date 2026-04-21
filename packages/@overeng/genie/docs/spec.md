# Genie Specification

This document specifies the `@overeng/genie` subsystem in `effect-utils`. It builds on the package-level context in [../README.md](../README.md) and the build/runtime module boundaries in [../src/build/README.md](../src/build/README.md) and [../src/runtime/README.md](../src/runtime/README.md).

## Status

Active

## Scope

This spec defines:

- the public operating modes of the `genie` CLI
- the source and target file conventions for `.genie.ts` generators
- the boundary between build-time CLI code and runtime generator code
- import resolution, including megarepo-aware `#mr/...` imports
- the end-to-end generation and check pipeline

This spec does not define:

- the detailed API contract of each individual runtime factory such as `package-json` or `tsconfig-json`
- the packaging and hash-refresh mechanics of the Nix CLI wrappers outside the `genie` package itself
- repository-local task wiring beyond the prerequisite boundary that ensures bootstrap members exist before Genie-backed tasks run

## Public Surface

Genie exposes two coupled surfaces:

| Surface | Role |
| --- | --- |
| `genie` CLI | discovers `.genie.ts` files, loads them, validates them, renders outputs, and reports status |
| runtime libraries under `src/runtime/` | provide pure or mostly-pure factories and helpers imported by `.genie.ts` source files |

The CLI supports four operating modes:

| Mode | Trigger | Behavior |
| --- | --- | --- |
| generate | default | writes generated targets to disk |
| check | `--check` | verifies generated targets are already up to date |
| dry-run | `--dry-run` | computes target content and diffs without writing |
| watch | `--watch` | watches `.genie.ts` files and regenerates changed targets |

Generated targets are read-only by default. `--writeable` opts out of that protection.

## Source and Target Model

Every generator source is a `*.genie.ts` file colocated with its generated target. The target path is derived mechanically by removing the `.genie.ts` suffix.

Examples:

| Source | Target |
| --- | --- |
| `package.json.genie.ts` | `package.json` |
| `tsconfig.json.genie.ts` | `tsconfig.json` |
| `.github/workflows/ci.yml.genie.ts` | `.github/workflows/ci.yml` |

Genie treats the `.genie.ts` source as the source of truth. Direct edits to generated files are non-authoritative and are expected to be overwritten by the next generation run.

The generator default export must resolve to a `GenieOutput<TData, TMeta>` shape:

- `data` is the canonical emitted value
- `meta` carries non-emitted composition data
- `stringify(ctx)` renders the final file content

Factories must propagate composition metadata through `meta` instead of reverse-engineering data back out of generated files.

## Build and Runtime Boundary

Genie is split into two execution domains:

| Domain | Directory | Constraint |
| --- | --- | --- |
| build-time CLI | `src/build/` | bundled into the native CLI binary; normal build-time dependencies are allowed |
| runtime generator library | `src/runtime/` | dynamically imported by `.genie.ts` modules; npm dependencies are disallowed |

The runtime layer must stay lightweight and loadable in arbitrary repository contexts because `.genie.ts` files import it directly during evaluation. The build layer may own TUI concerns, CLI option parsing, process orchestration, and other binary-local concerns.

## Import Resolution

Genie must resolve three classes of imports used by `.genie.ts` sources:

- normal Node/TypeScript relative and package imports
- repository-local helper imports
- megarepo member imports using the `#mr/<member>/...` prefix

Megarepo member resolution follows this precedence order:

1. `GENIE_MEMBER_OVERRIDE_MAP`
2. a local member root derived from the importing repository
3. `GENIE_MEMBER_SOURCE_MAP`

Local member root resolution follows this order:

1. discover the enclosing repository root by walking upward from the importer path
2. if `megarepo.lock` exists and contains the member, derive the expected global store worktree path from the locked URL and ref
3. if that derived path exists, use it
4. otherwise fall back to `repos/<member>` if present

This means Genie can resolve `#mr/...` imports against the lock-pinned global megarepo store without requiring the local `repos/` symlink tree, as long as the referenced member worktree already exists in the store.

Genie does not materialize missing megarepo members itself. Repository task wiring is responsible for ensuring required bootstrap members exist before Genie-backed tasks run.

## Discovery and Validation

The core pipeline begins by recursively discovering `*.genie.ts` files beneath the working directory.

Discovery must enforce these invariants before generation begins:

- each source maps to exactly one target
- no two sources may claim the same target path

After discovery, Genie runs repository-wide validation before reporting success. Validation warnings are emitted to the event stream and surfaced in the UI, but hard validation failures abort the run.

## Generation Pipeline

The non-watch pipeline is:

1. normalize the working directory to its real path
2. resolve the active `oxfmt` config path from the explicit CLI option or the standard convention paths
3. discover `.genie.ts` files and reject duplicate targets
4. emit a complete discovered-file list to the event bus
5. load and generate all discovered files concurrently
6. collect per-file successes and failures
7. if temporal dead zone failures were seen, re-check files sequentially to isolate root causes
8. emit final summary counts and fail the run if any file failed

Concurrent generation is the default behavior for throughput. Sequential revalidation exists only as an error-analysis path for ambiguous module-initialization failures.

Check mode reuses the same file loading model but verifies the rendered output against the existing target instead of writing.

## Watch Mode

Watch mode is CLI-specific and intentionally simpler than the full batch pipeline:

1. watch the resolved working directory
2. filter for changes to `*.genie.ts` files
3. re-discover sources so newly added files enter the working set
4. regenerate the changed file
5. mark unchanged files explicitly in the UI summary

Watch mode is only valid for writable generation, not for `--check` or `--dry-run`.

## Output Semantics

Genie-generated files must preserve these semantics:

- target content is rendered from the canonical `GenieOutput`
- supported file types are formatted consistently, including `oxfmt` integration where applicable
- generated files may carry source headers when the output format supports them
- read-only mode is the default safety mechanism for generated targets

The CLI reports per-file status using the normalized statuses:

- `created`
- `updated`
- `unchanged`
- `skipped`
- `error`

Batch completion also reports an aggregate summary across those statuses.

## Error Model

Generation failures are file-oriented but reported at both file and run level.

The run-level failure contract is:

- the event stream reports file start, completion, validation warnings, and terminal completion or error states
- any run with one or more file failures exits with `GenieGenerationFailedError`
- catalog conflicts and TDZ-style import failures are promoted into clearer root-cause reporting instead of surfacing only the first incidental stack trace

This keeps CI-facing `genie --check` behavior strict while still making interactive failures diagnosable.

## Integration Boundary with Devenv and Megarepo

Genie assumes that any source-imported bootstrap members are already available before execution begins.

The shared task boundary is:

- repositories that need bootstrap members wire `mr:bootstrap` into `genie:prepare`
- all Genie-backed tasks depend on `genie:prepare`

This keeps the bootstrap requirement centralized at one task boundary rather than duplicating the same megarepo prerequisite across every Genie task name.

## Design Questions

- **DQ1 Self-hydrating `#mr` imports:** Genie currently resolves existing lock-pinned member worktrees but does not materialize missing ones. A future design may move bootstrap from external task wiring into the import resolver or a dedicated preflight phase if that can be done without hiding expensive or surprising side effects.
