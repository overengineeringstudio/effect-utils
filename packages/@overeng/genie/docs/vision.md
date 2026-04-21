# Vision: Genie

## The Problem

### Problem 1: Repository configuration formats are too weak for the job

Modern repositories depend on a large amount of configuration: package
manifests, TypeScript config, linter and formatter config, CI workflows, and
more. Those formats are usually static data formats with only limited reuse
mechanisms. Compared to real programming languages, they are missing basic
tools such as single-source-of-truth definitions, principled abstraction,
shared helpers, and comments in the places where teams actually need to explain
why something exists.

### Problem 2: Partial extension systems add complexity instead of solving composition

Some configuration ecosystems add narrow escape hatches such as `extends`,
includes, merges, or inheritance. These features help locally but do not give
one coherent model for composing configuration across files, packages, and
repositories. The result is still fragmented logic, hidden coupling, and
another layer of format-specific complexity that teams have to learn and debug.

### Problem 3: Repository configuration needs the power of code without giving up the real artifacts

Teams need to express repository intent once, in a clean and reusable form,
while still producing the actual files that existing tools consume. Without
that split, configuration either stays trapped in weak static formats or moves
into ad hoc templating systems that are hard to validate, hard to share, and
hard to trust.

### Problem 4: Invalid or drifting configuration is usually detected too late

Many configuration mistakes are only discovered when the downstream tool reads
the file at runtime or in CI. That pushes feedback too far away from the source
of truth. Repository configuration needs earlier validation, clearer errors, and
generated artifacts whose diffs carry signal rather than noise.

### Problem 5: Shared configuration logic should scale across repositories

Real repository stacks reuse the same conventions across many packages and
often across many repositories. Copy-pasting config logic between repos creates
drift immediately. Shared configuration logic must be reusable across repo
boundaries without forcing each consumer to reimplement the same rules in its
own local configuration files.

## The Vision

- **Configuration is first-class code.** Repository intent is authored in a
  real programming language instead of being fragmented across weak static
  config formats.
- **One clean source of truth drives many concrete artifacts.** Teams define
  shared facts, rules, and conventions once, then generate the concrete config
  files that tools expect.
- **Repository configuration is reusable and explainable.** Shared logic,
  constants, comments, and helper functions can be composed cleanly within a
  repo and across repos.
- **Each config domain has a typed, constrained authoring model.** Instead of
  writing arbitrary text templates, teams use domain-specific generators that
  guide what is valid and catch problems during generation.
- **Generated artifacts remain simple, boring, and tool-compatible.** The value
  lives in the source model and validation, while the emitted files stay as the
  standard artifacts consumed by package managers, compilers, linters, and CI
  systems.

## What This Is Not

- Not a general-purpose build system or task runner. Genie defines and renders
  generated artifacts; it does not own the full repository workflow.
- Not a replacement for package managers, compilers, formatters, or CI systems.
  It generates inputs for those tools rather than reimplementing them.
- Not a free-form templating engine. Its value is principled configuration as
  code with typed domain-specific generators, not arbitrary text expansion.
- Not an argument that every repository artifact should become programmable.
  Genie exists for configuration that benefits from reuse, composition, and
  validation, not for generating files with no meaningful structure.

## Success Criteria

1. Common repository artifacts such as manifests, TypeScript configs, linter
   configs, and CI workflows can be defined from one coherent source model
   rather than a mix of hand-maintained conventions.
2. Shared configuration facts and rules can be defined once and reused across
   multiple generated artifacts without duplication.
3. Configuration authors can express intent with normal code-level tools such
   as reuse, abstraction, comments, and typed composition.
4. Domain-specific generators catch invalid or inconsistent configuration before
   downstream tools consume the emitted files.
5. Repositories and downstream consumers can share configuration logic across
   repo boundaries without vendoring or copy-pasting that logic locally.
