# pnpm package materializer prototype

Status: completed model proof; Buck action integration and target admission
remain open

## Question

Can the existing Genie-owned TypeScript request and pnpm-lock authority chain
produce verified normalized package identities without copying dependency
facts or reading ambient `node_modules`, while preserving exact reachable and
unreachable invalidation?

## Method

The prototype added a pure TypeScript npm-archive normalizer behind the
existing `@overeng/buck2-tools` closure compiler. It verifies the lockfile
SHA-512 SRI before archive parsing, requires the canonical npm `package/` root,
normalizes regular-file modes, hashes the normalized file manifest, and fails
closed on unsafe paths, duplicate members, links, and special entries. A
second pure join discovers the exact contextual plan, requires exactly one
archive input per selected path, and passes only verified payload receipts to
the pre-existing authoritative closure compiler.

The retained unit controls use in-memory gzip tar archives. They run without
reading a pnpm store or `node_modules`. A real-corpus probe downloaded the
resolver-selected `typescript@6.0.3` archive directly from the public npm
registry and supplied the exact SRI from this repository's lockfile. The
downloaded archive was disposable and is not checked in.

The package-local `tui-core` Genie projection was extended with a 59-entry
package-policy supplement keyed by the exact contextual paths already present
in the input plan. Source resolution remains represented only once in the plan;
the supplement carries only materializer ABI and package-local build-policy
digest. It contains no copied version selection or dependency declaration.

## Result

| Control                                               | Result                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Baseline synthetic closure                            | GREEN                                                                  |
| Unreachable archive, integrity, and lock mutation     | GREEN; `TaskClosureId` byte-stable                                     |
| Reachable child archive, integrity, and lock mutation | GREEN; `TaskClosureId` changed                                         |
| Missing selected archive receipt                      | RED before identity minting                                            |
| Missing selected dependency snapshot edge             | RED during exact traversal                                             |
| Corrupted archive under unchanged lock SRI            | RED before archive parsing                                             |
| Ambient `node_modules` use by model                   | absent                                                                 |
| `typescript@6.0.3` real archive                       | GREEN; 4,515,854 archive bytes, 140 files, 24,346,827 normalized bytes |

The real archive produced normalized digest
`sha256:80c04a4da49d77e9754fa36051b28fac03791efb3e625b765e4d61cdfbf6d612`.
Ten warm in-process samples after one unreported warmup measured 435.34 ms
minimum, 507.16 ms p50, and 804.09 ms p95 on the shared Linux host. This is a
TypeScript prototype cost for a large 4.5 MB compressed package, not a Buck
action or cross-engine benchmark.

The latest retained focused gate ran 18 tests across the existing closure
compiler and new materializer in 569 ms. Strict TypeScript checking passed. Full Genie
generation updated only the intended `tui-core` plan, but its direct invocation
reported no verdict because `tsgo` was absent from that process's PATH; the
normal repository task remains the authoritative freshness gate.

The controls prove the normalized identity model and the request-authority
chain. They do not prove Buck fetch actions, a materialized directory provider,
remote caching, install/build scripts, patches, link semantics, native optional
packages, or a TypeScript compiler action. The target remains explicitly
non-authoritative.

## Conclusion

Retain the model and make the next implementation slice a generated Buck
package-download target plus one normalization action per distinct package
content/policy tuple. Do not feed the whole lockfile or aggregate plan into
each action. The closure-compile action should consume only selected verified
receipts, and the eventual TypeScript action should consume only the resulting
closure projection and explicit workspace providers.

Before admission, exercise the real reachable 59-package corpus, classify
archive links and install/build-script packages, compare the normalized result
against pnpm's reference package files, and run the mutation controls through
the actual consuming Buck action.

## VRS Impact

The Buck dependency-closure spec now defines the registry package
materialization and normalization boundary, package-local policy identity,
exact receipt join, fail-closed archive subset, and the continuing block on
`tui-core` authority. No requirement or shared product-contract change is
needed.
