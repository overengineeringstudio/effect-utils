# Decision 0002: Export type proof uses an explicit compiler toolchain

## Status

Accepted

## Context

Package export environment contracts can request `typeProof: 'strict'` to prove
that an export's transitive source closure typechecks under a constrained
JavaScript environment profile.

That proof is heavier than Genie authoring. It also needs TypeScript semantics.
The first implementation path used the TypeScript JavaScript API from the
package-json node validation runtime. That shape works in a source checkout, but
it is the wrong long-term boundary for packaged Genie CLIs:

- downstream `.genie.ts` authoring files should import pure authoring helpers,
  not engine-only validation internals
- compiled Genie binaries should not need staged `node_modules` symlinks to make
  validation-time dependencies resolvable from temporary import roots
- Nix-packaged validation should depend on explicit tool inputs rather than
  ambient package-manager layout
- Genie already treats compilers, formatters, and linters as external tools; the
  export type proof should follow the same shape

Effect-utils already carries a Nix-managed `tsgo` input and its TypeScript task
module defaults check/build tasks to `tsgo`. That makes `tsgo` the default
compiler tool for Genie package export type proofs. JavaScript `tsc` remains
possible only as an explicit compiler override for exceptional consumers; it is
not a fallback default.

## Decision

The package-json node validation runtime will model strict export type proof as
an explicit compiler-tool invocation, not as a dynamic import of the TypeScript
JavaScript API from staged Genie authoring code.

The validation runtime should receive or discover a compiler executable path
owned by the engine environment:

- Nix-packaged Genie should provide a pinned `tsgo` executable
- source-mode development should use `tsgo` from the dev shell or an explicitly
  configured compiler executable
- JavaScript `tsc` is allowed only when a caller deliberately configures it as
  the compiler executable; Genie must not silently discover it as a legacy
  fallback

The pure `@overeng/genie` authoring surface remains free of node-only validation
internals and TypeScript value imports. `exportEntry(...)` only records
non-emitted contract metadata. After generation imports complete, the engine
injects package-json validation and runs strict proofs out-of-band through the
compiler tool.

JSONC parsing for generated config validation should not force the export proof
runtime to import the TypeScript compiler API. If Genie needs JSONC parsing in
the engine, it should use a small explicit parser dependency or an engine-owned
parser capability whose dependency is packaged normally, not a staged authoring
`node_modules` bridge.

## Consequences

- Packaged Genie validation becomes Nix-idiomatic: tool inputs are derivation
  inputs, not package-manager side effects.
- The compiled Genie binary no longer needs a public or semi-public
  `GENIE_STAGED_NODE_MODULES` contract for TypeScript proof.
- Export type proof can reuse the same compiler implementation and diagnostics
  expectations as repository TypeScript tasks.
- The package-json validator keeps ownership of JavaScript environment
  semantics while Genie core remains a generic validation runner.
- Strict proof remains opt-in and cacheable; invoking an external compiler is
  acceptable only for contracts that request `typeProof: 'strict'`.

## Alternatives Considered

- **Dynamic TypeScript JS API import:** rejected as the long-term design because
  it couples validation to JavaScript module resolution and package-manager
  layout. It is useful for prototyping and source-mode experiments, but it is
  brittle for compiled/Nix-packaged CLIs.
- **Staged `node_modules` bridge:** rejected as a public or lasting contract. It
  can make a compiled binary work tactically, but it exposes implementation
  details of temporary import staging instead of expressing the real dependency:
  a compiler tool.
- **Require downstream workspaces to have live `node_modules`:** rejected because
  it makes validation depend on mutable workspace state and weakens reproducible
  Nix/CI behavior.
- **Put export type proof in Genie core:** rejected by Decision 0001. JavaScript
  package export semantics belong to the package-json generator's validation
  runtime, not to the generic generation engine.

## Implementation Notes

The implementation:

1. defines `createNodePackageJsonValidationRuntime(...)` with an optional
   compiler executable path and compiler kind
2. resolves source-mode compilers from `GENIE_EXPORT_TYPE_PROOF_COMPILER`,
   then `tsgo`
3. wires the Nix-packaged Genie wrapper to the flake-pinned
   `effect-tsgo`/`bin/tsgo` executable
4. generates temporary proof tsconfigs under the existing export-validation
   cache directory
5. invokes the compiler with no emit and environment-profile-specific libs,
   types, module resolution, and custom conditions
6. reports compiler output as stable Genie validation issues without importing
   the TypeScript program API for the strict proof
7. keeps cheap import/global graph checks in-process
8. extends the compiled Genie staging regression test so strict export
   validation succeeds through an explicit compiler executable without staged
   `node_modules`
