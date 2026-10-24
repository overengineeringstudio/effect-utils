# Build Versioning Contract

This document specifies generic component identity. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

Defines component fields, machine/display output, and closure-revision semantics.
Consumer profiles select a stamp policy and own deployment/fleet extensions.

The target is consistency across modalities:

- CLI `--version`
- TUI / UI About, footer, and debug surfaces
- logs and diagnostics
- telemetry such as `service.version`
- generated build metadata

Where possible, reuse shared code instead of reimplementing version parsing or formatting per system. This is intentionally cross-language and should cover TypeScript, Rust, and future languages we use.

## Component Contract (BUILD.ID-R01–R03)

- One build identity model across tools and systems
- One cross-language contract, even when helpers differ by language
- One stable machine-readable version for exact comparison and telemetry
- One human-readable display version for interactive surfaces
- Shared semantics for local source runs, clean Nix builds, and dirty/impure builds
- Minimal drift between package metadata, runtime output, and observability

## Canonical Fields

Every implementation should model the same underlying fields, even if the transport differs:

| Field         | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `baseVersion` | Product/package version, usually from `package.json`, Cargo metadata, or equivalent manifest |
| `rev`         | Short VCS revision identifying the selected source closure; the policy below defines C       |
| `dirty`       | Whether uncommitted changes were present in the built or running source                      |
| `sourceKind`  | How the process is running, currently `local` or `nix`                                       |
| `commitTs`    | Commit timestamp of the selected revision, when available                                    |
| `buildTs`     | Optional wall-clock build or local run-start timestamp                                       |

The current TypeScript/Nix implementation represents these as:

- `LocalStamp`: `type`, `rev`, `ts`, `dirty`, optional `commitTs`
- `NixStamp`: `type`, `version`, `rev`, `commitTs`, `dirty`, optional `buildTs`

Field names may vary slightly between implementations, but the semantics should stay aligned.

For local stamps, `ts` is the run-start Unix timestamp and resolves to `buildTs`.
`commitTs`, when available, is the Unix timestamp read with
`git log -1 --format=%ct` against the same captured HEAD revision used for `rev`.
If that Git lookup fails, omit `commitTs`; never substitute the run-start time.
Readers continue to accept older local stamps without `commitTs`.

## Derived Outputs

### `machineVersion`

Use for telemetry, APIs, logs, and exact diagnostics. This must be stable and parseable.

Examples:

- `0.1.0`
- `0.1.0+7d5211e`
- `0.1.0+7d5211e-dirty`

Rules:

- No relative time
- No prose such as `running from local source`
- Include enough build identity to distinguish commits and dirty builds

### `displayVersion`

Use for CLI `--version`, About/debug/footer surfaces, and user-facing diagnostics.

Examples:

- `0.1.0+7d5211e — committed 4 days ago`
- `0.1.0+7d5211e-dirty — committed 4 days ago, with uncommitted changes`
- `0.1.0 — running from local source (7d5211e, 5 min ago)`

Rules:

- May include relative time and explanatory prose
- Should be derived from the same underlying fields as `machineVersion`
- Must not be the only available version form in systems that need stable machine-readable identity
- Local source prose prefers `committed X ago` when `commitTs` is available, so
  the displayed age describes the revision rather than process uptime. Without
  it, retain the legacy local run-age prose. Neither timestamp changes
  `machineVersion`.

### Human short and details forms

```text
canonical build identity -> @overeng/utils/build-identity
                        -> short status text + structured detail lines
                        -> @overeng/devbar/build-identity (optional presentation)
```

Traces: BUILD.ID-R01–R03. `@overeng/utils/build-identity` is the single source
for human short/details formatting in TypeScript/JavaScript. It is browser-safe,
dependency-free checked JavaScript, so Node-loaded Vite configurations and browser
surfaces share it without requiring TypeScript stripping in `node_modules`.
Hosts pass the identity exposed by `virtual:build-identity` directly; no host
revision truncation, dirty suffix, age buckets, or detail-string assembly belongs
outside the shared formatter.

```ts
interface BuildIdentity {
  readonly displayVersion: string
  readonly machineVersion: string
  readonly dirty: boolean
  readonly rev?: string
  readonly commitTs?: number
  readonly buildTs?: number
}
interface BuildIdentityDetail {
  readonly label: 'displayVersion' | 'machineVersion' | 'deployed'
  readonly value: string
}
declare const formatBuildIdentityShort: (options: {
  readonly identity: BuildIdentity
  readonly now: number
}) => string
declare const formatBuildIdentityDetails: (options: {
  readonly identity: BuildIdentity
  readonly now: number
}) => readonly BuildIdentityDetail[]
declare const formatRelativeTime: (options: {
  readonly ts: number
  readonly now: number
  readonly format?: 'short' | 'long'
}) => string
```

All timestamps and `now` are Unix seconds. The short form is the first seven
revision characters, `*` iff dirty, a middle-dot separator, and compact commit
age: `a7647bb · 3h` or `a7647bb* · 2d`. An absent or empty revision is `n/a`.
An absent commit timestamp is `n/a`, never replaced by build/deploy time:
`a7647bb* · n/a`; with both absent, `n/a* · n/a` for a dirty identity.

Details preserve the supplied `displayVersion` and `machineVersion` as separate
label/value lines. If and only if `buildTs` is supplied, they add the `deployed`
line with compact age plus `ago` (`deployed 12m ago` when rendered). A reproducible
commit timestamp is not evidence of deployment time. Invalid non-finite times
render `n/a`; future clock skew is clamped to zero elapsed seconds.

| Compact bucket | Elapsed range        | Unit length |
| -------------- | -------------------- | ----------- |
| `s`            | less than 60 seconds | 1 second    |
| `m`            | less than 60 minutes | 60 seconds  |
| `h`            | less than 24 hours   | 60 minutes  |
| `d`            | less than 30 days    | 24 hours    |
| `mo`           | less than 365 days   | 30 days     |
| `y`            | 365 days or more     | 365 days    |

Bucket values are floored. The default `formatRelativeTime` form is compact.
Its `long` mode preserves existing CLI prose (`just now`, minutes, hours, days,
weeks, then calendar date after thirty days), without changing CLI `--version`.
The Node CLI identity resolver imports the same checked-JavaScript implementation;
the Vite identity plugin already delegates to that resolver and has no separate
relative-time implementation.

## Available Implementations

The contract is language-agnostic. Existing implementations should be reused when they fit, but no single language owns the contract.

One existing implementation is the TypeScript/Nix path in effect-utils:

- `packages/@overeng/utils/src/node/cli-version.ts`
- `nix/workspace-tools/lib/cli-build-stamp.nix`
- `nix/devenv-modules/lib/mk-source-cli.nix`
- `nix/workspace-tools/lib/mk-bun-cli.nix`
- `nix/workspace-tools/lib/mk-pnpm-cli.nix`

That implementation currently uses:

- Placeholder in source: `__CLI_BUILD_STAMP__`
- Runtime env var for source execution: `CLI_BUILD_STAMP`

For any other language/runtime:

- keep the same canonical fields and derived outputs
- reuse the same env var or embedded JSON shape when practical
- prefer one shared helper/library per language or subsystem over per-binary formatting

For Rust binaries using `otel-bootstrap`, capture `option_env!("CLI_BUILD_STAMP")`
in the **binary crate** and pass it to `build_identity_from_env` and telemetry's
`embedded_build_stamp`. Buck compiles shared libraries separately from product
stamps; reading `option_env!` inside the helper crate loses the Nix revision.

### Swift runtime and portable conformance

```text
canonical bundle fields -> BuildStamp -> machine/display -> BuildIdentity
CLI_BUILD_STAMP JSON ----> CLIStamp -> resolveCLI --------> BuildIdentity
                                                           |
                                                     short/details
```

`swift/OverengKit` supplies the `BuildIdentity` SwiftPM product for macOS 13+
and iOS 16+. `BuildStamp` models the canonical fields and derives the examples
above: a seven-character revision, `-dirty` when dirty, commit-age display
when available and legacy run-age fallback for a local stamp. No timestamp
affects machine identity. `BuildIdentity` holds already-resolved machine and
display strings; human formatting preserves them verbatim, including consumer
wording, while deriving short/details from the same revision/time fields.

`BundleBuildIdentityProvider` reads canonical fields from the generic
`BuildIdentity` Info.plist key (a caller may select another key). Missing or
malformed data is an explicit `unstamped` state, not a fabricated version
from bundle ordinals. Resolve once at the composition root and inject
`BuildIdentityProviding`. The runtime does not choose a closure revision or
infer deployment time: stamp producers own those decisions.

The `CLIStamp` adapter accepts the existing local/Nix transport without
changing its established language-independent wire behavior:

| Transport      | Machine output                  | Display time                                  |
| -------------- | ------------------------------- | --------------------------------------------- |
| local          | `baseVersion+local.rev[.dirty]` | run age, or committed age when supplied       |
| nix            | `version+rev[-dirty]`           | build age when supplied, otherwise commit age |
| no valid stamp | `baseVersion`                   | no invented age                               |

The adapter retains the supplied CLI revision rather than truncating it and
does not duplicate an existing Nix `-dirty` suffix. Embedded Nix metadata wins
over runtime `CLI_BUILD_STAMP`; runtime local/Nix metadata wins over the package
fallback. An embedded local stamp alone is not a runtime stamp. These legacy
CLI transport renderings are distinct from canonical bundle-field examples;
short status text always uses the shared seven-character presentation rule.

The contract owns
[`identity.json`](../../../swift/OverengKit/Tests/OverengKitTests/Goldens/identity.json).
Swift XCTest reads that authority; TypeScript's
`build-identity-goldens.unit.test.ts` imports its package-local
`src/fixtures/build-identity-goldens.json`. The adjacent `.json.genie.ts`
projects the authority byte-identically so Buck inputs remain package-local.
The authoring file records provenance; the data carries no generator metadata.
Regenerate with `devenv tasks run genie:run`; `genie:check` owns freshness.
Edit only the authority. Both consumers cover canonical examples, compact/long
age buckets, supplied-string preservation, deployment details and CLI precedence.
Swift additionally covers explicit unstamped states, missing/empty revisions,
non-finite timestamps, clock skew and the calendar-date long-time branch.
The calendar-date branch intentionally uses the host time zone, matching the
existing TypeScript formatter; portable goldens do not pin a host calendar day.

Run `swift test --package-path swift/OverengKit` on macOS or
`bash swift/OverengKit/test.sh ios 'platform=iOS Simulator,id=<device-UDID>'`
on an available iOS simulator. Both execute the same bundled corpus.

## Modality Rules

### CLI

- `--version` should print `displayVersion`
- The CLI runtime should also have access to `machineVersion` when needed for structured diagnostics
- Prefer shared helpers instead of per-tool string assembly
- Match the same outputs and semantics even if the helper implementation differs by language/runtime

### UI / TUI

- About/debug/footer surfaces should display the same underlying build identity as the CLI
- Prefer sharing the underlying version payload or formatter logic
- Space-constrained UIs may abbreviate, but should not change semantics
- If the UI is backed by a service in another language, the same contract still applies

### Telemetry

- `service.version` and similar attributes should use `machineVersion`
- Do not emit prose or relative time into telemetry version fields
- If useful, emit commit, dirty, and source-kind as separate attributes in addition to `service.version`

### Logs And Errors

- Human-facing logs may include `displayVersion`
- Structured logs should include `machineVersion`
- Error suffixes should be derived from the same version source as `--version`

## Migration Targets

Move touched code toward these standards:

1. Replace `__CLI_VERSION__` with `__CLI_BUILD_STAMP__`
2. Replace `NIX_CLI_BUILD_STAMP` with `CLI_BUILD_STAMP`
3. Replace hardcoded version strings with shared helpers where possible
4. Replace separate CLI/UI/telemetry version literals with one shared source
5. Prefer shared library changes over one-off fixes when multiple systems need the same behavior
6. Introduce one reusable helper crate/module/library before adding the second bespoke implementation in a language/runtime

## Cross-Language Constraints

Not every language or system can reuse the TypeScript helper directly. In those cases:

- Keep the canonical fields and semantics
- Match the same `machineVersion` and `displayVersion` rules
- Prefer adding a shared helper in the relevant common library, crate, or module rather than duplicating logic repeatedly
- Document any local constraint briefly in the touched code or docs when reuse is not yet practical

## Anti-Patterns

- Version strings assembled ad hoc in every binary
- Separate env vars for the same build stamp concept
- Relative-time or prose values stored as `service.version`
- UI and CLI disagreeing about what build is running
- Repeated literal version strings across one system
- Repeating the same formatter separately in multiple binaries within one language/runtime or across mixed-language systems

## Independent Identities (BUILD.ID-R04)

| Identity                    | Meaning                                    | Must not substitute for      |
| --------------------------- | ------------------------------------------ | ---------------------------- |
| Component source revision   | Git provenance of a product source closure | Action key or payload digest |
| Action key                  | All result-affecting configured inputs     | Deployment identity          |
| Payload digest              | Exact portable bytes                       | Source revision              |
| Nix closure identity        | Exact store path / NAR hash                | Human version                |
| Deployment identity         | Consumer-owned realized bill of materials  | Product stamp or action salt |
| Invocation / trace identity | One observed execution                     | Build/product identity       |

A shipped component emits a real, non-zero machine version. Consumers add exact
closure and deployment identity separately; these never replace the component
version or enter an unrelated product's action key.

## C: Closure-Revision Policy (BUILD.ID-R05–R07)

```text
authored product closure -> committed rev projection -> freshness gate
                                                -> product stamp input
PR source changes -> generated refresh commit -> ancestry-preserving merge
```

C stamps each product with the last Git commit that touched its own declared
source closure. The committed projection binds product target, source paths,
full revision and commit timestamp. Source paths include transitive workspace
sources and explicitly declared non-workspace inputs; the projection is
generated from authored intent, never a hand-maintained second closure.

An unrelated repository commit does not change the product rev. A relevant
closure change changes it. `commitTs` is the selected commit's timestamp, not
the refresh or merge timestamp; `buildTs` remains intentionally impure and
optional. `dirty` records uncommitted closure changes, not unrelated checkout
noise. A source revision is provenance, not a claim that dependency pins or
toolchain changes produce identical bytes.

A profile selecting C refreshes product revs with a generated **refresh product
revs** commit inside every PR that changes a product closure. A freshness gate
recomputes the projection and rejects stale data before merge or production.
The projection excludes its own generated refresh-only changes when computing
last-touch history; otherwise refreshing would recursively invalidate itself.

Landing must preserve every stamped commit in reachable repository ancestry.
A merge commit preserves the source and refresh commits. Squash or rewriting a
stamped commit is forbidden unless stamps are regenerated and freshness proved
against the final preserved ancestry before landing. CI owns the concrete merge
policy; the identity contract owns this invariant. The private profile selects
C, rather than requiring every external consumer to select it.

Decisions: axe records `nz2ibq` and `75iddd`. Stamp consumption is specified in
[the Nix bridge](../05-product-distribution/02-nix-bridge/spec.md#consumer-from-source-identity).
