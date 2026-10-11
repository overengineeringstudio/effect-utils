# 0040 Required-Edge Transitive Platform Availability

Status: accepted

## Context

[Decision 0022](./0022-lockfile-derived-declared-closure.md) makes the lockfile
resolver context the source of declared dependency trees and requires platform
filtering. A package's own cpu/os/libc gates do not describe the availability of
its complete resolver context: an ungated package may require a gated native
package, including through peer-resolved snapshots, workspace importers, or a
cycle. Treating only the direct package gate as authoritative either rejects a
mixed-platform graph during generation or admits a tree with missing required
dependencies.

Generation must represent all declared configurations without making the
generator host the platform authority. The configured consumer must reject an
unsupported context before materialization. Optional dependencies remain
filterable; required dependencies are obligations, not candidates for pruning.

## Options

| Option                                                                                  | Tradeoff                                                                                                    | Outcome  |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| A: transitive required-edge availability                                                | Compute per-configuration closure availability; retain unsupported targets with selection-time diagnostics  | Accepted |
| B: reject generation whenever a required dependency is unavailable in any configuration | Simple error path, but one unsupported context prevents unrelated supported contexts from being represented | Rejected |
| C: omit unavailable required dependencies as though optional                            | Produces incomplete resolver contexts and a false claim of portability                                      | Rejected |

## Decision

Portability is a property of the complete required resolver context; own package
gates are only initial constraints. Unsupported configurations are representable
and rejected when selected; required obligations are never omitted.

For each of `javascript_portable`, `linux_aarch64`, `linux_x86_64`, and
`macos_aarch64`, seed snapshot availability from own package gates and importer
availability from the complete configuration set. Remove an owner configuration
when any resolved required dependency is unavailable, and propagate removals to
a fixed point. Workspace dependencies use their resolved importer context;
peer-suffixed snapshots retain their exact lockfile identity. Required strongly
connected components survive when all members and external required dependencies
are available; otherwise unavailability propagates through the cycle. The
result is independent of traversal order. `javascript_portable` excludes any
package with cpu, os, or libc restrictions.

Optional edges do not constrain their owners. They are filtered against the
resolved dependency's transitive availability, so an optional package whose
required closure is unavailable is omitted without weakening required-edge
integrity. Missing metadata, unresolved references, missing integrity, and patch
errors still fail generation globally; platform exclusion cannot mask them.

Entries record transitively constrained `platforms`. Each importer view records
its own `platforms`, and entry/view variants cover supported configurations only.
An empty supported set is representable. Restricted entries and views carry
`unavailable_by_platform` with all four configuration keys: an explanatory
reason for unavailable configurations and an empty string for supported ones.
Unrestricted entries and views omit it. Shared Buck rules select this attribute
and reject a nonempty reason at the beginning of implementation, before
registering actions. No consumer-specific platform exception or package-name
allowlist supplies availability.

## Consequences

- A mixed-platform lockfile projects successfully even when some entries or
  views are unsupported; selecting those configurations fails explicitly.
- Supported materializations retain every required edge and the existing
  optional filtering semantics. SCC assembly cannot reintroduce unavailable
  configurations.
- Unrelated supported view bytes and unrestricted target rendering remain
  stable; availability does not introduce a whole-graph identity dependency.
- Hash-pinned fetches, lockfile/sidecar verification, declared patches, and the
  freshness gate remain fail-closed. Availability is not a substitute for
  integrity or metadata validation.
- The normative mechanism belongs to the
  [materialization spec](../04-buck2/04-materialization/spec.md#resolver-context-platform-availability).
  This decision refines the platform-filtering mechanism of decision 0022,
  without changing its dependency authority or materialization ownership.
