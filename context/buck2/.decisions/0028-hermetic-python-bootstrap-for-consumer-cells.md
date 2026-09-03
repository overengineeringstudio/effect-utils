# 0028 Hermetic Python Bootstrap For Consumer Cells

Status: accepted

## Context

Ratified by Johannes on 2026-09-03 (dotfiles Buck2 adoption epic #2319,
question q43): the hermetic, Nix-realized `python_bootstrap` toolchain is
admitted into the Buck graph for consumer cells. Ambient `python3` on PATH,
prelude's ambient system bootstrap toolchain, and every CPython build edge stay
banned.

This narrows — it does not reverse — the Python-absence invariant added with
the #1056 stack, whose gate is
`nix/devenv-modules/tasks/shared/tests/buck2-no-python-actions.test.sh`. That
gate refused _any_ Python token in the Buck graph, because at the time the only
Python term on offer was upstream's ambient `system_python_bootstrap_toolchain`
and the Python action helpers that were replaced with Rust. The invariant's
subject was never "the string python"; it was the non-hermetic, undigested
interpreter. The gate now encodes that distinction directly: one enumerated
allowlist for the Nix-realized bootstrap interpreter, and an explicit refusal
list — with a negative case per entry — for the ambient and CPython forms.

The change is forced by the consumer-cell requirement this decision serves. A
composed root whose hub is a read-only `cp -a` mount could not build anything
from a consumer cell. Two independent failures:

1. Prelude resolves conventional toolchains as `toolchains//:<name>`. The
   composition root aliases the `toolchains` cell to the platform hub, but the
   hub declared no such targets, so any member using a plain prelude rule failed
   analysis with `Unknown target 'genrule' from package '<hub>//'`.
2. `buck2/toolchains/BUCK` loads `//.buck2/capabilities:defs.bzl`, and the tool
   set that satisfied it was produced by `scripts/buck2-capability-project.sh`
   driven from the hub's own `devenv` shell. A mount has no devenv shell, and
   mr's own resolver projected a _different, smaller_ tool set (17 tools vs the
   shell's 18, neither sufficient), so hub toolchain analysis failed inside a
   composition — including mr's own overlay-build phase.

Three producers, two tool sets, two generation digests.

## Evidence and Argument

Measured on a composed scratch root (cells `workspace`/`prelude`/`effect_utils`/
`dotfiles`, hub mounted by `cp -a`, capabilities projected by mr's resolver
only, `scripts/buck2-capability-project.sh` absent from the mount):

| probe                                                                     | before                                                                  | after                        |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| `buck2 build dotfiles//gen:probe` (plain prelude `genrule`, foreign cell) | `Unknown target 'genrule' from package 'effect_utils//'`                | BUILD SUCCEEDED, 1.9 s       |
| `buck2 cquery 'deps(effect_utils//rust/third-party:adler2-2)'`            | analysis failure                                                        | 57 configured nodes, 0.77 s  |
| `buck2 targets effect_utils//buck2/toolchains:`                           | `fail: generated Buck capabilities do not contain bun for x86_64-linux` | 12 targets, 0.20 s           |
| `buck2 build dotfiles//rust:hello` (prelude `rust_binary`, foreign cell)  | —                                                                       | BUILD SUCCEEDED, runs, 2.9 s |

Two facts the plan did not have:

- **A fourth conventional toolchain is required, not three.** Prelude's Rust
  rules depend on `@prelude//rust/tools:transitive_dependency_symlinks`, a
  bootstrap-interpreter binary, so the reindeer graph needs
  `toolchains//:python_bootstrap`. Upstream's ambient bootstrap toolchain
  resolves the interpreter by bare basename off the ambient PATH — the one
  non-hermetic term the entire Rust graph would otherwise carry, and one that
  silently splits action keys between a devenv shell and a bare CI runner
  (EXEC-R02).
- **A flat `flakePackage`/`executable` on the authority cannot express the
  manifest.** Authority _kinds_ are `bun`/`pnpm`/`tsgo`; the tool ids the Buck
  rules require are `bun`/`effect-tsgo`, and `pnpm` requires no executable at
  all. A flat pair forces a rename (`tsgo` → `effect-tsgo`) plus an
  optional-field escape hatch for `pnpm` — the same kind/instance drift one
  level down.

The interpreter that lands is not merely "a Nix Python": the toolchain rule
fails analysis unless the projected capability resolves to a normalized
`/nix/store/<realization>/bin/python3` path, so the interpreter is digested by
the same capability generation as every other tool and the action key is
identical in a devenv shell and on a bare runner.

## Options

| Decision                           | Selected                                                                                                  | Alternatives rejected                                                                                                                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where conventional toolchains live | `toolchain_alias` targets in the hub's root package, reached through the existing `toolchains` cell alias | A synthetic root-cell toolchain package (contradicts "the root carries no synthetic toolchains"); per-member local toolchain packages (N instances of each toolchain, N configuration identities)                                                                                        |
| Alias rule                         | native `toolchain_alias`                                                                                  | plain `alias` — cannot front an `is_toolchain_rule = True` target, and both hub toolchains are toolchain rules                                                                                                                                                                           |
| Authority shape                    | total `provides: BuckMemberCapability[]` on `ToolchainAuthority`                                          | delete the authority tag and let requirements name tool ids (makes `pnpm` unrepresentable, lets a consumer require `rust-nm`, loses the kind→instances grouping); `flakePackage`+`executable` on the authority (forces the `tsgo`/`effect-tsgo` rename and an optional field for `pnpm`) |
| Bootstrap interpreter              | hermetic `nix_python_bootstrap_toolchain` behind a new `python-bootstrap` capability                      | prelude's ambient system bootstrap toolchain (undigested interpreter in every Rust action); wrapping every prelude Rust rule first-party (open-ended: `dist_lto` and several `prelude//cxx/tools:*` are bootstrap binaries too)                                                          |
| #1056 guard                        | narrow to an enumerated allowlist plus an explicit refusal list with per-form negative cases              | delete the guard (loses the ambient/CPython refusal that is the actual invariant); keep it total and route around it (would force the rejected first-party wrapping path)                                                                                                                |
| Projector count                    | mr's resolver is the sole producer; the shell projector and its devenv wiring are deleted                 | keep both and reconcile the tool sets (two implementations of one digest, and still no producer inside a mount)                                                                                                                                                                          |

## Decision

The platform hub owns prelude's conventional toolchain targets in its root
package: `rust`, `cxx`, and `python_bootstrap` as `toolchain_alias` onto
`//buck2/toolchains:*`, and `genrule` as prelude's own
`system_genrule_toolchain` (its only field, `zip_scrubber`, defaults to `None`,
so there is nothing to pin). The `toolchains` cell alias the composition root
already emits makes these resolve from every member cell.

The bootstrap interpreter is admitted in exactly one realization:
`nix_python_bootstrap_toolchain`, fed by the `python-bootstrap` capability, whose
`executableStorePath` must be a normalized `/nix/store/<realization>/bin/python3`.
Anything else remains refused, and the refusal is mechanical:
`buck2-no-python-actions.test.sh` enumerates the admitted spellings (the rule,
the `toolchains//:python_bootstrap` target, the capability id and its projected
`.buck2/capabilities/defs.bzl` entry, the store-path shape) and refuses every
other Python token, with a negative case per banned form — ambient system
bootstrap/wheel/remote toolchains, `python_bootstrap_binary`/`python_binary`/
`python_library`/`python_test`/`python_wheel` actions, `prelude//python:` rules,
an interpreter bound to a bare basename, `env python3`, a Python shebang, and
CPython itself.

`ToolchainAuthority` gains a required, total `provides` list of the
`BuckMemberCapability` entries that realize the kind — `bun → [bun]`,
`tsgo → [effect-tsgo]`, `python-bootstrap → [python-bootstrap]`, `pnpm → []`.
Provided tool ids share the duplicate-detection namespace with member-owned
capabilities, and the member-override refusal extends from authority kinds to
provided tool ids: a consumer can no longer shadow `effect-tsgo` just because
the kind is spelled `tsgo`.

mr's composition capability resolver becomes the sole producer of
`.buck2/capabilities`: it projects `provides` alongside member-owned
capabilities, so the same 20-tool projection lands in every read-only mount and
(via `mr apply`) in the owned member. `scripts/buck2-capability-project.sh`, its
test, and the devenv wiring that drove it are deleted; every Buck-invoking task
is ordered after `mr apply`.

Because `provides` is required and `BuckMemberManifestSchema` decodes with
`onExcessProperty: 'error'`, the schema and the hub manifest must land in one
commit, and any new member manifest must be authored against the post-change
schema.

## Consequences

- A consumer cell can use plain prelude rules (`genrule`, `rust_binary`,
  reindeer crates) against the hub's capability-backed tools. Proven for
  `genrule` and `rust_binary`; the `ProductExecutableInfo` packaging layer
  remains unproven from a consumer cell.
- The Rust action graph has no ambient-PATH term left.
- The Python-absence invariant becomes a Python-_boundary_ invariant. It is
  narrower in subject and stricter in mechanism: the previous gate was one
  regex, the current one is an enumerated allowlist with 17 refused forms each
  covered by a negative case and 3 admitted forms covered by positive cases.
- `-453` lines of build machinery (a 141-line shell projector, its 212-line
  test, 100 lines of devenv wiring) for `+217`. The resolver and the owned
  projection installer are load-bearing after the collapse, not deletable — the
  honest restatement is "three producers, two tool sets, two digests" becoming
  "one producer plus one atomic installer, one tool set, one digest".
- Adding the two new tools changes `GENERATION`, and `support_tool` builds its
  input label from the whole-projection generation, so every action that consumes
  any capability artifact re-keys once. Land this before a consumer repo starts
  reading the shared cache and expect one cold run.
- The deleted script's `--check` mode was the fail-closed gate for "raw `buck2`
  in a worktree that never had `mr apply`". mr already exports the replacement
  predicate (`checkCompositionCapabilityProjection`); giving it a CLI surface and
  wiring it into the root `buck2` wrapper is open follow-up work. Under
  [decision 0027](./0027-composed-default-worktrees.md) every worktree has had
  `mr apply`, so this is a guard-rail, not a correctness hole.
- Open, not settled here: whether the capability label should be keyed per tool
  by its own `contentDigest` instead of by whole-projection `GENERATION`, and
  whether the remaining top-level `rust-*`/`archive-tool`/`product` capabilities
  should also move under named authorities.
