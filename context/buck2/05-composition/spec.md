# Composition Spec

This document specifies the composition root and its generation. It builds on
[requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** the composition root shape and the standalone variant.

**Does not define:** member semantics (01), platforms (02), or cache wiring
(04).

## Composition Root Shape

The genie-projected root `.buckconfig` (prototype-validated shape):

```ini
[cells]
  <root-repo> = .
  prelude = prelude
  toolchains = toolchains
  none = none
  <member-cell> = repos/<member>       # one line per member, canonical name+path
[cell_aliases]
  root = <root-repo>
  config = prelude
  ovr_config = prelude
  fbcode = none
  fbsource = none
  fbcode_macros = none
  buck = none
[external_cells]
  prelude = bundled
[parser]
  target_platform_detector_spec = target:<root>//...-><hub>//platforms:default \
                                  target:<member-cell>//...-><hub>//platforms:default
[build]
  execution_platforms = <hub>//platforms:default
```

plus empty `none/BUCK` and `toolchains/BUCK`, one `.buckroot` at the root, and
the cache client section (04). The detector spec lists every cell explicitly
(COMP-R04). The hub cell for platforms is effect-utils (COMP-R05).

## Standalone Variant

A single-member build uses the same file with the member-b cells absent: the
member still mounts at `repos/<name>` under its canonical cell name, and the
platform labels are byte-identical. This is what makes standalone and composed
builds share one cache namespace — proven at the action-digest level in the
retained experiment.

## Invariants Worth Restating

- The root cell's own name does not enter member action identity; member mount
  path, member cell name, platform label, and isolation dir do.
- Presence of additional members or targets does not perturb an unrelated
  member's digests.
- A member's own `.buckconfig` is not consulted for cells inside a
  composition; its `[cell_aliases]` must simply not conflict (COMP-R03).
- Cross-cell `load()` of member-owned rules works; shared rules stay free of
  private facts (BUCK-R14).
