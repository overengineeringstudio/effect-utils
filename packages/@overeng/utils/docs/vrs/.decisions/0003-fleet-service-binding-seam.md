# `<project>-<role>` service name is built in the public contract; fleet values bind via a typed seam

## Status

accepted

## Context

`@overeng/otel-contract` is a PUBLIC package consumed by private fleet repos. The
conventional resource identity is `service.name = `${project}-${role}``, with the
`project`/`role`/`namespace`/`version` VALUES owned by a private fleet
configuration. The contract needs to (a) build and validate that name through the
same naming law as the rest of the contract, and (b) describe the input shape a
private config supplies — without ever embedding a fleet value in the public repo.

A naive constructor — `Schema.decode(OtelServiceName)(`${project}-${role}`)` —
is silently wrong. `OtelServiceName`'s pattern `^[A-Za-z][A-Za-z0-9_.:-]*$`
admits a TRAILING hyphen, so an empty `role` composes to `"<project>-"` and PASSES
the brand decode, admitting a malformed identity.

## Decision

**Two-layer validation, plain (unbranded) parts, and a public type-seam.**

- `ServiceNameParts` validates `project`/`role` as plain
  `Schema.NonEmptyTrimmedString` — the lightest typing that rejects
  empty/whitespace and closes the trailing-hyphen trap before composition. A
  dedicated `ServiceRole` brand buys nothing the composed decode does not already
  give.
- `ServiceNameFromParts` is a `Schema.transformOrFail(ServiceNameParts,
OtelServiceName, …)`: it joins the validated parts and decodes the joined
  string through the existing `OtelServiceName` brand (leading-letter + charset
  law REUSED, never re-derived). A malformed part is a decode error at the edge,
  like every other contract name. It is decode-only (encode is `Forbidden` — a
  composed name cannot be split back into parts).
- `FleetServiceBinding` is a public TS interface with plain `string` fields
  (`project`, `role`, `namespace`, `version`) — the PRE-validation input shape a
  private fleet config supplies. Fields are intentionally NOT branded: branding
  the seam would defeat the decode-at-the-edge story. This repo owns the TYPE +
  the constructor; the private repo supplies the VALUES. Zero fleet values live
  here.
- `serviceIdentityFromBinding(binding)` assembles a validated `ServiceIdentity`
  from a binding (name via `ServiceNameFromParts`, namespace/version via their
  brands), removing the hand-rolled `Schema.decode(ServiceIdentity)({ name:
`${project}-${role}`, … })` at every composition root.

### Rejected alternatives

- **Brand `project`/`role` (e.g. a `ServiceRole` schema):** rejected. The
  composed decode through `OtelServiceName` already enforces the naming law;
  branding the parts adds a type without adding a rejected input, and complicates
  the seam.
- **Single decode of the joined string:** rejected — the trailing-hyphen trap
  makes an empty role pass. The part-level `NonEmptyTrimmedString` is load-bearing.
- **Put fleet defaults / values behind the seam in this repo:** rejected by the
  public/private boundary — the seam is a SHAPE only.

## Why

The seam keeps the public contract free of fleet identity while giving private
infra one typed, validated entry point. The naming law stays single-sourced in
`OtelServiceName`; the only new validation is the part-level non-empty check that
the composed brand cannot express on its own.

## Consequences

- Private composition roots (service / CLI binaries) bind a `FleetServiceBinding`
  and call `serviceIdentityFromBinding`, instead of hand-joining the name.
- A trailing-hyphen / empty-part identity is now a decode error at the edge,
  proven by `otel-contract` unit tests using neutral example values.
