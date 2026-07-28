# Pattern: cli-contract

**Area:** CLI  **Kind:** semantic  **Our usage:** 53 `@effect/cli` imports across operator-facing
CLIs including `megarepo`, `notion-cli`, `genie`, `ci-tools`, `npm-release`, and TUI packages.

## v3

```ts
import { Args, Command, Options } from "@effect/cli"

const command = Command.make("deploy", {
  target: Args.text({ name: "target" }),
  mode: Options.choice("mode", ["fast", "safe"])
}, handler)

const program = Command.run(command, { name: "tool", version: "1.2.3" })(process.argv)
```

## v4

```ts
import { Argument, Command, Flag } from "effect/unstable/cli"

const command = Command.make("deploy", {
  target: Argument.string("target"),
  mode: Flag.choice("mode", ["fast", "safe"])
}, handler)

const program = Command.runWith(command, { version: "1.2.3" })(process.argv.slice(2))
```

## Equivalence

```sh
bun run run cli-contract
```

The pattern launches each CLI in a child process and compares exact stdout bytes, exact stderr
bytes, and exit status for help, version, valid parsing, terminators, repeated flags, negative
numbers, clustered short flags, Unicode, excess positional arguments, and four validation errors.
This is a reusable snapshot gate: any unallowlisted text or exit-code change makes the runner
fail.

Result against beta.102: **ALLOWLISTED, 34 exact diff paths, 0 unexpected**. Every path is
classified below as
`A` suspected v4 bug, `B` consciously accepted v4 grammar improvement, or `C` real breakage that
requires compatibility rendering/shimming. The allowlist freezes the characterization; it does
not turn category A or C into accepted migration behavior.

Observed changes:

| Bucket | Cases | Exact paths | Decision |
| --- | --- | --- | --- |
| A: suspected v4 bug | `--` under nested subcommands, with variadic or required child positional | `$[5].stdout`, `$[12].{exitCode,stderr,stdout}` | Report upstream; do not migrate affected commands until fixed or locally patched |
| B: accept improvement | reject separated negative integers | `$[6].{exitCode,stderr,stdout}`, `$[13].{exitCode,stderr,stdout}` | Accept for current domain integers: counts, delays, widths, timestamps, concurrency, limits, and PR numbers |
| B: accept improvement | clustered aliases (`-vq`) | `$[7].stdout`, `$[14].{exitCode,stderr,stdout}` | Accept standard clustered-short grammar |
| B: accept improvement | equals-form repeated flags | `$[4].stdout`, `$[15].{exitCode,stderr,stdout}` | Accept standard `--flag=value` grammar |
| B: accept improvement | strict unknown flag after a variadic positional | `$[9].{exitCode,stderr,stdout}` | Accept; no tracked effect-utils command uses variadic positional `Args` |
| C: preserve or shim | root/nested help and version bytes | `$[0].stdout`, `$[1].stdout`, `$[2].stdout` | Preserve/rebaseline per CLI owner; exact stdout is a public contract |
| C: preserve or shim | validation diagnostics and stdout placement | `$[8].{stderr,stdout}`, `$[10].{stderr,stdout}`, `$[11].{stderr,stdout}`, `$[16].{stderr,stdout}` | Keep validation failures off machine-readable stdout; compatibility-format or explicitly rebaseline stderr |

### Category A source confirmation

The v4 lexer correctly stores everything after `--` in `trailingOperands`
(`effect/src/unstable/cli/internal/lexer.ts:24-40`). The recursive parser then constructs the
child input with `trailingOperands: []` (`internal/parser.ts:87`) and puts the original trailing
operands on the parent parse record (`internal/parser.ts:97`). A nested child therefore never
sees them. The probe confirms both data loss after an already-satisfied positional and a false
missing-required failure when the escaped positional is the required child argument.

### Actual effect-utils command audit

| Behavior | Commands with observable exposure | Evidence and impact |
| --- | --- | --- |
| help bytes | all six audited binaries | `megarepo/src/cli/mod.ts:51-80`, `notion-cli/src/cli.ts:63-80`, `genie/bin/genie.tsx:29-44`, `ci-tools/bin/ci-tools.ts:25-39`, `npm-release/src/cli.ts:58-84`, `tui-stories/bin/tui-stories.tsx:20-31`; Nix smoke tests execute help for `megarepo`, `notion-cli`, `ci-tools`, and `npm-release` but mostly assert success/presence, not bytes |
| version bytes | `megarepo`, `genie`, `ci-tools`, `npm-release`, `tui-stories` | all delegate `--version` to Effect CLI and would change to `name v<version>`; `notion-cli` is protected by its explicit one-line root-version fast path at `notion-cli/src/cli.ts:33-38,173-180` |
| nested `--` data loss | `megarepo`, `notion-cli`, `tui-stories` positional subcommands | required positionals exist at `megarepo/src/cli/commands/{add.ts:58-63,exec.ts:23-29,pin.ts:59-63}`, `notion-cli/src/commands/{db/mod.ts:29-35,schema/mod.ts:84-87}`, and `tui-stories/src/cli/{render.ts:14-17,inspect.ts:13-16}`; a dash-prefixed value supplied via `--` becomes missing |
| negative integers | `npm-release`, `ci-tools`, `tui-stories`, plus Notion/TUI helpers | concrete flags: `npm-release` attempts/delay, `ci-tools` PR number, `tui-stories` width/timeline `at`; workspace-wide integer search also finds Notion poll/concurrency/limit and TUI example durations |
| clustered aliases | `megarepo`, `notion-cli`, `tui-stories` | these own multiple short aliases; formerly-invalid clusters can now invoke handlers. `genie`, `ci-tools`, and `npm-release` define no command aliases in the audited sources |
| equals repeated flags | `ci-tools`, `tui-stories` | v4 newly accepts equals form for `ci-tools` production-domain/build-env and `tui-stories --arg`; existing separate-form invocations are unchanged |
| unknown flags | every command | tracked commands have no variadic positional `Args`, so exit remains 1; the real change is v4 full help on stdout plus new stderr wording |

`megarepo`'s `rewriteHelpSubcommand(process.argv)` does not mitigate the terminator bug. It returns
non-`help` argv unchanged (`utils/src/node/cli-help-rewrite.ts:2-8`), so
`mr add -- -dash-prefixed-repo` still reaches the broken v4 parser. For the custom
`mr help add` form it appends `--help`; if the input itself contains `--`, the appended help flag
lands after the terminator and is among the operands stranded on the parent. Normal
`mr help add` remains a straightforward rewrite to `mr add --help`.

## Intended differences (alignment register entries)

- **A:** escalate nested-subcommand terminator loss upstream and block affected migration slices
  on an upstream fix or explicit local patch.
- **B:** accept negative-integer rejection, clustered aliases, equals-form repeated flags, and
  strict unknown-flag handling for the unused variadic-positional shape.
- **C:** preserve or explicitly rebaseline help/version/error bytes. Independently of wording,
  validation help must not be added to stdout for commands whose success output is JSON/NDJSON.

The fresh beta.102 classification count is **A: 4 paths, B: 17 paths, C: 13 paths**. No existing
path changed bucket from beta.99. Two existing category-C stderr values improved wording:
invalid-choice and invalid-integer errors no longer duplicate `Expected`. Commit `c917bb94a`
(#6561) adds excess-positional rejection; the new gate case shows both v3 and beta.102 exit `1`,
so it restores v3 semantics rather than introducing a new exit-code break. Its diagnostic bytes
and help-on-stdout behavior add two category-C paths.

## Gotchas

- v4 `Command.run` reads arguments from the `Stdio` service. The v3-compatible explicit-argv
  runner is `Command.runWith`; keeping the old name changes behavior without a type-level cue.
- v4 accepts arguments and flags in the `Command.make` config record, using `Argument` and `Flag`.
- Help text, validation text, stdout/stderr placement, and process status are external contracts,
  not implementation details.
- `process.argv` includes the runtime and script on v3; the explicit v4 `runWith` input is the
  already-trimmed CLI argument array.
- `NO_COLOR=1` did not remove v3 ANSI help bytes in this probe. A gate that strips ANSI would hide
  a real output-contract change.
- Variadic arguments interact with flag recognition differently across majors. Test flags both
  before and after positional operands.
- The `--` loss is not a formatter issue or an expected parser redesign; it is source-confirmed
  child-recursion data loss in beta.99 and still reproduces on beta.102. The intervening
  positional-overflow fix (`c917bb94a`, #6561) changed leftover validation in
  `internal/command.ts` but did not touch the faulty `internal/parser.ts` recursion.
- v4 help-on-error is intentional library control flow: `showHelp` logs the full help document to
  stdout before logging validation errors to stderr
  (`effect/src/unstable/cli/Command.ts:2157-2169`). It is category C compatibility work, not an
  upstream parser bug.
- Interactive `Prompt.select` behavior is **NOT COVERED**. The repo has a live use in
  `megarepo/src/cli/commands/engine.ts`; it needs a deterministic scripted-Terminal or PTY gate
  before that command is migrated.

## Codemod rule

No general codemod. Import and identifier renames are mechanical, but runner selection, argument
shape, repetition semantics, and byte-level CLI output require a per-command snapshot gate.
