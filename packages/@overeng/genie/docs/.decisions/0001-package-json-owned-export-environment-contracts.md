# Decision 0001: Package-json-owned export environment contracts

## Status

Accepted

## Context

Package exports are the boundary consumers import from, but package.json alone
does not say which JavaScript environment each entry is intended to support.
This matters for constrained entries such as pure/isomorphic builders,
Cloudflare Workers/workerd, browser, Web Worker, React Native, Node, and Bun.

The first concrete failure mode is `@overeng/genie`'s `.` entry: typechecking
consumers should be able to import the pure builders and types without adding
Node, Bun, or DOM ambient globals. A one-off unit test can guard that entry, but
it does not establish a reusable package boundary contract.

## Decision

The package-json generator owns export environment contracts.

Authors declare the contract next to the export target with `exportEntry(...)`.
The emitted package.json remains ordinary package.json; Genie stores the
contract only in non-emitted package-json metadata.

Genie core remains a generic validation runner. It exposes only an opaque
validation extension registry. The package-json domain defines and consumes its
own validation runtime from `validation.packageJson`; JavaScript export
environment concepts do not become core `GenieContext` concepts.

## Consequences

- The authoring surface stays close to the package boundary being validated.
- The pure `@overeng/genie` runtime does not value-import TypeScript or node-only
  validation helpers.
- Other domains can use the same opaque validation extension pattern without
  forcing their schema into core.
- Package-json can still run strict node-side checks during normal Genie
  validation when the engine injects the package-json runtime.

## Alternatives Considered

- **Core JavaScript validator capability:** rejected because it would make Genie
  core own JavaScript environment semantics.
- **Standalone unit tests per export:** rejected as the primary design because
  it does not scale across packages or keep the contract with `exports`.
- **Separate `$genie.exportContracts` authoring object:** rejected for the first
  API because it separates the contract from the export target and invites drift.
