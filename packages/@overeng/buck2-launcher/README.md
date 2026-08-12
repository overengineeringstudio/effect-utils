# buck2-launcher

`buck2-launcher` is a thin, bypassable execution and evidence boundary for an
already-realized Buck2 binary. It does not evaluate Nix or devenv and owns no
target, dependency, or task graph.

```sh
bun packages/@overeng/buck2-launcher/src/cli.ts \
  --buck /nix/store/...-buck2/bin/buck2 \
  --buck-version 2026-04-14-7600cb8 \
  --closure-manifest //packages/app:check=.buck2/closures/app-check.json \
  --print-command \
  -- build //packages/app:check
```

Everything after `--` is passed to Buck unchanged. `--print-command` shows the
unwrapped command, and callers can always invoke that command directly. The
launcher adds only Buck's event-log, build-report, artifact-hash, and build-id
flags. Supplying those flags yourself is rejected because it would make the
receipt ambiguous; bypass the launcher when custom evidence ownership is needed.
The receipt lane accepts `build`, `test`, `run`, and `install`; other Buck
commands do not expose the required build-report contract and must be run
directly.

Automation can pass `--run-id SAFE_COMPONENT` with `--evidence-dir DIR` and
read the receipt at `DIR/SAFE_COMPONENT/receipt.json`. The launcher validates
the run ID before constructing the directory, so callers do not need to parse
human-oriented stderr or discover private state paths.

## Receipt

Each run writes a mode-0600 `buck-run-receipt/v1` beneath
`$XDG_STATE_HOME/overeng/buck2-launcher` (or `~/.local/state`). The receipt is a
small index, not a replacement for Buck's event log or build report. It contains
content descriptors rather than absolute evidence paths and never copies raw
argv, action commands, environments, reproducers, or Buck's absolute
`project_root`.

Outcomes deliberately distinguish:

- same-daemon DICE reuse (`dice_reuse`);
- local and remote cache hits;
- local and remote cache misses;
- local and remote execution;
- output-only materialization;
- failure, cancellation, and unknown evidence.

`dice_reuse` is emitted only when `--compare-receipt` supplies a prior receipt,
the requested output digests are unchanged, and Buck reports neither an action
nor materialization. Without that control the outcome stays `unknown`; zero
actions is not silently relabeled as a cache hit or DICE reuse.

An execution or cache miss alone does not explain invalidation. Repeating
`--closure-manifest LABEL=PATH` joins canonical exact-closure digests to the
receipt. `--compare-receipt` proves changes in that external-closure dimension;
other causes remain `partial` or `unknown` until their own canonical manifests
are supplied.

Closure inputs must be generated Buck projection descriptors using schema v1
(`closure.task.label`) or v2 (`closure.request.label`). The versioned label must
match `LABEL`, and provenance must name `effect-utils/genie/buck2`. Duplicate
labels, malformed descriptors, and label mismatches fail before Buck executes.
The receipt hashes validated canonical JSON, so whitespace and object-key order
do not change closure identity.

Explicit run IDs are single-use. The launcher creates each receipt directory
exclusively and fails before invoking Buck if that directory already exists.

`observation.verdict` is `complete` only when the build report and event log are
present, both `buck2 log` queries exit successfully, and every nonblank query
record parses against the supported shape. Missing, malformed, failed, or
newer/unsupported evidence produces `incomplete`, an `unknown` outcome, and no
invalidation verdict. Partial output must never become evidence for DICE reuse.

## OpenTelemetry contract

`src/buck2-launcher.contract.ts` is a schema foundation for future OTEL emission;
the launcher does **not** export OTLP at runtime yet. Its current runtime
observability boundary is the structured receipt plus retained Buck evidence. Targets,
invocation IDs, and digests are high-cardinality trace fields and are forbidden
as metric labels. The bounded `buck.execution.outcome` metric label preserves
DICE/cache/execution distinctions for the future exporter. That exporter must
carry the runtime `span.label` required by `@overeng/otel-contract`.

## Repository integration

Genie owns this package's manifest and TypeScript project registration. Nix
builds the launcher with the repository-pinned Buck binary, and devenv exposes
the local-only foundation and package E2E tasks. The package E2E retains Buck's
raw report/log beside the receipt and independently checks the provisional
input-evidence descriptor and payload digest. It deliberately reports
`admission=not-attempted`; the separate Nix bridge gate exercises the hardened
product importer, and this synthetic input-plan fixture is not an admitted
build product. Remote cache access and remote execution remain disabled until
the admission gates in the Buck2 evidence spec are satisfied.
