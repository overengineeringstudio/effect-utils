# Vision: Genie

## The Problem

### Problem 1: Repository configuration drifts when source and artifact are both editable

Files such as `package.json`, `tsconfig.json`, formatter configs, and GitHub
workflows are high-churn configuration artifacts. When teams edit both the
source intent and the rendered artifact directly, repositories accumulate
formatting noise, inconsistent conventions, and silent divergence between the
declared model and the file that tooling actually consumes.

### Problem 2: Cross-file configuration logic is duplicated instead of composed

Repository configuration has real structure: package manifests need shared
catalog data, workspace graphs need to agree with package metadata, CI
workflows need to share conventions, and generated paths must line up across
packages and repositories. Hand-authored files force the same logic to be
re-expressed repeatedly in incompatible formats instead of being composed once
as code.

### Problem 3: JS-native generators are fragile in the bootstrap path

If the generator itself depends on `pnpm install`, it cannot reliably generate
the very files that define the install. Fresh checkouts, CI bootstrapping, and
megarepo composition all expose this chicken-and-egg failure mode. The system
needs a generator that is available before the JavaScript dependency graph has
been materialized.

### Problem 4: Generated config is only useful if drift and failures are obvious

A code generator that silently rewrites files, hides root causes, or produces
non-deterministic output makes CI and local iteration less trustworthy. Teams
need generated configuration to be strict enough for CI, diagnosable enough for
interactive work, and deterministic enough that diffs carry signal.

### Problem 5: Cross-repo composition should not force copy-paste configuration

In the megarepo stack, downstream repos need to reuse shared generators and
shared config logic from upstream members such as `effect-utils`. That reuse
must work against the lock-pinned local development topology rather than
forcing every consumer to vendor or duplicate the same generator code.

## The Vision

- **One authoritative source per generated artifact.** Repository config is
  defined in colocated `.genie.ts` sources, while generated artifacts are
  treated as derived outputs.
- **Configuration is composed as code, not duplicated as text.** Shared package
  metadata, workspace rules, CI helpers, and formatting conventions are reused
  mechanically through typed runtime factories.
- **Genie is bootstrap-safe.** The generator is available as a native CLI
  before `pnpm install`, so fresh checkouts, CI, and megarepo workflows can
  rely on it without circular setup steps.
- **Generated output is deterministic and strict.** The same inputs produce the
  same outputs, drift is caught in `--check`, and failures surface clear
  root-cause information.
- **Cross-repo reuse is first-class.** Downstream repos can import shared
  generator logic from lock-pinned megarepo members and iterate locally without
  copy-pasting that logic into each consuming repo.

## What This Is Not

- Not a general-purpose build system or task runner. Genie defines and renders
  generated artifacts; it does not own the full repository workflow.
- Not a replacement for package managers, TypeScript, formatters, or GitHub
  Actions. It generates inputs for those tools rather than reimplementing them.
- Not a free-form templating engine. Its value is principled, typed composition
  of repository configuration, not arbitrary text expansion.

## Success Criteria

1. A fresh checkout can run Genie before `pnpm install` and before any
   generator-produced artifact has been materialized.
2. `genie --check` fails on any generated drift and passes when artifacts match
   their `.genie.ts` sources.
3. Downstream repos can reuse shared generator logic from lock-pinned
   megarepo members without vendoring that logic locally.
4. Re-running Genie without source changes produces no artifact changes.
5. Common repository artifacts such as manifests, TypeScript configs, linter
   configs, and CI workflows are generated through one coherent model rather
   than a mix of hand-maintained conventions.
