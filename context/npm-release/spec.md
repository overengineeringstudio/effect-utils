# Spec: npm-release

Implemented by `@overeng/npm-release`. Constrained by [requirements.md](./requirements.md).

## Shape

The package exports pure functions and types. It performs no IO: callers read registry state however they already can (an `npm view` invocation, a registry HTTP client) and hand plain data in.

```
RemoteRegistryState  what the registry currently serves for one package version
RegistryVerification ok | pending | mismatch
registryVerification (input) -> RegistryVerification
```

## Checks and precedence

`registryVerification` evaluates in a fixed order, returning the first disagreement:

| #   | Check                                             | Outcome when it disagrees                                  |
| --- | ------------------------------------------------- | ---------------------------------------------------------- |
| 1   | version visible on the registry                   | `pending` — not propagated, or the publish silently failed |
| 2   | served version equals published version           | `mismatch`                                                 |
| 3   | `dist.integrity` equals the locally packed digest | `mismatch`                                                 |
| 4   | dist-tag exists                                   | `pending`                                                  |
| 5   | dist-tag resolves to the published version        | `pending`                                                  |

Order matters: an absent version makes every later check meaningless, so it is reported first rather than surfacing a confusing dist-tag complaint about a version that was never published.

## Why the dist-tag checks are `pending`

Checks 4 and 5 describe a mutable pointer that legitimately lags the immutable version during propagation. Reporting them as `mismatch` would fail releases on ordinary lag. Reporting them as `pending` lets the caller's retry budget decide: transient lag resolves, a tag that never moves exhausts the budget and fails. This is the failure mode where a publish succeeds but `npm install` keeps serving the previous release.

## Why the digest check is `mismatch`

A published npm version is immutable. If the registry serves a different tarball under the version we just published, no amount of waiting changes it — the release needs a human. Retrying here would convert a clear, immediate failure into a multi-minute silence.

## Digest comparison is conditional

The comparison runs only when both a local digest and a remote integrity are known. A caller repairing a partial release skips packages already on the registry and therefore has no local artifact for them; those packages are still version- and dist-tag-verified. Callers that need the stronger guarantee must pack every package.

## Retry policy is the caller's

The package classifies; it does not schedule. Retrying `pending`, bounding that retry, and turning an exhausted budget into a failure all belong to the caller, which owns the runtime and knows the release's time budget.

## Provenance

`shouldPublishWithProvenance` decides whether `npm publish --provenance` applies: only outside a dry run and only on a CI provider that can mint the OIDC identity provenance is derived from. It is a predicate, not a publisher — the caller assembles its own argv.
