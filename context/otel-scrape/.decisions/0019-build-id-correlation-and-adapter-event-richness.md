# 0019 — build-id trace correlation (machineVersion + schemaUrl) and adapter-event richness

Status: accepted

## Context

Two residuals kept a demanding OTel reviewer from a clean "exemplary" stamp after
M25 (see the SOTA re-critique), both cheap and both observable in fresh OTLP.

1. **No build correlation.** `scope.version` / `service.version` were the static
   crate version (`0.0.0` via `env!("CARGO_PKG_VERSION")`) — identical across
   every build, so a trace could not be tied to a build/commit — and there was no
   `schemaUrl`. Decision 0016 §6 landed the placement/gating but not a
   discriminating value.
2. **Near-noise adapter events.** The `otel_scrape.adapter.event` carried only
   `severity` + hashed filename; the oxlint rule id and the diagnostic line were
   dropped from both the OTLP event and the summary, despite being cheap and
   non-sensitive (a rule id is a public lint-rule name; a line is a plain
   integer). R27 / decision 0017 already class rule codes as public-safe.

## Evidence and Argument

- The fleet already has a shared build-versioning contract
  (`@overeng/utils/node/cli-version`: baseVersion / rev / dirty / sourceKind →
  `machineVersion` for telemetry, `displayVersion` for humans) and injects the
  flake git rev into its TS CLIs via `gitRev`/`commitTs`/`dirty`. otel-scrape is
  Rust, but the _contract_, the `CLI_BUILD_STAMP` env var, and the NixStamp shape
  transfer verbatim; only the reader is new.
- The rev is a flake input (`self.sourceInfo`), not an impure read, so baking it
  into the build env preserves Nix purity; rustc records the `option_env!` read as
  a build dependency, so a new rev rebuilds the crate and the binary tracks its
  build. Verified end-to-end: a `nix build .#otel-scrape` from a dirty tree emits
  `scope.version` = `service.version` = `0.0.0+70090b9-dirty` (the real short rev),
  with `schemaUrl` on both the ResourceSpans and ScopeSpans, and the oxlint event
  carrying `otel_scrape.adapter.rule=eslint(no-debugger)` + `otel_scrape.adapter.line=2`
  while the filename stays hashed and no raw path/message appears in either sink.
- rule/line are byte-safe under the existing non-leak invariant: a public rule
  name and an integer add no path or source text, so the hashed-filename discipline
  is untouched (proved by an extended byte-level test).

## Options

| Option                                                                                                                             | Tradeoffs                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bespoke version string in the binary                                                                                               | Rejected: forks the fleet contract — the exact anti-pattern the build-versioning skill warns against; a trace could not be compared across tools.                                      |
| Reuse the shared shell `cliBuildStamp` helper                                                                                      | Rejected: it only produces LocalStamps (dev-shell identity), not the NixStamp a shipped binary needs, so it cannot bake the flake rev into the build.                                  |
| Reuse the contract; construct the NixStamp inline via `builtins.toJSON` (as notion-cli does) and read it in Rust via `option_env!` | Chosen: same contract/env-var/shape as the fleet; the only local constraint is that the shell helper is not reused (build-versioning skill's "when reuse is not yet possible" clause). |

## Decision

### Build-id correlation

- `scope.version` and the default `service.version` are otel-scrape's
  **`machineVersion`**: NixStamp → `<version>+<rev>[-dirty]`, LocalStamp →
  `<base>+local.<rev>[.dirty]`.
- The flake passes its git rev (`dirtyShortRev`/`shortRev`/`rev`), `commitTs`, and
  `dirty` into the otel-scrape build (`flake.nix` → `nix/build.nix`), which builds
  a NixStamp JSON with `builtins.toJSON` and exposes it as the `CLI_BUILD_STAMP`
  build-env var.
- Rust reads it at compile time (`option_env!("CLI_BUILD_STAMP")`) and resolves
  `machineVersion` with the fleet precedence: a compile-time **NixStamp** (the
  binary's own build) wins; else a runtime `CLI_BUILD_STAMP` (a devenv-shell
  LocalStamp, or a NixStamp) is honored; else the fallback. A compile-time
  _LocalStamp_ — captured when the crate is built inside a devenv shell — is
  deliberately **not** honored as the binary's identity (it describes the shell).
- **Fallback marks a dev build**: with no honored stamp, `machineVersion` is
  `<baseVersion>+dev`, never bare `<baseVersion>`. A deliberate local divergence
  from the TS `package` sourceKind (which returns the bare base): otel-scrape has
  no package-registry distribution, so a stampless build is always a local dev
  build, and a bare `0.0.0` discriminates no build. Version resolution never fails.
- **`schemaUrl`** (`https://opentelemetry.io/schemas/1.37.0`, the targeted semconv
  version) is emitted on both the OTLP ResourceSpans and the ScopeSpans.
- `telemetry.sdk.version` stays the crate version (`0.0.0`): it names the
  instrumentation SDK, not the build. Only `scope.version` / `service.version`
  carry the build identity.

### Adapter-event richness

- The `otel_scrape.adapter.event` and the summary adapter record now carry
  **`otel_scrape.adapter.rule`** (the linter code emitted verbatim, e.g.
  `eslint(no-debugger)`; bounded cardinality) and **`otel_scrape.adapter.line`**
  (the 1-based diagnostic line; a plain int). Both public-safe under R27 /
  decision 0017: a public rule name and an integer — never source text or a path.
- The filename stays **hashed** (`source.filename_hash`) at every sink.
- The four adapter-event attribute keys (`severity`, `source.filename_hash`,
  `otel_scrape.adapter.rule`, `otel_scrape.adapter.line`) are now registered in
  `telemetry-registry.json` and emitted via generated constants, closing the SSOT
  gap where the two pre-existing keys were inline literals.

## Consequences

- A trace now correlates to a build/commit from the OTLP alone (scope.version +
  schemaUrl), and adapter events name the rule and location a consumer needs —
  the two remaining reviewer residuals are closed.
- Every commit produces a distinct otel-scrape build hash (the rev is baked into
  the compile env). Inherent to build-id injection; matches the fleet's TS CLIs.
- The experimental ptrace backend's ms-quantized timing and the exact-mode
  double-count remain out of scope (deferred, unchanged).
