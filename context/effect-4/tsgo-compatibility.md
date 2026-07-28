# tsgo probe findings

Identity: `org.schickling.eu.effect-4.tsgo`

## Verdict

VERIFIED: the current Nix-pinned `effect-tsgo` is sufficient for the Effect 4 migration blocker.

| Question                                                   | Answer               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current pin handles `effect@4.0.0-beta.102` module layout? | Yes                  | Probe dependency is `effect` `4.0.0-beta.102`; package exports include `effect/testing`, `effect/unstable/cli`, `effect/unstable/http`, `effect/unstable/httpapi`, `effect/unstable/observability`, `effect/unstable/process`, `effect/unstable/rpc`, plus wildcard root subpaths such as `effect/Schema` and `effect/Result`. See `tmp/tsgo-probe/q1/node_modules/effect/package.json:2-4`, `:29-55`; probe imports at `tmp/tsgo-probe/q1/src/index.ts:1-10`. |
| Current pin emits Effect diagnostics under v4?             | Yes                  | Hardened probe emitted warning, suggestion, and error diagnostics under `effect@4.0.0-beta.102`; see command/output below.                                                                                                                                                                                                                                                                                                                                     |
| Gate degraded to errors-only?                              | No                   | Warning-only and suggestion-only category probes each exited `2`, proving both categories still affect `tsgo --build` exit code when the repo-equivalent ignore flags are `false`.                                                                                                                                                                                                                                                                             |
| Minimum viable tsgo revision                               | Current pin suffices | Locked rev remains viable: `flake.lock:98-104` pins `Effect-TS/tsgo` `8d34c0a2d603a4b963b85ffccd4322c0ef74f472`; evaluated current attr was `/nix/store/m59qqc61pdii7xfjnpfzjas5fx0z2ggx-effect-tsgo`, version `7.0.0-dev+effect-tsgo.0.14.5`.                                                                                                                                                                                                                 |
| Effect 3 advisory delta from newer tsgo                    | NOT MEASURED         | De-scoped by orchestrator after Q1: since current pin works, a tsgo bump is not on the Effect 4 critical path. No candidate tsgo build and no whole-repo Effect 3 typecheck were run.                                                                                                                                                                                                                                                                          |

## Probe Setup

VERIFIED: the probe is throwaway and outside tracked files (`tmp/tsgo-probe/q1`). `git status --short` had no tracked changes.

`tmp/tsgo-probe/q1/tsconfig.json:26-40` mirrors the repo's Effect language-service plugin shape:

```json
{
  "name": "@effect/language-service",
  "ignoreEffectWarningsInTscExitCode": false,
  "ignoreEffectSuggestionsInTscExitCode": false,
  "ignoreEffectErrorsInTscExitCode": false,
  "includeSuggestionsInTsc": true,
  "pipeableMinArgCount": 2,
  "diagnosticSeverity": {
    "missedPipeableOpportunity": "warning",
    "schemaUnionOfLiterals": "warning",
    "anyUnknownInErrorContext": "warning",
    "preferSchemaOverJson": "warning"
  }
}
```

Repo source evidence for the same derived config:

| File                                                                |        Lines | Meaning                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | -----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `genie/external.ts`                                                 | 736, 772-775 | `effectDiagnosticsGate = { warnings: true, suggestions: true }`; the generated ignore flags are `!effectDiagnosticsGate.*`, so both warning and suggestion ignore flags derive to `false`; errors ignore flag is hardcoded `false`.              |
| `tmp/tsgo-probe/tsgo-source/internal/effectconfigraw/hooks.go`      |        76-83 | tsgo reads `ignoreEffectSuggestionsInTscExitCode`, `ignoreEffectWarningsInTscExitCode`, and `ignoreEffectErrorsInTscExitCode` from the plugin entry when present.                                                                                |
| `tmp/tsgo-probe/tsgo-source/testdata/baselines/reference/README.md` |      214-231 | tsgo docs: `includeSuggestionsInTsc` controls suggestion visibility; `ignoreEffectSuggestionsInTscExitCode`, `ignoreEffectWarningsInTscExitCode`, and `ignoreEffectErrorsInTscExitCode` control whether each category affects the tsc exit code. |

## Q1 Commands And Output

Pinned compiler:

```sh
nix eval --raw .#packages.$(nix eval --impure --raw --expr builtins.currentSystem).effect-tsgo.outPath
# /nix/store/m59qqc61pdii7xfjnpfzjas5fx0z2ggx-effect-tsgo

/nix/store/m59qqc61pdii7xfjnpfzjas5fx0z2ggx-effect-tsgo/bin/tsgo --version
# Version 7.0.0-dev+effect-tsgo.0.14.5
```

Hardened module-layout + all-category diagnostic probe:

```sh
/nix/store/m59qqc61pdii7xfjnpfzjas5fx0z2ggx-effect-tsgo/bin/tsgo --build tsconfig.json --force --pretty false
# exit=2
# src/index.ts(38,14): warning TS377030: This has unknown in the requirements channel which is not recommended.
# Only service identifiers should appear in the requirements channel. effect(anyUnknownInErrorContext)
# src/index.ts(38,35): suggestion TS377017: This Effect.gen contains a single return statement. effect(unnecessaryEffectGen)
# src/index.ts(39,10): warning TS377030: This has unknown in the requirements channel which is not recommended.
# Only service identifiers should appear in the requirements channel. effect(anyUnknownInErrorContext)
# src/index.ts(48,1): error TS377001: This Effect value is neither yielded nor used in an assignment. effect(floatingEffect)
```

Category-isolated gate probes:

```sh
/nix/store/m59qqc61pdii7xfjnpfzjas5fx0z2ggx-effect-tsgo/bin/tsgo --build tsconfig.warning.json --force --pretty false
# exit=2
# src/warning.ts(4,14): warning TS377030: This has unknown in the requirements channel which is not recommended.
# Only service identifiers should appear in the requirements channel. effect(anyUnknownInErrorContext)
# src/warning.ts(5,10): warning TS377030: This has unknown in the requirements channel which is not recommended.
# Only service identifiers should appear in the requirements channel. effect(anyUnknownInErrorContext)

/nix/store/m59qqc61pdii7xfjnpfzjas5fx0z2ggx-effect-tsgo/bin/tsgo --build tsconfig.suggestion.json --force --pretty false
# exit=2
# src/suggestion.ts(3,29): suggestion TS377017: This Effect.gen contains a single return statement. effect(unnecessaryEffectGen)
```

## Q4 Waiver Knobs

VERIFIED: the real relaxation knobs are the `ignoreEffect*InTscExitCode` plugin fields, not `diagnosticSeverity`.

| Desired gate                                                  | Values                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict current repo gate                                      | `ignoreEffectWarningsInTscExitCode: false`, `ignoreEffectSuggestionsInTscExitCode: false`, `ignoreEffectErrorsInTscExitCode: false`                                                                                                          |
| Errors-only waiver                                            | `ignoreEffectWarningsInTscExitCode: true`, `ignoreEffectSuggestionsInTscExitCode: true`, `ignoreEffectErrorsInTscExitCode: false`                                                                                                            |
| Keep suggestion output visible while waiving exit-code impact | Leave `includeSuggestionsInTsc: true`                                                                                                                                                                                                        |
| Source change that would produce the waiver                   | In `genie/external.ts`, set `effectDiagnosticsGate` to `{ warnings: false, suggestions: false }`; generated plugin values at `:772-775` then become `true`, `true`, `false`. Do not edit generated `package.json`/`tsconfig` files directly. |

The comment at `genie/external.ts:724-725` is misleading: it says "both fields are true" while the derived plugin fields at `genie/external.ts:772-775` are the inverse ignore flags. The current strict behavior is produced by those generated ignore fields being `false`.

## Recommendation

Land the Effect 4 flip against the existing pinned `effect-tsgo` first. A tsgo bump is optional, independent, and deferrable because the current pin resolves the v4 subpath layout and preserves error/warning/suggestion gate behavior on `effect@4.0.0-beta.102`.

Do not combine a tsgo bump with the Effect 4 flip. If a later optional tsgo bump is desired, measure it as a separate Effect 3 PR because a newer compiler may surface diagnostics unrelated to Effect 4.

Contingency if the migration branch hits a large advisory backlog: use the errors-only waiver by flipping `effectDiagnosticsGate` warnings/suggestions to `false` in `genie/external.ts`, regenerate, and keep `ignoreEffectErrorsInTscExitCode: false`.

## Not Covered

- Newer tsgo revision history since `8d34c0a`.
- Effect 3 advisory delta under newer tsgo.
- Whole-repo typecheck with newer tsgo.

These were explicitly stopped by orchestrator after Q1 made the tsgo bump non-critical.
