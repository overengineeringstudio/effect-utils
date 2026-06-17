# Fleet service binding seam

## Status

accepted

## Context

`@overeng/otel-contract` is public, while concrete fleet identity values are
private. The public package still needs to define how a private config supplies
`project`, `role`, `namespace`, and `version`, and how those values are validated.

A single decode of `` `${project}-${role}` `` through `OtelServiceName` is
insufficient because the name pattern permits a trailing hyphen; an empty role
would compose to a valid but malformed service name.

## Decision

- `ServiceNameParts` validates `project` and `role` as non-empty trimmed strings
  before composition.
- `ServiceNameFromParts` joins those parts and decodes the result through the
  existing `OtelServiceName` brand. Encoding is forbidden because the composed
  name cannot be split losslessly.
- `FleetServiceBinding` is a public plain-string TypeScript interface for the
  pre-validation shape supplied by private config.
- `serviceIdentityFromBinding` validates name, namespace, and version and returns
  a branded `ServiceIdentity`.

## Consequences

- The public repo contains the seam shape and constructor, not private values.
- Private composition roots stop hand-joining service names.
- Empty-part and trailing-hyphen identities fail at the edge.
