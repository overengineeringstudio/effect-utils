# Vision: npm-release

## The Problem

1. **Problem 1: Publishing reports success before the release is live.** `npm publish` exiting zero means the request was accepted, not that the registry serves the release. A version can be unpropagated, the served tarball can differ from the one that was packed, and the dist-tag can still resolve to the previous version — so installs keep getting the old release. None of these fail the publish command.
2. **Problem 2: Every publisher re-implements publication, and the copies drift.** Dependency rewriting, packing, idempotent publishing, and post-publish checking are rebuilt per repository. Each copy covers a different subset of the correctness properties, so a property present in one is silently absent in another, and fixing one does not fix the rest.
3. **Problem 3: A partial publication has no defined recovery.** Publishing a package group is not atomic. An interrupted run leaves some packages live and some not, with dist-tags possibly half-moved. Recovery is manual, differs per repository, and risks publishing a different artifact under a version that already exists.
4. **Problem 4: Noticing a broken release does not repair it.** When drift is detected, the correction — moving a dist-tag, publishing a missing member — lives outside the tool that detected it, so an operator performs it by hand, under time pressure, against production.

## The Vision

- A release is a **target state, not a transaction**: the system converges the registry toward the plan it was given, so an interrupted run is resumed by running it again (Problem 3).
- Publication is complete only when the registry **demonstrably serves the intended state** — the version, the artifact bytes that were packed, and a dist-tag resolving to them (Problem 1).
- **One implementation of npm publication semantics serves every publisher**, so a correctness property is gained once rather than per repository (Problem 2).
- Where npm permits it, the system **corrects what it detects** instead of handing the operator a diagnosis (Problem 4).
- Disagreements the registry can still resolve are **distinguished from those it never will**, because the two demand opposite responses (Problems 1, 3).
- **Every operation is safe to repeat**, so recovery needs no special mode and no operator judgement about what already happened (Problem 3).
- The **judgement** about whether a release is correct is separable from performing it, so it can be verified exhaustively without a registry (Problem 2).

## What This Is Not

- **Not a decider of releases.** Versions, changelogs, git tags, GitHub Releases, and which packages belong to a release are the caller's; this system receives a plan and makes the registry match it.
- **Not a registry abstraction.** The model is npm's specifically — immutable versions, mutable dist-tags, SRI digests. Another registry is a sibling system, not an extension of this one.
- **Not a credential store.** Authentication is supplied at the process edge and never held, persisted, or brokered here.
- **Not a rollback mechanism.** npm's unpublish policy makes a published version permanent in practice; correction means moving forward, never undoing.
- **Not a monitoring system.** It answers at release time; it does not watch registries over time.
- **Not a general-purpose npm client.**

## Success Criteria

1. Re-running a completed release against the same plan performs no writes and reports success.
2. Re-running an interrupted release completes it, with no operator intervention and no distinct recovery mode.
3. A release whose dist-tag did not move to the published version is detected and corrected within a single run.
4. A registry serving a different artifact than the one packed fails the release immediately, without retry.
5. Dependency rewriting, provenance, digest agreement, and dist-tag agreement hold identically for every publisher, verifiable from one test suite.
6. The verdict logic is exercised exhaustively without network access or a registry.
7. Adding a publisher requires supplying a plan and credentials — never re-implementing publication semantics.
