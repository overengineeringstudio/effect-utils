# Component Identity Requirements

This subsystem owns cross-language component version semantics and refines BUILD-R01.
Consumer profiles select the source stamp policy and add deployment extensions.

## Assumptions

- **BUILD.ID-A01 Manifest authority:** Package/product manifests supply base versions.
- **BUILD.ID-A02 Independent closure:** Each product declares its source closure.

## Acceptable Tradeoffs

- **BUILD.ID-T01 Language-specific transport:** Helpers may differ by language
  while fields and output semantics remain identical.

## Requirements

- **BUILD.ID-R01 Canonical fields (refines BUILD-R01):** Components expose aligned
  baseVersion, rev, dirty, sourceKind, commitTs and optional impure buildTs semantics.
- **BUILD.ID-R02 Stable machine output:** machineVersion is parseable and stable;
  telemetry and structured diagnostics contain no prose or relative time.
- **BUILD.ID-R03 Consistent display:** CLI, UI, logs and error surfaces derive
  displayVersion from the same identity as machineVersion.
- **BUILD.ID-R04 Separate identities:** Source revision, action key, payload digest,
  exact Nix closure, deployment identity and invocation identity remain distinct.
- **BUILD.ID-R05 Closure revision:** A profile selecting C stamps a product with
  the last Git commit touching its declared source closure; unrelated commits do
  not alter the stamp, and relevant changes cannot retain a stale stamp.
- **BUILD.ID-R06 Refresh and freshness:** C profiles commit generated product-rev
  refreshes inside affected PRs and reject stale projections before landing.
- **BUILD.ID-R07 Reachable stamps:** Landing preserves the ancestry of stamped
  commits; a rewritten/orphaned stamp cannot pass the freshness gate.
