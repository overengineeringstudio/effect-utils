# Requirements: npm-release

> `vision.md` for this node is pending human authoring; a draft accompanies the
> introducing PR.

## Verification Contract

- A published release must be verified against what the registry actually serves, not against the exit code of the publish command.
- Verification must cover three independent properties: the version is visible, the served tarball matches the artifact that was packed, and the release's dist-tag resolves to exactly that version.
- The dist-tag property must be checked for the tag the release published under, not a fixed assumption of `latest`.
- Verification must be expressible per package, so a release group can report which member disagreed rather than only that the group failed.

## Outcome Kinds

- Verification outcomes must distinguish _not yet converged_ from _disagrees_, because the two require opposite handling.
- A disagreement that cannot become correct — the registry serving a different artifact under the same version — must be terminal, since a published npm version is immutable.
- A registry state that can still converge — a version not yet visible, or a dist-tag that has not yet moved — must be retryable.
- Every non-`ok` outcome must carry a reason naming the package and the observed versus expected values.

## Portability

- The decision layer must not depend on a network client, filesystem, process runtime, or application framework.
- The decision layer must be usable from consumers on different Effect major versions and from consumers using no Effect at all.
- Runtime-flavoured wrappers may be layered on top, but must not become the only way to reach the decision layer.

## Boundaries

- This system must not perform the publish, hold registry credentials, or sign provenance.
- This system must not choose release versions, dist-tag policy, or release membership.
- Digest comparison must be skipped, not failed, when the caller has no locally packed artifact for a package — the case when a run repairs a partial release and skips packages already published.
